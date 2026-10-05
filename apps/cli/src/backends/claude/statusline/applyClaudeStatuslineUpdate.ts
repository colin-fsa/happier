import { logger } from '@/ui/logger';

import type { Session } from '../session';
import { applyClaudeEffectiveModelUpdate } from '../sessionModels/effectiveModelUpdate';
import type { ClaudeStatuslinePayload } from './statuslinePayload';

/**
 * Consumes Claude statusline payloads (pushed by the statusline forwarder wrapper) and feeds
 * them into the EXISTING session-models metadata seam (`runtime_model_update`, the same writer
 * the SDK launcher and the transcript projector use).
 *
 * Statusline is FASTER than JSONL model adoption and is the only DIRECT source of the max
 * context window (`context_window.context_window_size`), so it wins the UI window resolution
 * (sessionModelsV1 is preferred over catalog/default there). Everything here is additive
 * enrichment: sessions without statusline data keep the U8 catalog + evidence-bump fallbacks.
 */

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveTokens(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

/**
 * Stale/foreign payload guard. Statusline fires immediately at TUI start — possibly before the
 * SessionStart hook adopted the Claude session id — so an unidentified session accepts payloads,
 * while a session with a known identity rejects payloads matching neither the Claude session id
 * nor the transcript path (the id rotates on fork/compact; the transcript path is the steadier key).
 */
function matchesSession(session: Session, payload: ClaudeStatuslinePayload): boolean {
    const payloadSessionId = readString(payload.session_id);
    const payloadTranscriptPath = readString(payload.transcript_path);
    const knownSessionId = readString(session.sessionId);
    const knownTranscriptPath = readString(session.transcriptPath);

    if (payloadSessionId && knownSessionId && payloadSessionId === knownSessionId) return true;
    if (payloadTranscriptPath && knownTranscriptPath && payloadTranscriptPath === knownTranscriptPath) return true;
    return !knownSessionId && !knownTranscriptPath;
}

/**
 * Statusline-reported effective runtime facts forwarded to the active runtime-control reconciler
 * (Claude Unified controller `lastVerified`). Effective-truth only — consumers must never write
 * desired-state surfaces from this feed.
 */
export type ClaudeStatuslineRuntimeReconcileInput = Readonly<{
    model?: string | undefined;
    reasoningEffort?: string | undefined;
}>;

type StatuslineSessionState = {
    lastRuntimeReconcileKey: string | null;
    lastCanaryKey: string | null;
};

export function createClaudeStatuslineApplier(params: Readonly<{
    logPrefix: string;
}>): Readonly<{
    apply(session: Session, payload: ClaudeStatuslinePayload): void;
}> {
    const stateBySession = new WeakMap<Session, StatuslineSessionState>();

    const stateFor = (session: Session): StatuslineSessionState => {
        const existing = stateBySession.get(session);
        if (existing) return existing;
        const created: StatuslineSessionState = { lastRuntimeReconcileKey: null, lastCanaryKey: null };
        stateBySession.set(session, created);
        return created;
    };

    const maybeAdoptModelAndWindow = (
        session: Session,
        payload: ClaudeStatuslinePayload,
    ): void => {
        const modelId = readString(payload.model?.id);
        if (!modelId) return;
        const contextWindowTokens = readPositiveTokens(payload.context_window?.context_window_size);
        const displayName = readString(payload.model?.display_name);

        applyClaudeEffectiveModelUpdate({
            client: session.client,
            reconcileModels: session.reconcileSessionModels,
            modelId,
            displayName,
            contextWindowTokens,
            reasoningEffort: readString(payload.effort?.level),
            source: 'statusline',
            logPrefix: params.logPrefix,
        });
    };

    /**
     * Lane Y effective-truth feed: forward the live model/effort to the session's registered
     * runtime reconciler (Claude Unified controller `lastVerified`) so a matching desired change
     * converges as `skipped_already_effective` without TUI bytes. Deduped on REAL change only
     * (the model/window metadata dedup above does not see effort changes, so this keeps its own
     * change key). Never writes metadata — desired-state surfaces stay untouched by statusline.
     */
    const maybeReconcileRuntime = (
        session: Session,
        payload: ClaudeStatuslinePayload,
        state: StatuslineSessionState,
    ): void => {
        const modelId = readString(payload.model?.id);
        const reasoningEffort = readString(payload.effort?.level);
        if (modelId === null && reasoningEffort === null) return;

        const reconcileKey = `${modelId ?? ''}|${reasoningEffort ?? ''}`;
        if (reconcileKey === state.lastRuntimeReconcileKey) return;
        state.lastRuntimeReconcileKey = reconcileKey;

        session.reconcileClaudeRuntimeFromStatusline({
            ...(modelId !== null ? { model: modelId } : {}),
            ...(reasoningEffort !== null ? { reasoningEffort } : {}),
        });
    };

    const maybeLogRuntimeCanary = (payload: ClaudeStatuslinePayload, state: StatuslineSessionState): void => {
        const canary = {
            version: payload.version ?? null,
            exceeds200k: payload.exceeds_200k_tokens ?? null,
            fastMode: payload.fast_mode ?? null,
            thinking: payload.thinking?.enabled ?? null,
            effort: payload.effort?.level ?? null,
        };
        const canaryKey = JSON.stringify(canary);
        if (canaryKey === state.lastCanaryKey) return;
        state.lastCanaryKey = canaryKey;
        // Drift canary + diagnostics: one debounced (change-only) file-log line, never console noise.
        logger.debug(`${params.logPrefix}: statusline runtime state`, canary);
    };

    return {
        apply(session, payload) {
            if (!matchesSession(session, payload)) {
                logger.debug(`${params.logPrefix}: ignoring statusline payload from foreign/stale Claude session`, {
                    payloadSessionId: payload.session_id ?? null,
                    knownSessionId: session.sessionId,
                });
                return;
            }
            maybeAdoptModelAndWindow(session, payload);
            maybeReconcileRuntime(session, payload, stateFor(session));
            maybeLogRuntimeCanary(payload, stateFor(session));
        },
    };
}
