import { useFocusEffect } from '@react-navigation/native';
import * as React from 'react';

import {
    clearActiveViewingSessionId,
    setActiveViewingSessionId,
} from '@/sync/domains/session/activeViewingSession';
import {
    beginSessionViewingActivation,
    clearManualUnreadHold,
    endSessionViewingActivation,
    shouldSuppressAutomaticMarkViewed,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { sync } from '@/sync/sync';
import { beginSessionReminderViewing } from '@/sync/ops/sessionOrganization/sessionReminderViewing';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';

const SESSION_VIEWED_SEQ_CHANGE_MARK_DELAY_MS = 250;

export type UseSessionViewedLifecycleInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    surfaceFocused: boolean;
    visibleReadSeq: number | null;
}>;

function normalizeVisibleReadSeq(value: number | null): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

export function useSessionViewedLifecycle(input: UseSessionViewedLifecycleInput): void {
    const isFocusedRef = React.useRef(false);
    const viewingActivationIdRef = React.useRef<number | null>(null);
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);
    const pendingMarkRef = React.useRef<{ sessionSeq: number } | null>(null);
    const visibleReadSeqRef = React.useRef<number | null>(null);
    const activeViewingSeqRef = React.useRef<{
        sessionId: string;
        activationId: number;
        visibleReadSeq: number | null;
    } | null>(null);
    const currentVisibleReadSeq = normalizeVisibleReadSeq(input.visibleReadSeq);
    visibleReadSeqRef.current = currentVisibleReadSeq;

    const clearDelayedMark = React.useCallback(() => {
        if (markViewedTimeoutRef.current) {
            clearTimeout(markViewedTimeoutRef.current);
            markViewedTimeoutRef.current = null;
        }
        pendingMarkRef.current = null;
    }, []);

    const markSessionViewed = React.useCallback((opts: { sessionSeq: number; activationId: number | null }) => {
        const sessionSeq = normalizeVisibleReadSeq(opts.sessionSeq);
        if (sessionSeq === null) return;
        if (shouldSuppressAutomaticMarkViewed({
            sessionId: input.sessionId,
            sessionSeq,
            activationId: opts.activationId,
        })) {
            return;
        }
        fireAndForget(
            sync.markSessionViewed(input.sessionId, { sessionSeq }).then(() => {
                clearManualUnreadHold({ sessionId: input.sessionId, activationId: opts.activationId });
            }),
            { tag: 'SessionView.markSessionViewed' },
        );
    }, [input.sessionId]);

    React.useLayoutEffect(() => {
        const active = activeViewingSeqRef.current;
        if (active?.sessionId === input.sessionId) {
            active.visibleReadSeq = currentVisibleReadSeq;
        }
    }, [currentVisibleReadSeq, input.sessionId]);

    useFocusEffect(React.useCallback(() => {
        if (!input.surfaceFocused) return;

        isFocusedRef.current = true;
        const activationId = beginSessionViewingActivation(input.sessionId);
        viewingActivationIdRef.current = activationId;
        setActiveViewingSessionId(input.sessionId, activationId, input.serverId);
        const endReminderViewing = beginSessionReminderViewing(input.sessionId, { serverId: input.serverId });

        const initialVisibleSeq = visibleReadSeqRef.current;
        activeViewingSeqRef.current = {
            sessionId: input.sessionId,
            activationId,
            visibleReadSeq: initialVisibleSeq,
        };
        lastMarkedRef.current = initialVisibleSeq === null ? null : { sessionSeq: initialVisibleSeq };
        const cancelInitialMark = initialVisibleSeq === null
            ? () => {}
            : runAfterInteractionsWithFallback(() => {
                markSessionViewed({ sessionSeq: initialVisibleSeq, activationId });
            });

        return () => {
            isFocusedRef.current = false;
            endReminderViewing();
            cancelInitialMark();
            clearDelayedMark();

            const activeViewingSeq = activeViewingSeqRef.current;
            const activeViewingSeqMatches = activeViewingSeq?.sessionId === input.sessionId
                && activeViewingSeq.activationId === activationId;
            const blurVisibleSeq = activeViewingSeqMatches ? activeViewingSeq.visibleReadSeq : initialVisibleSeq;
            if (activeViewingSeqMatches) {
                activeViewingSeqRef.current = null;
            }
            clearActiveViewingSessionId(input.sessionId, activationId, input.serverId);
            if (blurVisibleSeq !== null && !shouldSuppressAutomaticMarkViewed({
                sessionId: input.sessionId,
                sessionSeq: blurVisibleSeq,
                activationId,
            })) {
                runAfterInteractionsWithFallback(() => {
                    markSessionViewed({ sessionSeq: blurVisibleSeq, activationId });
                });
            }

            endSessionViewingActivation(input.sessionId, activationId);
            if (viewingActivationIdRef.current === activationId) {
                viewingActivationIdRef.current = null;
            }
        };
    }, [clearDelayedMark, input.serverId, input.sessionId, input.surfaceFocused, markSessionViewed]));

    React.useEffect(() => {
        if (!input.surfaceFocused || !isFocusedRef.current) return;

        const visibleReadSeq = normalizeVisibleReadSeq(input.visibleReadSeq);
        if (visibleReadSeq === null) return;

        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= visibleReadSeq) return;
        const pending = pendingMarkRef.current;
        if (pending && pending.sessionSeq >= visibleReadSeq) return;
        if (shouldSuppressAutomaticMarkViewed({
            sessionId: input.sessionId,
            sessionSeq: visibleReadSeq,
            activationId: viewingActivationIdRef.current,
        })) {
            return;
        }

        clearDelayedMark();
        pendingMarkRef.current = { sessionSeq: visibleReadSeq };
        const activationId = viewingActivationIdRef.current;
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            pendingMarkRef.current = null;
            lastMarkedRef.current = { sessionSeq: visibleReadSeq };
            markSessionViewed({ sessionSeq: visibleReadSeq, activationId });
        }, SESSION_VIEWED_SEQ_CHANGE_MARK_DELAY_MS);

        return clearDelayedMark;
    }, [clearDelayedMark, input.sessionId, input.surfaceFocused, input.visibleReadSeq, markSessionViewed]);
}
