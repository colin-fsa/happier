import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// The file logger is an external output boundary; artifact cleanup remains real filesystem IO.
vi.mock('@/ui/logger', () => ({ logger: { infoFile: vi.fn() } }));

import { logger } from '@/ui/logger';
import { createUnreadTerminalArtifactsCleanup, prepareOwnedTerminalSpawn } from './terminalLaunchSpec';
import { launchOwnedTerminalProcess } from './ownedTerminalProcess';

describe('unread terminal launch artifacts', () => {
  it('does not pass managed Herdr hook authority to an owned native provider process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-native-env-'));
    const output = join(directory, 'native-env.json');
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({hook:process.env.HERDR_ENV,socket:process.env.HERDR_SOCKET_PATH,exact:process.env.SYNTHETIC_EXACT_SERVER}));`],
      cwd: directory, env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: directory,
        HERDR_ENV: '1', HERDR_SOCKET_PATH: 'synthetic-socket', SYNTHETIC_EXACT_SERVER: 'synthetic-endpoint' } });
    try {
      const child = await launchOwnedTerminalProcess({ spawn: prepared, cwd: directory });
      expect((await child.whenExited).code).toBe(0);
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ socket: 'synthetic-socket', exact: 'synthetic-endpoint' });
    } finally {
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('cancels an obsolete pending receipt wait without claiming native exit or discarding its evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-pending-native-'));
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath, args: [], cwd: directory,
      env: process.env, reportNativeSpawn: true,
      diagnostics: { sessionId: 'pending-native', logsDir: directory, sessionExitDir: directory } });
    const receipt = join(dirname(prepared.launchSpecPath!), 'native-startup.json');
    const controller = new AbortController();
    let result: unknown;
    const waiting = prepared.awaitNativeSpawnResult!(Date.now() + 60_000, 50, controller.signal);
    void waiting.then(value => { result = value; });
    try {
      controller.abort();
      await vi.waitFor(() => expect(result).toBe('unknown'));
      expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ status: 'pending' });
    } finally {
      // Release the pre-fix waiter at its genuine filesystem boundary before fixture cleanup.
      await writeFile(receipt, JSON.stringify({ status: 'failed' }));
      await waiting;
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('removes additional private artifacts before their containing launch directory, idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const launchSpecPath = join(directory, 'launch.json');
    const receiptPath = join(directory, 'native-startup.json');
    await writeFile(launchSpecPath, '{}');
    await writeFile(receiptPath, '{}');
    try {
      const cleanup = createUnreadTerminalArtifactsCleanup({ launchSpecPath, cleanup: () => unlink(receiptPath) });
      await cleanup();
      await cleanup();
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(createUnreadTerminalArtifactsCleanup({ launchSpecPath })()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports incomplete cleanup without deleting an unexpected directory entry or hiding the filesystem cause', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const launchSpecPath = join(directory, 'launch.json');
    const retainedPath = join(directory, 'unrelated-entry');
    await writeFile(launchSpecPath, '{}');
    await writeFile(retainedPath, 'retained');
    vi.mocked(logger.infoFile).mockClear();
    try {
      const cleanup = createUnreadTerminalArtifactsCleanup({ launchSpecPath });
      await expect(cleanup()).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [expect.objectContaining({ code: 'ENOTEMPTY' })],
      });
      await expect(readFile(retainedPath, 'utf8')).resolves.toBe('retained');
      expect(logger.infoFile).toHaveBeenCalledWith(
        '[terminal] Launch artifact cleanup incomplete (terminal_launch_cleanup_incomplete)',
      );
      await expect(cleanup()).rejects.toBeInstanceOf(AggregateError);
      await unlink(retainedPath);
      await expect(cleanup()).resolves.toBeUndefined();
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
