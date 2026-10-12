import { isSameConnectedServiceSwitchTarget } from '@/daemon/connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import type { PlannedRunnerRestartIntent } from './types';
import type { RestartSessionRunnerCompletion } from './restartSessionRunnerOnCurrentRuntime';

export type RestartCompletionWaiter = Readonly<{
  promise: Promise<RestartSessionRunnerCompletion>;
  cancel: () => void;
}>;

export type RestartCompletionWaiters = Readonly<{
  /** Registers one completion for a restart of `previousPid`; an existing waiter cannot be replaced. */
  create: (sessionId: string, previousPid: number, intent: PlannedRunnerRestartIntent) => RestartCompletionWaiter;
  /** Returns the in-flight completion for a restart of `previousPid`, if one is pending. */
  join: (sessionId: string, previousPid: number, intent?: PlannedRunnerRestartIntent) => Promise<RestartSessionRunnerCompletion> | null;
  settle: (sessionId: string, previousPid: number, completion: RestartSessionRunnerCompletion) => void;
}>;

type PendingWaiter = Readonly<{
  intent: PlannedRunnerRestartIntent;
  promise: Promise<RestartSessionRunnerCompletion>;
  settle: (completion: RestartSessionRunnerCompletion) => void;
}>;

const CANCELLED_BEFORE_SIGNAL_REASON = 'cancelled_before_signal';

/** True when the restart behind this completion was abandoned before its runner was ever signalled. */
export function isRestartCancelledBeforeSignal(completion: RestartSessionRunnerCompletion): boolean {
  return completion.ok === false
    && completion.diagnostics?.respawnTerminalReason === CANCELLED_BEFORE_SIGNAL_REASON;
}

export function isSamePlannedRunnerRestartIntent(a: PlannedRunnerRestartIntent, b: PlannedRunnerRestartIntent): boolean {
  if (a.reason !== b.reason || a.tracked !== b.tracked) return false;
  if (!a.target || !b.target) return !a.target && !b.target;
  return isSameConnectedServiceSwitchTarget(a.target, b.target);
}

function waiterKey(sessionId: string, previousPid: number): string {
  return `${sessionId}\u0000${previousPid}`;
}

/**
 * Tracks the completion of planned runner restarts per (session, previous pid) so a restart request can await
 * the respawn that its signal triggers. Completions are settled by the respawn manager, cancelled by a request
 * that never signalled, or timed out after `timeoutMs`.
 */
export function createRestartCompletionWaiters(params: Readonly<{ timeoutMs: number }>): RestartCompletionWaiters {
  const waiters = new Map<string, PendingWaiter>();

  const settle = (sessionId: string, previousPid: number, completion: RestartSessionRunnerCompletion): void => {
    const key = waiterKey(sessionId, previousPid);
    const waiter = waiters.get(key);
    if (!waiter) return;
    waiters.delete(key);
    waiter.settle(completion);
  };

  const create = (sessionId: string, previousPid: number, intent: PlannedRunnerRestartIntent): RestartCompletionWaiter => {
    const key = waiterKey(sessionId, previousPid);
    if (waiters.has(key)) throw new Error('Restart completion is already pending for this runner');
    let resolved = false;
    let resolveCompletion!: (completion: RestartSessionRunnerCompletion) => void;
    const promise = new Promise<RestartSessionRunnerCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const timer = setTimeout(() => {
      settle(sessionId, previousPid, {
        ok: false,
        status: 'partial_failure',
        diagnostics: { respawnTerminalReason: 'timeout', timeoutMs: params.timeoutMs },
      });
    }, params.timeoutMs) as NodeJS.Timeout & { unref?: () => void };
    timer.unref?.();
    const settleOnce = (completion: RestartSessionRunnerCompletion) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolveCompletion(completion);
    };
    const pending: PendingWaiter = { promise, settle: settleOnce, intent };
    waiters.set(key, pending);
    return {
      promise,
      cancel: () => {
        if (resolved) return;
        if (waiters.get(key) === pending) waiters.delete(key);
        settleOnce({
          ok: false,
          status: 'partial_failure',
          diagnostics: { respawnTerminalReason: CANCELLED_BEFORE_SIGNAL_REASON },
        });
      },
    };
  };

  const join = (sessionId: string, previousPid: number, intent?: PlannedRunnerRestartIntent): Promise<RestartSessionRunnerCompletion> | null => {
    const pending = waiters.get(waiterKey(sessionId, previousPid));
    if (!pending) return null;
    if (intent && !isSamePlannedRunnerRestartIntent(pending.intent, intent)) return null;
    return pending.promise;
  };

  return { create, join, settle };
}
