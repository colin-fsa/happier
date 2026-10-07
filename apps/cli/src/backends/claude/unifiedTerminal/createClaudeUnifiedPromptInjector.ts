import { randomUUID } from 'node:crypto';

import type {
  TerminalInputInjectionResult,
  TerminalInputInjectionV1,
} from '@/agent/runtime/terminal/TerminalInputInjectionV1';
import { hasMultilinePayload } from '@/agent/runtime/terminal/injection/bracketedPaste';
import { resolveTerminalPromptWriteBudget } from '@/agent/runtime/terminal/injection/promptWriteTimeout';
import { prepareTerminalPromptTextForInjection } from '@/agent/runtime/terminal/injection/promptTextSafety';
import {
  TERMINAL_INPUT_QUIET_PERIOD_MS,
} from '@/agent/runtime/terminal/injection/arbiter';

import type {
  ClaudeUnifiedPromptBatch,
  ClaudeUnifiedPromptInjectionOptions,
  ClaudeUnifiedPromptInjector,
} from './_types';
import type { ClaudeUnifiedTelemetrySink } from './telemetry';
import { emitClaudeUnifiedInjectionDraftGuard, emitClaudeUnifiedInjectionOutcome } from './telemetry';

// Guard-deferral retry delay: an idle session has no turn-end/readiness wake, so deferrals must
// arm their own retry timer (live-proven starvation, runner pid 20327).
const DRAFT_GUARD_RETRY_MS = 2_000;
const DRAFT_GUARD_BACKOFF_RETRY_MS = 30_000;
export const DEFAULT_DRAFT_GUARD_STARVATION_THRESHOLD_MS = 15_000;
const MIN_DRAFT_GUARD_STARVATION_THRESHOLD_MS = 1_000;
const MAX_DRAFT_GUARD_STARVATION_THRESHOLD_MS = 5 * 60_000;

function resolveDraftGuardStarvationThresholdMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_DRAFT_GUARD_STARVATION_THRESHOLD_MS;
  if (!Number.isFinite(candidate)) return DEFAULT_DRAFT_GUARD_STARVATION_THRESHOLD_MS;
  return Math.min(
    MAX_DRAFT_GUARD_STARVATION_THRESHOLD_MS,
    Math.max(MIN_DRAFT_GUARD_STARVATION_THRESHOLD_MS, Math.trunc(candidate)),
  );
}

/**
 * Outcome of the pre-injection composer guard (C11): screen-lite projection of
 * `OwnComposerDraftGuardResult` so the injector does not depend on parsed screen state.
 */
export type ClaudeUnifiedComposerDraftGuardOutcome = Readonly<{
  status:
    | 'no_draft'
    | 'cleared'
    | 'foreign_draft'
    | 'capture_style_unavailable'
    | 'provider_unavailable'
    | 'blocked_non_input_state'
    | 'generating'
    | 'capture_failed'
    | 'clear_failed';
  attempts?: number | undefined;
  draftLength?: number | undefined;
  blockedReason?: string | undefined;
}>;

type ClaudeUnifiedDraftGuardBlockerStatus = Extract<
  ClaudeUnifiedComposerDraftGuardOutcome['status'],
  'foreign_draft' | 'capture_style_unavailable' | 'clear_failed' | 'blocked_non_input_state'
>;

export type ClaudeUnifiedDraftGuardStarvationInfo = Readonly<{
  consecutiveDeferrals: number;
  draftLength?: number | undefined;
  guardStatus: ClaudeUnifiedDraftGuardBlockerStatus;
  blockedReason?: string | undefined;
  isCanonicalTurnActive?: boolean | undefined;
  originKind: 'ui_pending' | 'ui_immediate' | 'goal_control';
  userMessageLocalIds?: readonly string[] | undefined;
}>;

function resolveDraftGuardBlocker(
  guard: ClaudeUnifiedComposerDraftGuardOutcome,
): NonNullable<Extract<TerminalInputInjectionResult, { status: 'deferred' }>['blocker']> | null {
  switch (guard.status) {
    case 'provider_unavailable':
      return {
        kind: 'provider_unavailable',
        source: 'draft_guard',
        detail: 'claude_usage_limit_dialog',
      };
    case 'blocked_non_input_state':
      return {
        kind: 'terminal_busy',
        source: 'readiness',
        detail: guard.blockedReason ?? 'non_input_state',
      };
    case 'foreign_draft':
      return {
        kind: 'terminal_user_draft',
        source: 'draft_guard',
        guardStatus: guard.status,
        ...(guard.draftLength !== undefined ? { draftLength: guard.draftLength } : {}),
      };
    case 'clear_failed':
      return {
        kind: 'own_leftover_clear_failed',
        source: 'draft_guard',
        guardStatus: guard.status,
        ...(guard.draftLength !== undefined ? { draftLength: guard.draftLength } : {}),
      };
    case 'capture_style_unavailable':
      return {
        kind: 'capture_ambiguous',
        source: 'draft_guard',
        guardStatus: guard.status,
        ...(guard.draftLength !== undefined ? { draftLength: guard.draftLength } : {}),
      };
    default:
      return null;
  }
}

export function createClaudeUnifiedPromptInjector<Mode = unknown>(opts: Readonly<{
  inputInjection: TerminalInputInjectionV1;
  createNonce?: (() => string) | undefined;
  telemetry?: ClaudeUnifiedTelemetrySink | undefined;
  /**
   * C11 (live-proven, runner pid 83791): idle injection typed the new prompt AFTER a leftover
   * composer draft and submitted the concatenation as one corrupted prompt. When provided, the
   * guard runs before every non-steer write: own leftovers are cleared (bounded), a genuine user
   * draft or an uncleared leftover defers the injection untouched. In-flight steers skip the
   * guard — the steer evaluator already owns that screen's draft policy.
   */
  composerDraftGuard?: (() => Promise<ClaudeUnifiedComposerDraftGuardOutcome>) | undefined;
  /**
   * Runs the existing runtime-control gate before draft classification. Controller-owned dialogs
   * must be resolved here so the draft guard cannot starve the owner that would clear them.
   */
  beforeComposerDraftGuard?: (() => Promise<TerminalInputInjectionResult | null>) | undefined;
  nowMs?: (() => number) | undefined;
  /** Configuration/test seam; values are clamped to the bounded production range. */
  draftGuardStarvationThresholdMs?: number | undefined;
  onInjected?: ((batch: ClaudeUnifiedPromptBatch<Mode>) => void | Promise<void>) | undefined;
  /**
   * Fired once per idle pre-injection guard episode after the sustained-backoff threshold is
   * reached. This gives the runner a structured surface for a genuine draft or dialog blocker.
   */
  onDraftGuardStarvation?: ((info: ClaudeUnifiedDraftGuardStarvationInfo) => void) | undefined;
  onDraftGuardClear?: (() => void) | undefined;
  isCanonicalTurnActive?: (() => boolean) | undefined;
}>): ClaudeUnifiedPromptInjector<Mode> {
  const createNonce = opts.createNonce ?? randomUUID;
  const nowMs = opts.nowMs ?? Date.now;
  const draftGuardStarvationThresholdMs = resolveDraftGuardStarvationThresholdMs(
    opts.draftGuardStarvationThresholdMs,
  );
  let draftGuardDeferralCount = 0;
  let draftGuardDeferralStartedAtMs: number | null = null;
  let draftGuardStarvationEscalated = false;

  function resetDraftGuardDeferralEpisode(): void {
    draftGuardDeferralCount = 0;
    draftGuardDeferralStartedAtMs = null;
    draftGuardStarvationEscalated = false;
  }

  function readCanonicalTurnActive(): boolean {
    try {
      return opts.isCanonicalTurnActive?.() ?? true;
    } catch {
      return true;
    }
  }

  function recordDraftGuardDeferral(): Readonly<{
    consecutiveDeferrals: number;
    retryAfterMs: number;
    starvationEscalatedNow: boolean;
  }> {
    const now = nowMs();
    draftGuardDeferralStartedAtMs ??= now;
    draftGuardDeferralCount += 1;
    const sustained = now - draftGuardDeferralStartedAtMs >= draftGuardStarvationThresholdMs;
    const starvationEscalatedNow = sustained && !draftGuardStarvationEscalated;
    if (starvationEscalatedNow) {
      draftGuardStarvationEscalated = true;
    }
    return {
      consecutiveDeferrals: draftGuardDeferralCount,
      retryAfterMs: sustained ? DRAFT_GUARD_BACKOFF_RETRY_MS : DRAFT_GUARD_RETRY_MS,
      starvationEscalatedNow,
    };
  }

  return {
    async injectPrompt(
      batch: ClaudeUnifiedPromptBatch<Mode>,
      options?: ClaudeUnifiedPromptInjectionOptions | undefined,
    ) {
      const preparedPrompt = prepareTerminalPromptTextForInjection(batch.message);
      const multiline = preparedPrompt.ok ? preparedPrompt.multiline : hasMultilinePayload(batch.message);
      const inFlightSteer = options?.inFlightSteer === true;

      if (!preparedPrompt.ok) {
        const result: TerminalInputInjectionResult = {
          status: 'failed',
          reason: 'invalid_prompt_text',
          phase: 'before_write',
          duplicateRisk: 'none',
          recoverable: false,
        };
        if (opts.telemetry) {
          emitClaudeUnifiedInjectionOutcome(opts.telemetry, {
            result,
            hostKind: opts.inputInjection.hostKind,
            multiline,
            originKind: batch.origin.kind,
            ...(inFlightSteer ? { inFlightSteer: true } : {}),
          });
        }
        return result;
      }

      const text = preparedPrompt.text;
      const writeBudget = resolveTerminalPromptWriteBudget(text);

      if (opts.beforeComposerDraftGuard) {
        const gateResult = await opts.beforeComposerDraftGuard();
        if (gateResult) {
          if (opts.telemetry) {
            emitClaudeUnifiedInjectionOutcome(opts.telemetry, {
              result: gateResult,
              hostKind: opts.inputInjection.hostKind,
              multiline,
              inputByteLength: writeBudget.byteLength,
              inputNewlineCount: writeBudget.newlineCount,
              writeTimeoutMs: writeBudget.timeoutMs,
              originKind: batch.origin.kind,
              ...(inFlightSteer ? { inFlightSteer: true } : {}),
            });
          }
          return gateResult;
        }
      }

      if (opts.composerDraftGuard && !inFlightSteer) {
        const guard = await opts.composerDraftGuard();
        if (opts.telemetry && guard.status !== 'no_draft') {
          emitClaudeUnifiedInjectionDraftGuard(opts.telemetry, {
            status: guard.status,
            ...(guard.attempts !== undefined ? { attempts: guard.attempts } : {}),
            ...(guard.draftLength !== undefined ? { draftLength: guard.draftLength } : {}),
            ...(guard.blockedReason !== undefined ? { blockedReason: guard.blockedReason } : {}),
            originKind: batch.origin.kind,
          });
        }
        if (
          guard.status === 'foreign_draft'
          || guard.status === 'capture_style_unavailable'
          || guard.status === 'clear_failed'
          || guard.status === 'blocked_non_input_state'
        ) {
          // Never write next to a draft we may not own: defer WITH a retry delay — an idle
          // session has no turn-end/readiness wake, so a bare deferral would starve the head
          // prompt forever (live-proven, runner pid 20327). After a sustained draft episode,
          // slow the recheck cadence so a genuine user draft cannot drive endless zellij probes.
          const deferral = recordDraftGuardDeferral();
          if (deferral.starvationEscalatedNow) {
            const starvationInfo: ClaudeUnifiedDraftGuardStarvationInfo = {
              consecutiveDeferrals: deferral.consecutiveDeferrals,
              ...(guard.draftLength !== undefined ? { draftLength: guard.draftLength } : {}),
              guardStatus: guard.status,
              ...(guard.blockedReason !== undefined ? { blockedReason: guard.blockedReason } : {}),
              isCanonicalTurnActive: readCanonicalTurnActive(),
              originKind: batch.origin.kind,
              userMessageLocalIds: batch.userMessageLocalIds ?? [],
            };
            if (opts.telemetry) {
              emitClaudeUnifiedInjectionDraftGuard(opts.telemetry, {
                status: 'starvation_escalated',
                consecutiveDeferrals: starvationInfo.consecutiveDeferrals,
                ...(starvationInfo.draftLength !== undefined ? { draftLength: starvationInfo.draftLength } : {}),
                guardStatus: starvationInfo.guardStatus,
                ...(starvationInfo.blockedReason !== undefined ? { blockedReason: starvationInfo.blockedReason } : {}),
                originKind: starvationInfo.originKind,
              });
            }
            opts.onDraftGuardStarvation?.(starvationInfo);
          }
          return {
            status: 'deferred',
            reason: guard.status === 'blocked_non_input_state' ? 'terminal_busy' : 'user_typing',
            retryAfterMs: deferral.retryAfterMs,
            blocker: resolveDraftGuardBlocker(guard) ?? undefined,
          };
        }
        if (guard.status === 'provider_unavailable') {
          return {
            status: 'deferred',
            reason: 'terminal_busy',
            retryAfterMs: DRAFT_GUARD_BACKOFF_RETRY_MS,
            blocker: resolveDraftGuardBlocker(guard) ?? undefined,
          };
        }
        if (guard.status === 'no_draft' || guard.status === 'cleared') {
          opts.onDraftGuardClear?.();
        }
        resetDraftGuardDeferralEpisode();
      }

      const input = {
        text,
        multiline,
        resolveDeliveryState: options?.resolveDeliveryState,
        origin: {
          // The terminal-host boundary classifies where the write came from; keep its generic RPC
          // vocabulary while the Claude arbiter retains the goal-control semantic needed for custody.
          kind: batch.origin.kind === 'goal_control' ? 'rpc' : batch.origin.kind,
          clientId: batch.origin.clientId,
          nonce: batch.origin.nonce ?? createNonce(),
        },
        // In-flight steers write into an actively-generating screen, which is never "quiet";
        // the steer-safety screen evaluation already vetoed visible user drafts, so the
        // adapter-level quiet-screen deferral must be skipped for them.
        scheduling: {
          ...(inFlightSteer ? {} : { deferredUntilQuietMs: TERMINAL_INPUT_QUIET_PERIOD_MS }),
          timeoutMs: writeBudget.timeoutMs,
        },
      } as const;
      const result = await opts.inputInjection.injectUserPrompt(input);
      if (opts.telemetry) {
        emitClaudeUnifiedInjectionOutcome(opts.telemetry, {
          result,
          hostKind: opts.inputInjection.hostKind,
          multiline,
          inputByteLength: writeBudget.byteLength,
          inputNewlineCount: writeBudget.newlineCount,
          writeTimeoutMs: writeBudget.timeoutMs,
          originKind: batch.origin.kind,
          ...(inFlightSteer ? { inFlightSteer: true } : {}),
        });
      }
      if (result.status === 'injected') {
        resetDraftGuardDeferralEpisode();
        await opts.onInjected?.(batch);
      }
      return result;
    },
  };
}
