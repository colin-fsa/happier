import type { EnhancedMode } from '../loop';
import { readPendingLocalId } from '@happier-dev/protocol';
import type { PendingProviderAction } from '@/agent/runtime/modeMessageQueue';

export type ClaudeRemoteProviderPromptAcceptance = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    appliedModelId?: string;
}>;

export type ClaudeRemoteProviderAcceptedPrompt<Mode = EnhancedMode> = Readonly<{
    message: string;
    mode: Mode;
    maxUserMessageSeq?: number | null;
    userMessageLocalIds?: readonly string[] | null;
    providerAcceptancePending?: boolean;
    pendingProviderAction?: PendingProviderAction;
    pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
}>;

export type ClaudeRemoteProviderPromptAttribution = Readonly<{
    maxUserMessageSeq: number | null;
    userMessageLocalIds: readonly string[];
    providerAcceptancePending: boolean;
    pendingProviderAction?: PendingProviderAction;
    pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
}>;

export function readClaudeRemoteProviderPromptAttribution(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAttribution {
    return {
        ...readClaudeRemoteProviderPromptAcceptance(prompt),
        providerAcceptancePending: prompt.providerAcceptancePending === true,
        ...(prompt.pendingProviderAction ? { pendingProviderAction: prompt.pendingProviderAction } : {}),
        ...(prompt.pendingRequestedAction ? { pendingRequestedAction: prompt.pendingRequestedAction } : {}),
    };
}

export type ClaudeRemoteProviderPromptAcceptedHandler =
    (accepted: ClaudeRemoteProviderPromptAcceptance) => void | Promise<void>;

export type ClaudeRemoteProviderPromptTransportFailure =
    ClaudeRemoteProviderPromptAcceptance & Readonly<{
        kind: 'rejected_before_effect' | 'effect_may_have_occurred';
    }>;

export type ClaudeRemoteProviderPromptTransportFailureHandler =
    (failure: ClaudeRemoteProviderPromptTransportFailure) => void | Promise<void>;

export function readClaudeRemoteProviderPromptAcceptance(
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): ClaudeRemoteProviderPromptAcceptance {
    const localIds: string[] = [];
    const seenLocalIds = new Set<string>();
    for (const value of prompt.userMessageLocalIds ?? []) {
        const localId = readPendingLocalId(value) ?? '';
        if (!localId || seenLocalIds.has(localId)) continue;
        seenLocalIds.add(localId);
        localIds.push(localId);
    }
    return {
        maxUserMessageSeq: typeof prompt.maxUserMessageSeq === 'number' && Number.isInteger(prompt.maxUserMessageSeq)
            ? prompt.maxUserMessageSeq
            : null,
        userMessageLocalIds: localIds,
        ...(prompt.pendingProviderAction !== 'steer'
            && typeof prompt.mode.model === 'string'
            && prompt.mode.model.trim()
            ? { appliedModelId: prompt.mode.model.trim() }
            : {}),
    };
}

export function confirmClaudeRemoteProviderPromptAccepted(
    handler: ClaudeRemoteProviderPromptAcceptedHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
): void {
    if (!handler) return;
    void Promise.resolve(handler(readClaudeRemoteProviderPromptAcceptance(prompt))).catch(() => {});
}

export function reportClaudeRemoteProviderPromptTransportFailure(
    handler: ClaudeRemoteProviderPromptTransportFailureHandler | null | undefined,
    prompt: ClaudeRemoteProviderAcceptedPrompt,
    kind: ClaudeRemoteProviderPromptTransportFailure['kind'],
): void {
    if (!handler) return;
    void Promise.resolve(handler({
        kind,
        ...readClaudeRemoteProviderPromptAcceptance(prompt),
    })).catch(() => {});
}

/**
 * Owns settlement for prompts claimed from Happier's durable pending queue.
 *
 * Direct Claude runtimes accept custody at their supported prompt-input API.
 * Anything still tracked when the runtime exits never crossed that boundary and
 * can be retried safely. Claude Unified's TUI injection has its own stronger
 * settlement contract and deliberately does not use this tracker.
 */
export function createClaudeRemotePromptSettlementTracker(options: Readonly<{
    onAccepted?: ClaudeRemoteProviderPromptAcceptedHandler | null;
    onTransportFailure?: ClaudeRemoteProviderPromptTransportFailureHandler | null;
}>) {
    const unresolved = new Set<ClaudeRemoteProviderAcceptedPrompt>();

    const remove = (prompt: ClaudeRemoteProviderAcceptedPrompt): boolean => unresolved.delete(prompt);
    const rejectBeforeEffect = (prompt: ClaudeRemoteProviderAcceptedPrompt): void => {
        if (!remove(prompt)) return;
        reportClaudeRemoteProviderPromptTransportFailure(
            options.onTransportFailure,
            prompt,
            'rejected_before_effect',
        );
    };

    return {
        track(prompt: ClaudeRemoteProviderAcceptedPrompt): void {
            unresolved.add(prompt);
        },
        accept(prompt: ClaudeRemoteProviderAcceptedPrompt): void {
            if (!remove(prompt)) return;
            confirmClaudeRemoteProviderPromptAccepted(options.onAccepted, prompt);
        },
        rejectBeforeEffect,
        settleUnresolved(): void {
            for (const prompt of [...unresolved]) {
                rejectBeforeEffect(prompt);
            }
        },
    };
}
