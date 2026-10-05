import { chmod, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';
import { buildMissingJavaScriptRuntimeMessage } from '@/runtime/js/buildMissingJavaScriptRuntimeMessage';
import { isBun } from '@/utils/runtime';
import { logger } from '@/ui/logger';
import { delay, delayUnrefAbortable } from '@/utils/time';
import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv';

export type TerminalSpawn = Readonly<{
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  launchSpecPath?: string;
  cleanupUnreadArtifacts?: () => Promise<void>;
  /** One-shot native OS spawn proof for terminal-server launches without an IPC parent. */
  awaitNativeSpawnResult?: (deadline: number, pollIntervalMs?: number, signal?: AbortSignal) => Promise<'spawned' | 'failed' | 'unknown'>;
}>;

export type PreparedTerminalSpawn = TerminalSpawn & Readonly<{
  launchSpecPath: string;
  cleanupUnreadArtifacts: () => Promise<void>;
}>;

export type TerminalLaunchSpec = Readonly<{
  command: string;
  args: readonly string[];
  windowsVerbatimArguments?: boolean;
  inheritStderr?: boolean;
  cwd: string;
  env: Readonly<Record<string, string>>;
  envPassthroughKeys?: readonly string[];
  cleanupPaths?: readonly string[];
  diagnostics?: Readonly<{ sessionId: string; logsDir: string; sessionExitDir: string; spawnResultPath?: string }>;
}>;

function nativeSpawnResultPath(launchSpecPath: string): string {
  return join(dirname(launchSpecPath), 'native-startup.json');
}

async function removeNativeSpawnResult(launchSpecPath: string): Promise<void> {
  try { await unlink(nativeSpawnResultPath(launchSpecPath)); } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export async function writeTerminalLaunchSpec(spec: TerminalLaunchSpec, options?: Readonly<{ reportNativeSpawn: true }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
  const path = join(dir, 'launch.json');
  try {
    if (options && !spec.diagnostics) throw new Error('Terminal startup reporting requires launch diagnostics');
    const diagnostics = options && spec.diagnostics
      ? { ...spec.diagnostics, spawnResultPath: nativeSpawnResultPath(path) }
      : spec.diagnostics;
    if (options) await writeFile(nativeSpawnResultPath(path), JSON.stringify({ status: 'pending' }), { mode: 0o600 });
    await writeFile(path, JSON.stringify({ ...spec, ...(diagnostics ? { diagnostics } : {}) }), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return path;
  } catch (error) {
    try {
      await createUnreadTerminalArtifactsCleanup({ launchSpecPath: path,
        ...(options ? { cleanup: () => removeNativeSpawnResult(path) } : {}),
      })();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Terminal launch preparation failed with incomplete cleanup', { cause: error });
    }
    throw error;
  }
}

export function createUnreadTerminalArtifactsCleanup(params: Readonly<{
  launchSpecPath: string;
  cleanup?: () => Promise<void>;
}>): () => Promise<void> {
  let cleanup: Promise<void> | null = null;
  return () => {
    if (cleanup) return cleanup;
    const attempt = (async () => {
      const failures: unknown[] = [];
      const remove = async (operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
          failures.push(error);
        }
      };
      await remove(() => unlink(params.launchSpecPath));
      // A readiness receipt may share this private directory. Retire owned companions
      // before removing their directory, without skipping later cleanup after a failure.
      if (params.cleanup) {
        try { await params.cleanup(); } catch (error) { failures.push(error); }
      }
      const dir = dirname(params.launchSpecPath);
      if (basename(dir).startsWith('happier-terminal-launch-')) await remove(() => rmdir(dir));
      if (failures.length > 0) {
        logger.infoFile('[terminal] Launch artifact cleanup incomplete (terminal_launch_cleanup_incomplete)');
        throw new AggregateError(failures, 'Terminal launch artifact cleanup incomplete');
      }
    })();
    cleanup = attempt;
    void attempt.catch(() => { if (cleanup === attempt) cleanup = null; });
    return attempt;
  };
}

/** Keep the exact child environment in the process boundary, never in the one-shot file. */
export async function prepareOwnedTerminalSpawn(params: Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  diagnostics?: TerminalLaunchSpec['diagnostics'];
  reportNativeSpawn?: boolean;
}>): Promise<PreparedTerminalSpawn> {
  const runtime = await ensureJavaScriptRuntimeExecutable({ isBunRuntime: isBun(), processEnv: params.env });
  if (!runtime) throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Owned terminal launcher'));
  const env = Object.fromEntries(Object.entries(stripNestedSessionDetectionEnv(params.env))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const invocation = resolveWindowsCommandInvocation({ command: params.command, args: [...params.args], env, resolveCommandOnPath: false });
  const launchSpecPath = await writeTerminalLaunchSpec({
    command: invocation.command,
    args: invocation.args,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    cwd: params.cwd,
    env: {},
    inheritStderr: true,
    envPassthroughKeys: Object.keys(env),
    ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
  }, params.reportNativeSpawn ? { reportNativeSpawn: true } : undefined);
  return {
    spawnArgv: [runtime, resolveCliRuntimeAssetPath('scripts', 'terminal_launch_spec_runner.cjs'), launchSpecPath],
    spawnEnv: env,
    launchSpecPath,
    cleanupUnreadArtifacts: createUnreadTerminalArtifactsCleanup({ launchSpecPath,
      ...(params.reportNativeSpawn ? { cleanup: () => removeNativeSpawnResult(launchSpecPath) } : {}),
    }),
    ...(params.reportNativeSpawn ? { awaitNativeSpawnResult: async (deadline: number, pollIntervalMs = 100, signal?: AbortSignal) => {
      for (;;) {
        if (signal?.aborted) return 'unknown' as const;
        let result: unknown;
        try { result = JSON.parse(await readFile(nativeSpawnResultPath(launchSpecPath), 'utf8')); } catch { return 'unknown' as const; }
        if (!result || typeof result !== 'object' || !('status' in result)) return 'unknown' as const;
        if (result.status === 'spawned' || result.status === 'failed') return result.status;
        if (result.status !== 'pending' || Date.now() >= deadline) return 'unknown' as const;
        const waitMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
        if (signal) await delayUnrefAbortable(waitMs, signal);
        else await delay(waitMs);
      }
    } } : {}),
  };
}
