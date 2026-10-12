import {
    areSessionListRenderablesEqual,
    applySessionListRenderablePatch,
    didSessionListRenderableAttentionPromotionFieldsChange,
    didSessionListRenderablePlacementRelevantTimingChange,
    didSessionListRenderableStructuralFieldsChange,
    didSessionListRenderableWarmCacheFieldsChange,
    isSessionListRenderableWarmCacheProgressOnlyChange,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    type SessionListRenderablePatchFields,
    type SessionListRenderableSession,
} from '../../domains/session/listing/sessionListRenderable';

export type SessionListRenderablePatch = Readonly<{
    sessionId: string;
    patch: SessionListRenderablePatchFields;
}>;

export type SessionListRenderableReplacementOptions = Readonly<{
    /** The response has no further page, so it is authoritative for every row it omits. */
    coversWholeList?: boolean;
}>;

/**
 * Inclusive floor, on the server list ordering key (`meaningfulActivityAt desc, id
 * desc`), of the range a session-list response actually covers.
 *
 * A replacement response is only authoritative about the range it covers: inside it,
 * an omitted row is genuinely gone (archived, or deleted while the client was away);
 * below it, an omitted row is simply a row the page did not reach — typically one the
 * user paged in. Evicting those was deleting the user's paged-in list on every
 * foreground refresh and forcing a full view-data rebuild plus warm-cache rewrite.
 *
 * `null` means the response covers the whole list, so every omitted row is evicted.
 */
export type SessionListRenderableRemovalWindow = Readonly<{
    meaningfulActivityAt: number;
}>;

function resolveRenderableOrderingActivityAt(renderable: SessionListRenderableSession): number {
    return typeof renderable.meaningfulActivityAt === 'number'
        ? renderable.meaningfulActivityAt
        : renderable.createdAt;
}

/**
 * Derives the covered range from the response itself. The session-list response is
 * emitted in server order — supplementary rows (active, pinned, attention) first, then
 * the ordered page — so its last row is the oldest row the ordered page reached.
 *
 * A supplementary row landing last only raises the floor, which retains more rows than
 * strictly necessary. Retention is not free: the list endpoint omits archived rows, so a
 * retained row archived elsewhere keeps its stale state. Callers therefore skip the window
 * when the response has no further page and covers the whole list.
 */
export function resolveSessionListRenderableRemovalWindow(
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>,
): SessionListRenderableRemovalWindow | null {
    const oldestCoveredRow = incomingRenderables[incomingRenderables.length - 1];
    if (!oldestCoveredRow) return null;
    return { meaningfulActivityAt: resolveRenderableOrderingActivityAt(oldestCoveredRow) };
}

/**
 * The floor itself stays inside the window: rows sharing the oldest covered activity
 * time are evicted exactly as an unwindowed replacement would evict them, so this
 * change only ever spares rows the page provably did not reach.
 */
function isRenderableInsideRemovalWindow(
    renderable: SessionListRenderableSession,
    window: SessionListRenderableRemovalWindow,
): boolean {
    return resolveRenderableOrderingActivityAt(renderable) >= window.meaningfulActivityAt;
}

export type SessionListRenderableStoreUpdatePlan = Readonly<{
    nextRenderables: Record<string, SessionListRenderableSession>;
    noop: boolean;
    changedCount: number;
    removedCount: number;
    changedSessionIds: readonly string[];
    removedSessionIds: readonly string[];
    missingCount: number;
    noopPatchCount: number;
    listViewFieldChangeCount: number;
    listViewRowRefreshSessionIds: readonly string[];
    attentionPromotionFieldChangeCount: number;
    staleMetadataPreservedCount: number;
    stalePendingFlagsPreservedCount: number;
    needsSessionListViewDataRebuild: boolean;
    didWarmCacheRelevantRenderableChange: boolean;
    didImmediateWarmCacheRelevantRenderableChange: boolean;
    didDeferredWarmCacheRelevantRenderableChange: boolean;
}>;

type DidListViewFieldsChange = (
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
) => boolean;

type DidListViewRowFieldsChange = (
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
) => boolean;

function didPreserveMetadata(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    return incoming.metadata == null
        && previous?.metadata != null
        && next.metadata === previous.metadata
        && next.metadataVersion === previous.metadataVersion;
}

function didPreservePendingFlags(
    previous: SessionListRenderableSession | undefined,
    incoming: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    return incoming.active === true
        && typeof incoming.hasPendingPermissionRequests !== 'boolean'
        && typeof incoming.hasPendingUserActionRequests !== 'boolean'
        && next.agentStateVersion === previous.agentStateVersion
        && (
            next.hasPendingPermissionRequests === previous.hasPendingPermissionRequests
            || next.hasPendingUserActionRequests === previous.hasPendingUserActionRequests
        );
}

export type SessionListRenderableChangeAssessment = Readonly<{
    didListViewFieldsChange: boolean;
    didAttentionPromotionFieldsChange: boolean;
    shouldRefreshListViewRow: boolean;
    needsSessionListViewDataRebuild: boolean;
    warmCacheChange: 'none' | 'immediate' | 'deferred';
}>;

/**
 * Single owner of the per-renderable change decisions (structural rebuild,
 * attention/placement rebuild, row refresh, warm-cache classification).
 * Consumed by the plan functions below AND by the applySessions inline loop
 * in `domains/sessions.ts` — the two ingestion orchestrations differ, but the
 * decisions for one renderable change must never diverge between them.
 */
export function assessSessionListRenderableChange(input: Readonly<{
    previous: SessionListRenderableSession | undefined;
    next: SessionListRenderableSession;
    rebuildOnAttentionPromotionFieldsChange: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableChangeAssessment {
    const didListViewFieldsChange = input.didListViewFieldsChange
        ? input.didListViewFieldsChange(input.previous, input.next)
        : didSessionListRenderableStructuralFieldsChange(input.previous, input.next);
    const didListViewRowFieldsChange = input.didListViewRowFieldsChange
        ? input.didListViewRowFieldsChange(input.previous, input.next)
        : false;
    const didAttentionPromotionFieldsChange = didSessionListRenderableAttentionPromotionFieldsChange(
        input.previous,
        input.next,
    );
    const shouldRefreshListViewRow = resolveShouldRefreshListViewRow({
        previous: input.previous,
        next: input.next,
        didListViewFieldsChange,
        didListViewRowFieldsChange,
        didAttentionPromotionFieldsChange,
        placementGroupingEnabled: input.rebuildOnAttentionPromotionFieldsChange,
    });

    const warmCacheChange = !didSessionListRenderableWarmCacheFieldsChange(input.previous, input.next)
        ? 'none'
        : !didListViewFieldsChange
            && !didAttentionPromotionFieldsChange
            && (
                isSessionListRenderableWarmCacheProgressOnlyChange(input.previous, input.next)
            )
            ? 'deferred'
            : 'immediate';

    return {
        didListViewFieldsChange,
        didAttentionPromotionFieldsChange,
        shouldRefreshListViewRow,
        needsSessionListViewDataRebuild: didListViewFieldsChange
            || (input.rebuildOnAttentionPromotionFieldsChange && didAttentionPromotionFieldsChange),
        warmCacheChange,
    };
}

function resolveShouldRefreshListViewRow(input: Readonly<{
    previous: SessionListRenderableSession | undefined;
    next: SessionListRenderableSession;
    didListViewFieldsChange: boolean;
    didListViewRowFieldsChange: boolean;
    didAttentionPromotionFieldsChange: boolean;
    placementGroupingEnabled: boolean;
}>): boolean {
    if (input.didListViewFieldsChange) return false;
    if (input.didListViewRowFieldsChange) return true;
    // Timing-only placement changes (extended working windows, refreshed
    // retention inputs) skip the structural rebuild but must still reach the
    // committed view data so the UI re-evaluates placement against fresh
    // timestamps instead of demoting at a stale freshness expiry. Instant
    // placement changes are the rebuild gate's business, and with placement
    // grouping disabled the committed list does not consume placement at all.
    if (!input.placementGroupingEnabled || input.didAttentionPromotionFieldsChange) return false;
    return didSessionListRenderablePlacementRelevantTimingChange(input.previous, input.next);
}

function planSessionListRenderableIncomingRows(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
    shouldRemoveOmittedPreviousRenderable: ((previous: SessionListRenderableSession) => boolean) | null;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    const previousRenderables = input.previousRenderables;
    const previousIds = Object.keys(previousRenderables);
    const incomingIds = new Set<string>();
    let nextRenderables = previousRenderables;
    let didAnyRenderableChange = false;
    let changedCount = 0;
    let removedCount = 0;
    const changedSessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    let listViewFieldChangeCount = 0;
    const listViewRowRefreshSessionIds: string[] = [];
    let attentionPromotionFieldChangeCount = 0;
    let staleMetadataPreservedCount = 0;
    let stalePendingFlagsPreservedCount = 0;
    let needsSessionListViewDataRebuild = input.isSessionListViewDataUninitialized;
    let didImmediateWarmCacheRelevantRenderableChange = false;
    let didDeferredWarmCacheRelevantRenderableChange = false;

    for (const incomingRenderable of input.incomingRenderables) {
        incomingIds.add(incomingRenderable.id);
        const previousRenderable = previousRenderables[incomingRenderable.id];
        const stalePreservedRenderable = preserveSessionListRenderableStaleFields(previousRenderable, incomingRenderable);
        const nextRenderableBase = preserveSessionListRenderableTransientState(
            previousRenderable,
            stalePreservedRenderable,
        );
        const nextRenderable = areSessionListRenderablesEqual(previousRenderable, nextRenderableBase)
            ? previousRenderable
            : nextRenderableBase;

        if (didPreserveMetadata(previousRenderable, incomingRenderable, nextRenderable)) {
            staleMetadataPreservedCount += 1;
        }
        if (didPreservePendingFlags(previousRenderable, incomingRenderable, nextRenderable)) {
            stalePendingFlagsPreservedCount += 1;
        }

        const assessment = assessSessionListRenderableChange({
            previous: previousRenderable,
            next: nextRenderable,
            rebuildOnAttentionPromotionFieldsChange: input.rebuildOnAttentionPromotionFieldsChange === true,
            didListViewFieldsChange: input.didListViewFieldsChange,
            didListViewRowFieldsChange: input.didListViewRowFieldsChange,
        });

        if (!previousRenderable || nextRenderable !== previousRenderable) {
            didAnyRenderableChange = true;
            changedCount += 1;
            changedSessionIds.push(incomingRenderable.id);
            if (assessment.didListViewFieldsChange) {
                listViewFieldChangeCount += 1;
            }
            if (assessment.shouldRefreshListViewRow) {
                listViewRowRefreshSessionIds.push(incomingRenderable.id);
            }
            if (assessment.didAttentionPromotionFieldsChange) {
                attentionPromotionFieldChangeCount += 1;
            }
            if (assessment.warmCacheChange === 'deferred') {
                didDeferredWarmCacheRelevantRenderableChange = true;
            } else if (assessment.warmCacheChange === 'immediate') {
                didImmediateWarmCacheRelevantRenderableChange = true;
            }
            if (nextRenderables === previousRenderables) {
                nextRenderables = { ...previousRenderables };
            }
            nextRenderables[incomingRenderable.id] = nextRenderable;
        }

        if (!needsSessionListViewDataRebuild && assessment.needsSessionListViewDataRebuild) {
            needsSessionListViewDataRebuild = true;
        }
    }

    const shouldRemoveOmittedPreviousRenderable = input.shouldRemoveOmittedPreviousRenderable;
    if (shouldRemoveOmittedPreviousRenderable) {
        for (const sessionId of previousIds) {
            if (incomingIds.has(sessionId)) continue;
            if (!shouldRemoveOmittedPreviousRenderable(previousRenderables[sessionId])) continue;
            if (nextRenderables === previousRenderables) {
                nextRenderables = { ...previousRenderables };
            }
            delete nextRenderables[sessionId];
            removedCount += 1;
            removedSessionIds.push(sessionId);
            didAnyRenderableChange = true;
            didImmediateWarmCacheRelevantRenderableChange = true;
            needsSessionListViewDataRebuild = true;
        }
    }

    return {
        nextRenderables,
        noop: !didAnyRenderableChange && !needsSessionListViewDataRebuild,
        changedCount,
        removedCount,
        changedSessionIds,
        removedSessionIds,
        missingCount: 0,
        noopPatchCount: 0,
        listViewFieldChangeCount,
        listViewRowRefreshSessionIds,
        attentionPromotionFieldChangeCount,
        staleMetadataPreservedCount,
        stalePendingFlagsPreservedCount,
        needsSessionListViewDataRebuild,
        didWarmCacheRelevantRenderableChange: didImmediateWarmCacheRelevantRenderableChange || didDeferredWarmCacheRelevantRenderableChange,
        didImmediateWarmCacheRelevantRenderableChange,
        didDeferredWarmCacheRelevantRenderableChange,
    };
}

export function planSessionListRenderableReplacement(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
    removalWindow?: SessionListRenderableRemovalWindow | null;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    const removalWindow = input.removalWindow ?? null;
    return planSessionListRenderableIncomingRows({
        ...input,
        shouldRemoveOmittedPreviousRenderable: removalWindow
            ? (previous) => isRenderableInsideRemovalWindow(previous, removalWindow)
            : () => true,
    });
}

export function planSessionListRenderableMerge(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    incomingRenderables: ReadonlyArray<SessionListRenderableSession>;
    isSessionListViewDataUninitialized: boolean;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    return planSessionListRenderableIncomingRows({
        ...input,
        shouldRemoveOmittedPreviousRenderable: null,
    });
}

export function planSessionListRenderablePatches(input: Readonly<{
    previousRenderables: Record<string, SessionListRenderableSession>;
    patches: ReadonlyArray<SessionListRenderablePatch>;
    isSessionListViewDataUninitialized: boolean;
    rebuildOnAttentionPromotionFieldsChange?: boolean;
    didListViewFieldsChange?: DidListViewFieldsChange;
    didListViewRowFieldsChange?: DidListViewRowFieldsChange;
}>): SessionListRenderableStoreUpdatePlan {
    const previousRenderables = input.previousRenderables;
    let nextRenderables = previousRenderables;
    let changedCount = 0;
    const changedSessionIds: string[] = [];
    let missingCount = 0;
    let noopPatchCount = 0;
    let listViewFieldChangeCount = 0;
    const listViewRowRefreshSessionIds: string[] = [];
    let attentionPromotionFieldChangeCount = 0;
    let needsSessionListViewDataRebuild = input.isSessionListViewDataUninitialized;
    let didImmediateWarmCacheRelevantRenderableChange = false;
    let didDeferredWarmCacheRelevantRenderableChange = false;

    for (const { sessionId, patch } of input.patches) {
        const previousRenderable = nextRenderables[sessionId];
        if (!previousRenderable) {
            missingCount += 1;
            continue;
        }

        const nextRenderable = applySessionListRenderablePatch(previousRenderable, patch);

        if (areSessionListRenderablesEqual(previousRenderable, nextRenderable)) {
            noopPatchCount += 1;
            continue;
        }

        changedCount += 1;
        changedSessionIds.push(sessionId);
        const assessment = assessSessionListRenderableChange({
            previous: previousRenderable,
            next: nextRenderable,
            rebuildOnAttentionPromotionFieldsChange: input.rebuildOnAttentionPromotionFieldsChange === true,
            didListViewFieldsChange: input.didListViewFieldsChange,
            didListViewRowFieldsChange: input.didListViewRowFieldsChange,
        });
        if (assessment.didListViewFieldsChange) {
            listViewFieldChangeCount += 1;
        }
        if (assessment.shouldRefreshListViewRow) {
            listViewRowRefreshSessionIds.push(sessionId);
        }
        if (assessment.didAttentionPromotionFieldsChange) {
            attentionPromotionFieldChangeCount += 1;
        }
        if (assessment.warmCacheChange === 'deferred') {
            didDeferredWarmCacheRelevantRenderableChange = true;
        } else if (assessment.warmCacheChange === 'immediate') {
            didImmediateWarmCacheRelevantRenderableChange = true;
        }

        if (!needsSessionListViewDataRebuild && assessment.needsSessionListViewDataRebuild) {
            needsSessionListViewDataRebuild = true;
        }

        if (nextRenderables === previousRenderables) {
            nextRenderables = { ...previousRenderables };
        }
        nextRenderables[sessionId] = nextRenderable;
    }

    return {
        nextRenderables,
        noop: nextRenderables === previousRenderables && !needsSessionListViewDataRebuild,
        changedCount,
        removedCount: 0,
        changedSessionIds,
        removedSessionIds: [],
        missingCount,
        noopPatchCount,
        listViewFieldChangeCount,
        listViewRowRefreshSessionIds,
        attentionPromotionFieldChangeCount,
        staleMetadataPreservedCount: 0,
        stalePendingFlagsPreservedCount: 0,
        needsSessionListViewDataRebuild,
        didWarmCacheRelevantRenderableChange: didImmediateWarmCacheRelevantRenderableChange || didDeferredWarmCacheRelevantRenderableChange,
        didImmediateWarmCacheRelevantRenderableChange,
        didDeferredWarmCacheRelevantRenderableChange,
    };
}
