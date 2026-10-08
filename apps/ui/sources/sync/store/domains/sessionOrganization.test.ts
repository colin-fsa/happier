import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { SessionOrganizationSnapshot } from '@happier-dev/protocol';

import {
    buildSessionOrganizationOrderScopeKey,
    buildSessionOrganizationServerKey,
} from '@/sync/domains/session/organization';

import {
    createSessionOrganizationDomain,
    type SessionOrganizationDomain,
} from './sessionOrganization';

type State = SessionOrganizationDomain;

function createHarness() {
    const store = createStore<State>((set, get) => createSessionOrganizationDomain({ set, get }));
    return { get: store.getState, subscribe: store.subscribe };
}

function emptySnapshot(input: Partial<SessionOrganizationSnapshot> = {}): SessionOrganizationSnapshot {
    return {
        schemaVersion: 1,
        version: input.version ?? 1,
        pins: input.pins ?? [],
        folders: input.folders ?? [],
        folderAssignments: input.folderAssignments ?? [],
        tags: input.tags ?? [],
        tagAssignments: input.tagAssignments ?? [],
        orderEntries: input.orderEntries ?? [],
        labels: input.labels ?? [],
        attentionStandings: input.attentionStandings,
    };
}

describe('createSessionOrganizationDomain', () => {
    it.each([{ failureOrder: [0, 1] }, { failureOrder: [1, 0] }])('restores the due reminder when both overlapping writes fail in order $failureOrder', ({ failureOrder }) => {
        const harness = createHarness();
        const original = { sessionId: 's1', standing: true, remindAt: 1000, updatedAt: 1 };
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ attentionStandings: [original] }));
        const writes = [
            harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: true, updatedAt: 2 }),
            harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: true, remindAt: 2000, updatedAt: 3 }),
        ];
        for (const index of failureOrder) harness.get().rollbackSessionOrganizationOptimistic(writes[index]!);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey['srv-a:s1']).toEqual(original);
        expect(harness.get().sessionOrganizationOptimisticRecords).toEqual({});
    });

    it('preserves a newer confirmed reminder when an unrelated write and an older pending clear fail', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            attentionStandings: [{ sessionId: 's1', standing: false, remindAt: 1000, updatedAt: 1 }],
        }));
        const clear = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, updatedAt: 2 });
        const unrelated = harness.get().setSessionPinOptimistic('srv-a', 's2', { sessionId: 's2', pinnedAt: 3, sortKey: null });
        const latest = { sessionId: 's1', standing: false, remindAt: 2000, updatedAt: 4 };
        const replacement = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', latest);
        harness.get().confirmSessionAttentionStandingOptimistic(replacement, 's1', latest);
        harness.get().rollbackSessionOrganizationOptimistic(unrelated);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey['srv-a:s1']).toEqual(latest);
        harness.get().rollbackSessionOrganizationOptimistic(clear);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey['srv-a:s1']).toEqual(latest);
    });

    it('does not publish unchanged loading, error, assignment, or ignored reconciliation state', () => {
        const harness = createHarness();
        harness.get().setSessionOrganizationLoading('srv-a', false);
        harness.get().setSessionOrganizationError('srv-a', null);
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ version: 2 }));
        harness.get().applySessionFolderAssignments('srv-a', [{ sessionId: 's1', folderId: null }]);
        const before = harness.get();
        let notifications = 0;
        const unsubscribe = harness.subscribe(() => { notifications += 1; });
        harness.get().setSessionFolderAssignmentsLoading('srv-a', false);
        harness.get().setSessionOrganizationError('srv-a', null);
        harness.get().applySessionFolderAssignments('srv-a', [{ sessionId: 's1', folderId: null }]);
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ version: 1 }));
        harness.get().reconcileSessionOrganizationFolderDelete('srv-a', ['missing'], null);
        harness.get().reconcileSessionOrganizationTagDelete('srv-a', 'missing');
        harness.get().rollbackSessionOrganizationOptimistic('missing');
        harness.get().commitSessionOrganizationOptimistic('missing');
        expect(harness.get()).toBe(before);
        expect(notifications).toBe(0);

        harness.get().setSessionOrganizationLoading('srv-a', true);
        expect(harness.get().sessionOrganizationLoadingByServerId['srv-a']).toBe(true);
        expect(harness.get().sessionFolderAssignmentsLoadingByServerId['srv-a']).toBe(true);
        expect(notifications).toBe(1);
        unsubscribe();
    });

    it('keeps known sessions known when a full snapshot drops their folder assignment', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [
                { sessionId: 's1', folderId: 'folder-a' },
                { sessionId: 's2', folderId: 'folder-b' },
            ],
        }), { includeAllFolderAssignments: true });
        harness.get().applySessionOrganizationSnapshot('srv-b', emptySnapshot({
            version: 1,
            folderAssignments: [
                { sessionId: 'other', folderId: 'folder-other' },
            ],
        }), { includeAllFolderAssignments: true });

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [
                { sessionId: 's3', folderId: 'folder-c' },
            ],
        }), { includeAllFolderAssignments: true });

        // A full snapshot is authoritative for its server: the sessions it omits are
        // known to have no folder, so they stay known (null) instead of reverting to
        // "never fetched" and re-arming a per-session assignment request.
        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's2')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's3')]: 'folder-c',
            [buildSessionOrganizationServerKey('srv-b', 'other')]: 'folder-other',
        });
        expect(harness.get().sessionFolderAssignmentsBySessionKey)
            .toBe(harness.get().sessionOrganizationFolderAssignmentsBySessionKey);
    });

    it('keeps the folder assignment record referentially stable when a full snapshot changes nothing', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }), { includeAllFolderAssignments: true });
        harness.get().applySessionFolderAssignments('srv-a', [{ sessionId: 's2', folderId: null }]);
        const before = harness.get().sessionOrganizationFolderAssignmentsBySessionKey;

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }), { includeAllFolderAssignments: true });

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toBe(before);
    });

    it('clears requested folder assignments that are absent from a scoped snapshot', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            folderAssignments: [
                { sessionId: 's1', folderId: 'folder-old' },
                { sessionId: 's2', folderId: 'folder-old' },
                { sessionId: 's3', folderId: 'folder-untouched' },
            ],
        }), { includeAllFolderAssignments: true });

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            folderAssignments: [
                { sessionId: 's1', folderId: 'folder-new' },
            ],
        }), { assignmentSessionIds: ['s1', 's2'] });

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: 'folder-new',
            [buildSessionOrganizationServerKey('srv-a', 's2')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's3')]: 'folder-untouched',
        });
        expect(harness.get().sessionFolderAssignmentsBySessionKey)
            .toBe(harness.get().sessionOrganizationFolderAssignmentsBySessionKey);
    });

    it('removes requested tag ids from stale scoped tag assignments', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 1,
            tagAssignments: [
                { sessionId: 's1', tagIds: ['tag-a', 'tag-b'] },
                { sessionId: 's2', tagIds: ['tag-a'] },
            ],
        }), { includeAllTagAssignments: true });

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            tagAssignments: [
                { sessionId: 's2', tagIds: ['tag-a'] },
            ],
        }), { tagIds: ['tag-a'] });

        expect(harness.get().sessionOrganizationTagAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: ['tag-b'],
            [buildSessionOrganizationServerKey('srv-a', 's2')]: ['tag-a'],
        });
    });

    it('reconciles deleted folder assignments in both canonical and compatibility maps', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            folderAssignments: [
                { sessionId: 's1', folderId: 'deleted-folder' },
                { sessionId: 's2', folderId: 'kept-folder' },
            ],
        }), { includeAllFolderAssignments: true });

        harness.get().reconcileSessionOrganizationFolderDelete('srv-a', ['deleted-folder'], null);

        expect(harness.get().sessionOrganizationFolderAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: null,
            [buildSessionOrganizationServerKey('srv-a', 's2')]: 'kept-folder',
        });
        expect(harness.get().sessionFolderAssignmentsBySessionKey)
            .toBe(harness.get().sessionOrganizationFolderAssignmentsBySessionKey);
    });

    it('rebases later optimistic tag-assignment writes when rolling back an earlier write', () => {
        const harness = createHarness();

        const firstRecordId = harness.get().setSessionTagAssignmentsOptimistic('srv-a', 's1', ['tag-a']);
        const secondRecordId = harness.get().setSessionTagAssignmentsOptimistic('srv-a', 's1', ['tag-a', 'tag-b']);

        harness.get().rollbackSessionOrganizationOptimistic(firstRecordId);

        expect(harness.get().sessionOrganizationTagAssignmentsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: ['tag-a', 'tag-b'],
        });
        expect(Object.keys(harness.get().sessionOrganizationOptimisticRecords)).toEqual([secondRecordId]);
    });

    it('clears only the requested order scope when scoped order entries are empty', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            orderEntries: [
                { scopeKind: 'group', scopeKey: 'root', itemKind: 'session', itemKey: 's1', sortKey: 'a' },
                { scopeKind: 'workspace', scopeKey: 'workspace-a', itemKind: 'workspace', itemKey: 'workspace-a:/repo', sortKey: 'a' },
            ],
        }), {
            orderScopes: [
                { scopeKind: 'group', scopeKey: 'root' },
                { scopeKind: 'workspace', scopeKey: 'workspace-a' },
            ],
        });

        const recordId = harness.get().applySessionOrganizationOrderScopeOptimistic('srv-a', {
            scopeKind: 'group',
            scopeKey: 'root',
            entries: [],
        });
        harness.get().commitSessionOrganizationOptimistic(recordId);

        expect(harness.get().sessionOrganizationOrderEntriesByScopeKey).toEqual({
            [buildSessionOrganizationOrderScopeKey({ serverId: 'srv-a', scopeKind: 'group', scopeKey: 'root' })]: [],
            [buildSessionOrganizationOrderScopeKey({ serverId: 'srv-a', scopeKind: 'workspace', scopeKey: 'workspace-a' })]: [
                { scopeKind: 'workspace', scopeKey: 'workspace-a', itemKind: 'workspace', itemKey: 'workspace-a:/repo', sortKey: 'a' },
            ],
        });
    });
    it('restores the previous attention standing when an optimistic write is rolled back', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            attentionStandings: [{ sessionId: 's1', standing: true, updatedAt: 1 }],
        }));

        const recordId = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, updatedAt: 2 });
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey[buildSessionOrganizationServerKey('srv-a', 's1')])
            .toEqual({ sessionId: 's1', standing: false, updatedAt: 2 });

        harness.get().rollbackSessionOrganizationOptimistic(recordId);

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: { sessionId: 's1', standing: true, updatedAt: 1 },
        });
    });

    it('lands snapshot attention standings and keeps them when a later snapshot omits the field', () => {
        const harness = createHarness();
        const recordId = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, updatedAt: 1 });
        harness.get().commitSessionOrganizationOptimistic(recordId);

        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            version: 2,
            attentionStandings: [{ sessionId: 's1', standing: true, updatedAt: 5 }],
        }));

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: { sessionId: 's1', standing: true, updatedAt: 5 },
        });

        // The snapshot only carries standings when the request asked for them, so an
        // omitted field means "not fetched" rather than "no standings".
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({ version: 3 }));

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-a', 's1')]: { sessionId: 's1', standing: true, updatedAt: 5 },
        });
    });

    it('rebases a pending replacement on the confirmed reminder clear before rollback', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            attentionStandings: [{ sessionId: 's1', standing: false, remindAt: 1000, updatedAt: 1 }],
        }));
        const clear = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, updatedAt: 2 });
        const replacement = harness.get().setSessionAttentionStandingOptimistic('srv-a', 's1', { sessionId: 's1', standing: false, remindAt: 2000, updatedAt: 3 });
        harness.get().confirmSessionAttentionStandingOptimistic(clear, 's1', { sessionId: 's1', standing: true, updatedAt: 4 });
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey['srv-a:s1']?.remindAt).toBe(2000);
        harness.get().rollbackSessionOrganizationOptimistic(replacement);
        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey['srv-a:s1'])
            .toEqual({ sessionId: 's1', standing: true, updatedAt: 4 });
    });

    it('clears attention standings for one server without touching another server', () => {
        const harness = createHarness();
        harness.get().applySessionOrganizationSnapshot('srv-a', emptySnapshot({
            attentionStandings: [{ sessionId: 's1', standing: true, updatedAt: 1 }],
        }));
        harness.get().applySessionOrganizationSnapshot('srv-b', emptySnapshot({
            attentionStandings: [{ sessionId: 's1', standing: true, updatedAt: 2 }],
        }));

        harness.get().clearSessionOrganizationForServer('srv-a');

        expect(harness.get().sessionOrganizationAttentionStandingsBySessionKey).toEqual({
            [buildSessionOrganizationServerKey('srv-b', 's1')]: { sessionId: 's1', standing: true, updatedAt: 2 },
        });
    });
});
