import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { createConnectedServiceSwitchDeferralQueue } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

import { createRestartCompletionWaiters } from './completionWaiters';
import { requestPlannedRunnerRestart } from './requestPlannedRunnerRestart';

function trackedSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 4242,
    happySessionId: 'sess-1',
    processCommandHash: 'hash-1',
    spawnOptions: {
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'claude-thread-1',
    } satisfies SpawnSessionOptions,
    ...overrides,
  };
}

describe('requestPlannedRunnerRestart', () => {
  it('routes connected-service restarts through deferral before reserving and signalling the runner', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    const requestSignal = vi.fn(async () => {
      expect(restartRequestedPids.has(tracked.pid)).toBe(true);
      return { status: 'requested' as const };
    });

    const pending = requestPlannedRunnerRestart({
      completionWaiters: createRestartCompletionWaiters({ timeoutMs: 60_000 }),
      sessionId: 'sess-1',
      tracked,
      reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch',
        source: 'automatic',
        policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId: 'work', groupId: 'primary', generation: 2 },
        turnDeferralQueue: queue,
      },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      logDebug: () => {},
    });

    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
    expect(requestSignal).not.toHaveBeenCalled();
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(pending).resolves.toEqual({ signaled: true });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('clears the reservation and reports no signal when ownership changes before signal', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();

    const result = await requestPlannedRunnerRestart({
      completionWaiters: createRestartCompletionWaiters({ timeoutMs: 60_000 }),
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal: async ({ shouldSignal }) => {
        pidToTrackedSession.delete(tracked.pid);
        return await shouldSignal() ? { status: 'requested' as const } : { status: 'skipped_stale_owner' as const };
      },
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'stale_owner' });
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('clears the reservation and reports no signal when pid identity is unsafe', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const isProcessSafeToSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      completionWaiters: createRestartCompletionWaiters({ timeoutMs: 60_000 }),
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      isProcessSafeToSignal,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'unsafe_process' });
    expect(isProcessSafeToSignal).toHaveBeenCalledWith({
      pid: 4242,
      expectedProcessCommandHash: 'hash-1',
    });
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('clears the reservation and reports no signal when activity starts before signal', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const canSignal = vi.fn(async () => false);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      completionWaiters: createRestartCompletionWaiters({ timeoutMs: 60_000 }),
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: false, notSignaledReason: 'activity_in_progress' });
    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(requestSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('preserves the exact activity disabled reason when the final signal guard rejects', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const canSignal = vi.fn(async () => 'approval_pending' as const);
    const requestSignal = vi.fn(async ({ shouldSignal }) => (
      await shouldSignal()
        ? { status: 'requested' as const }
        : { status: 'skipped_stale_owner' as const }
    ));

    const result = await requestPlannedRunnerRestart({
      completionWaiters: createRestartCompletionWaiters({ timeoutMs: 60_000 }),
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal,
      canSignal,
      isProcessSafeToSignal: async () => true,
      logDebug: () => {},
    });

    expect(result).toEqual({
      signaled: false,
      notSignaledReason: 'activity_in_progress',
      activityDisabledReason: 'approval_pending',
    });
    expect(canSignal).toHaveBeenCalledTimes(1);
    expect(restartRequestedPids.has(tracked.pid)).toBe(false);
  });

  it('observes missing processes through the caller hook and keeps the forced-respawn reservation', async () => {
    const tracked = trackedSession();
    const pidToTrackedSession = new Map<number, TrackedSession>([[tracked.pid, tracked]]);
    const restartRequestedPids = new Set<number>();
    const observeProcessMissing = vi.fn();

    const result = await requestPlannedRunnerRestart({
      completionWaiters: createRestartCompletionWaiters({ timeoutMs: 60_000 }),
      sessionId: 'sess-1',
      tracked,
      reason: 'version_runtime_refresh',
      deferral: { kind: 'none' },
      restartRequestedPids,
      pidToTrackedSession,
      requestSignal: async () => ({ status: 'process_already_missing' as const }),
      observeProcessMissing,
      logDebug: () => {},
    });

    expect(result).toEqual({ signaled: true });
    expect(observeProcessMissing).toHaveBeenCalledWith(tracked);
    expect(restartRequestedPids.has(tracked.pid)).toBe(true);
  });

  it('preserves connected-service cancellation semantics when a deferred request is superseded', async () => {
    const tracked = trackedSession();
    const restartRequestedPids = new Set<number>();
    const completionWaiters = createRestartCompletionWaiters({ timeoutMs: 60_000 });
    const queue = createConnectedServiceSwitchDeferralQueue({ timeoutMs: 60_000, disableDeferral: false });
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'task_started' });
    const requestSignal = vi.fn(async () => ({ status: 'requested' as const }));
    const request = (profileId: string) => requestPlannedRunnerRestart({
      completionWaiters, sessionId: 'sess-1', tracked, reason: 'connected_service_switch',
      deferral: {
        kind: 'connected_service_switch', source: 'automatic', policy: 'defer_until_turn_boundary',
        target: { serviceId: 'anthropic', profileId, groupId: 'primary', generation: 2 },
        turnDeferralQueue: queue,
      },
      restartRequestedPids, pidToTrackedSession: new Map([[tracked.pid, tracked]]), requestSignal,
      logDebug: () => {},
    });
    const superseded = request('work');
    const selected = request('personal');
    await expect(superseded).resolves.toEqual({ signaled: false, notSignaledReason: 'superseded' });
    expect(requestSignal).not.toHaveBeenCalled();
    expect(restartRequestedPids.size).toBe(0);
    queue.recordTurnLifecycleEvent({ sessionId: 'sess-1', event: 'assistant_message_end' });
    await expect(selected).resolves.toEqual({ signaled: true });
  });
});
