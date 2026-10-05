import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { TerminalHostCreationError } from '@/integrations/terminalHost/errors';

function ignoreMissingFile(error: unknown): void {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
}

/** Herdr injects HERDR_ENV after its pane env overlay; launch the provider in the
 * existing terminal runner so Happier, not Herdr's provider hooks, owns resume. */
export async function createHerdrLaunchSpec(input: Readonly<{
  workingDirectory: string;
  spawnArgv: readonly string[];
  spawnEnv: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
}>): Promise<Readonly<{
  argv: readonly string[];
  specPath: string;
  discard: () => Promise<void>;
}>> {
  const [command, ...args] = input.spawnArgv;
  if (!command) throw new Error('Herdr terminal launch requires a command');
  const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
    isBunRuntime: isBun(),
    targetLabel: 'Herdr terminal launch',
  });
  const excluded = new Set([...(input.unsetEnvKeys ?? []), 'HERDR_ENV']);
  const env = Object.fromEntries(Object.entries(input.spawnEnv).filter(([key]) => !excluded.has(key)));
  const dir = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
  const specPath = join(dir, 'launch.json');
  const discard = async () => {
    await unlink(specPath).catch(ignoreMissingFile);
    await rmdir(dir).catch(ignoreMissingFile);
  };
  try {
    await writeFile(specPath, JSON.stringify({
      command,
      args,
      cwd: input.workingDirectory,
      env,
      envPassthroughKeys: [
        'TERM',
        'COLORTERM',
        'TERM_PROGRAM',
        'TERM_PROGRAM_VERSION',
        // Herdr adds these after applying the caller-provided pane environment.
        // Preserve them for the managed Happier runner; startup consumes the
        // pane identity, then removes HERDR_ENV before launching provider tools
        // so their native hooks cannot claim the pane or replace resume_argv.
        'HERDR_ENV',
        'HERDR_SOCKET_PATH',
        'HERDR_BIN_PATH',
        'HERDR_WORKSPACE_ID',
        'HERDR_TAB_ID',
        'HERDR_PANE_ID',
      ],
    }), { mode: 0o600 });
  } catch (error) {
    try {
      await discard();
    } catch (cleanupError) {
      throw new TerminalHostCreationError([error, cleanupError], {
        launchDisposition: 'not_started', cleanupIncomplete: true,
      }, 'Herdr launch handoff creation and cleanup failed');
    }
    throw error;
  }
  return {
    argv: [runtimeExecutable, resolveCliRuntimeAssetPath('scripts', 'terminal_launch_spec_runner.cjs'), specPath],
    specPath,
    discard,
  };
}
