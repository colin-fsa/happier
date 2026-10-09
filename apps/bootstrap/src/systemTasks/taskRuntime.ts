import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runCommandCapture as runProcessCommandCapture } from '@happier-dev/cli-common/process';

export interface CommandExecutionResult {
  status: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
}

export class CommandTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`);
    this.name = 'CommandTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The ring names a caller may send. `normalizeBootstrapChannel` maps everything else to `stable`,
 * so every parser that accepts a caller-supplied channel checks it against this list first and
 * names it in the failure — a typo'd ring otherwise silently reads or starts the wrong CLI.
 */
export const ACCEPTED_BOOTSTRAP_CHANNELS: readonly string[] = ['stable', 'preview', 'dev', 'publicdev'];

export function normalizeBootstrapChannel(raw: unknown): Readonly<{
  commandChannel: 'stable' | 'preview' | 'dev';
  releaseChannel: 'stable' | 'preview' | 'publicdev';
}> {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'preview') {
    return { commandChannel: 'preview', releaseChannel: 'preview' };
  }
  if (text === 'dev' || text === 'publicdev') {
    return { commandChannel: 'dev', releaseChannel: 'publicdev' };
  }
  return { commandChannel: 'stable', releaseChannel: 'stable' };
}

/**
 * Bootstrap's contract over the process owner's `runCommandCapture`: resolves
 * `{ status, stdout, stderr }` (a signal-terminated child reports status 1 plus its signal),
 * rejects with `CommandTimeoutError` after `timeoutMs` (default 60 s, zero delegates the deadline), and rejects
 * with the spawn error when the command cannot start.
 */
export async function runCommandCapture(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<CommandExecutionResult> {
  const timeoutMs = params.timeoutMs === 0 ? 0
    : Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs as number)) : 60_000;
  // A Windows command shim (an npm `happier.cmd`) cannot be spawned directly; the process owner's
  // invocation runs it through cmd.exe and is a no-op for everything else and on other platforms.
  const result = await runProcessCommandCapture({
    cmd: params.command,
    args: params.args,
    env: params.env,
    timeoutMs,
    signal: params.signal,
    resolveCommandOnPath: false,
  });
  if (result.kind === 'timed-out') throw new CommandTimeoutError(params.command, timeoutMs);
  if (result.kind === 'aborted') throw result.error;
  if (result.kind === 'spawn-failed') throw result.error;
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    ...(result.signal ? { signal: result.signal } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function parseFirstJsonObject(text: string): unknown {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveDefaultKnownHostsPath(): string {
  return `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.happier/ssh/known_hosts`;
}

export function extractSshHost(target: string): string {
  const trimmed = String(target ?? '').trim();
  const atIndex = trimmed.lastIndexOf('@');
  return atIndex >= 0 ? trimmed.slice(atIndex + 1) : trimmed;
}

export function computeSshFingerprintFromKnownHostsLine(line: string): string {
  const parts = String(line ?? '').trim().split(/\s+/);
  const encoded = parts[2] ?? '';
  const digest = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/g, '');
  return `SHA256:${digest}`;
}

export async function ensureKnownHostsEntry(params: Readonly<{
  path: string;
  hostKeyLine: string;
}>): Promise<void> {
  const path = String(params.path ?? '').trim();
  const hostKeyLine = String(params.hostKeyLine ?? '').trim();
  if (!path || !hostKeyLine) return;
  const existing = await readFile(path, 'utf8').catch(() => '');
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(hostKeyLine)) {
    return;
  }

  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slashIndex > 0) {
    await mkdir(path.slice(0, slashIndex), { recursive: true });
  }
  await writeFile(path, `${[...lines, hostKeyLine, ''].join('\n')}`, 'utf8');
}
