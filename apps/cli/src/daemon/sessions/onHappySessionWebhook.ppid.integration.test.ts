import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { createDeferred } from '@/testkit/async/deferred';

import { createOnHappySessionWebhook } from './onHappySessionWebhook';
import { createOnChildExited } from './onChildExited';
import { waitForVisibleConsoleSessionWebhook } from './visibleConsoleSpawnWaiter';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

function createMetadata(pid: number, startedBy: 'daemon' | 'terminal'): Metadata {
  return {
    path: '/tmp',
    host: 'test-host',
    homeDir: '/tmp/home',
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib',
    happyToolsDir: '/tmp/tools',
    hostPid: pid,
    startedBy,
    machineId: 'machine-test',
  };
}

describe('createOnHappySessionWebhook (PPID correlation)', () => {
  it('keeps a placeholder-correlated live runner waiting through wrapper exit and accepts its later canonical report', async () => {
    if (process.platform === 'win32') return;
    const { parent: wrapper, childPid } = await spawnInlineNodeParentWithChild();
    const wrapperPid = wrapper.pid!;
    const tracked: TrackedSession = { pid: wrapperPid, startedBy: 'daemon' };
    const sessions = new Map([[wrapperPid, tracked]]);
    const awaiters = new Map<number, (session: TrackedSession) => void>();
    const resolvers = new Map<number, (result: SpawnSessionResult) => void>();
    const timeouts = new Map<number, ReturnType<typeof setTimeout>>();
    const promotion = createDeferred<{ fromPid: number; toPid: number }>();
    const exit = createOnChildExited({
      pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null, removeSessionMarkerFn: async () => {},
      onPidPromoted: promotion.resolve,
    });
    const completion = waitForVisibleConsoleSessionWebhook({
      pid: wrapperPid, pollMs: 10, pidToAwaiter: awaiters, pidToSpawnResultResolver: resolvers,
      pidToSpawnWebhookTimeout: timeouts, onChildExited: exit,
    });
    tracked.startupCustody = {
      finalization: completion.then(() => undefined),
      observeExit: () => {},
      promotePid: (pid) => completion.promotePid(pid),
    };
    const report = createOnHappySessionWebhook({
      pidToTrackedSession: sessions, pidToAwaiter: awaiters,
      findHappyProcessByPidFn: async () => null, writeSessionMarkerFn: async () => {},
    });
    try {
      await report(`PID-${childPid}`, createMetadata(childPid, 'daemon'));
      expect(sessions.get(wrapperPid)?.sessionRunnerPid).toBe(childPid);
      wrapper.kill('SIGKILL');
      await waitForProcessExit(wrapperPid, { timeoutMs: 2_000 });
      await expect(Promise.race([
        promotion.promise,
        completion.then((result) => {
          throw new Error(`Startup settled before runner promotion: ${result.type}`);
        }),
      ])).resolves.toMatchObject({ fromPid: wrapperPid, toPid: childPid });
      expect(sessions.has(childPid)).toBe(true);
      expect(awaiters.has(childPid)).toBe(true);
      await report('session-promoted-runner', createMetadata(childPid, 'daemon'));
      await expect(completion).resolves.toEqual({ type: 'success', sessionId: 'session-promoted-runner' });
      expect(awaiters.size).toBe(0);
      expect(resolvers.size).toBe(0);
      expect(timeouts.size).toBe(0);
    } finally {
      for (const timeout of timeouts.values()) clearTimeout(timeout);
      for (const resolve of resolvers.values()) resolve({ type: 'error', errorCode: 'CHILD_EXITED_BEFORE_WEBHOOK', errorMessage: 'Fixture cleanup' });
      try { process.kill(childPid, 'SIGKILL'); } catch {}
      try { wrapper.kill('SIGKILL'); } catch {}
      await waitForProcessExit(childPid, { timeoutMs: 2_000 });
      await waitForProcessExit(wrapperPid, { timeoutMs: 2_000 });
    }
  });
  it('correlates an unknown webhook PID to a daemon-tracked wrapper PID via PPID', { timeout: 15_000 }, async () => {
    if (process.platform === 'win32') {
      // Windows path intentionally skips PPID matching.
      return;
    }

    const { parent: wrapper, childPid } = await spawnInlineNodeParentWithChild();
    const wrapperPid = wrapper.pid;
    if (typeof wrapperPid !== 'number') {
      throw new Error('wrapper did not expose a pid');
    }

    try {
      const pidToTrackedSession = new Map<number, TrackedSession>([
        [wrapperPid, { startedBy: 'daemon', pid: wrapperPid }],
      ]);
      const awaiter = vi.fn();
      const pidToAwaiter = new Map<number, (session: TrackedSession) => void>([[wrapperPid, awaiter]]);

      const onWebhook = createOnHappySessionWebhook({
        pidToTrackedSession,
        pidToAwaiter,
        findHappyProcessByPidFn: async () => null,
        writeSessionMarkerFn: async () => {},
      });

      onWebhook('session-child-1', createMetadata(childPid, 'daemon'));

      expect(awaiter).toHaveBeenCalledTimes(1);
      expect(pidToAwaiter.has(wrapperPid)).toBe(false);
      expect(pidToTrackedSession.get(wrapperPid)?.happySessionId).toBe('session-child-1');
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
      try {
        process.kill(wrapperPid, 'SIGKILL');
      } catch {}
      await waitForProcessExit(childPid, { timeoutMs: 2_000 });
      await waitForProcessExit(wrapperPid, { timeoutMs: 2_000 });
    }
  });
});
