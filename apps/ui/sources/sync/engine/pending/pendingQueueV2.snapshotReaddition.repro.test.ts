import { beforeEach, describe, expect, it } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    updatePendingRequestedActionV2,
} from './pendingQueueV2';
import {
    buildSession,
    resetPendingQueueState,
    withExactPendingEnqueueAckIdentityForTest,
} from './pendingQueueV2.testHelpers';

/**
 * Snapshot ordering contracts: commits above the capture sequence must not restore a settled row;
 * older committed twins can coexist with durable pending rows. A changed transcript or local edit
 * starts a fresh read, while callers with unchanged freshness share the complete refresh.
 */

const SESSION_ID = 'readdition-session';
const LOCAL_ID = 'readdition-local';
/** Ordering F: a row the server already held when the shared pre-ACK read was taken. */
const SEED_LOCAL_ID = 'readdition-seed-local';
/** Ordering F: the utterance the server ACKs while that read is outstanding. */
const ACCEPTED_LOCAL_ID = 'readdition-accepted-local';
/** The session tail this client had already loaded before any request below was issued. */
const LOADED_HEAD_SEQ = 6;

const REPUBLISHED_ROW = {
    localId: LOCAL_ID,
    source: 'server_pending',
    pendingDeliveryStatus: 'server_queued',
    scoped: false,
} as const;

function committedTwin(localId: string | null, seq = LOADED_HEAD_SEQ + 1) {
    return {
        id: `committed-${localId ?? 'none'}-${seq}`,
        seq,
        localId,
        createdAt: 2_000,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: 'hello' },
    } as any;
}

function queuedRowResponse(localId: string): Response {
    return new Response(JSON.stringify({
        pending: [{
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text: 'hello' }, meta: {} },
            },
            requestedAction: { v: 1, kind: 'enqueue' },
            status: 'queued',
            deliveryState: 'queued',
            position: 0,
            createdAt: 1_000,
            updatedAt: 1_100,
            discardedAt: null,
            discardedReason: null,
        }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function publishedPending(): Array<Readonly<{
    localId: string;
    source: PendingMessage['source'];
    pendingDeliveryStatus: PendingMessage['pendingDeliveryStatus'];
    scoped: boolean;
}>> {
    return (storage.getState().sessionPending[SESSION_ID]?.messages ?? []).map((message: PendingMessage) => ({
        localId: message.localId ?? message.id,
        source: message.source,
        pendingDeliveryStatus: message.pendingDeliveryStatus,
        scoped: message.pendingOutboxScope !== undefined,
    }));
}

function publishedLocalIds(): string[] {
    return publishedPending().map((message) => message.localId);
}

describe('pending snapshot re-addition after a committed twin', () => {
    beforeEach(() => resetPendingQueueState());

    function armSession() {
        const server = upsertServerProfile({ serverUrl: 'https://readdition.example.test', name: 'Readdition' });
        storage.getState().applySessions([{
            ...buildSession({ sessionId: SESSION_ID }),
            encryptionMode: 'plain',
            seq: LOADED_HEAD_SEQ,
        }]);
        // The flap was measured on an OPEN session with its transcript loaded; the fence asserts
        // nothing until the transcript is a basis, so the loaded tail is part of the flap's shape.
        storage.getState().applyMessages(SESSION_ID, [committedTwin('readdition-loaded-tail', LOADED_HEAD_SEQ)]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        return { serverId: server.id, accountId: 'account' } as const;
    }


    it('withholds a row whose twin commits while the request is outstanding', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await gate; return queuedRowResponse(LOCAL_ID); },
        });
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        release();
        await refresh;

        expect(publishedPending()).toEqual([]);
    });


    it('withholds a row whose twin commits between the response and the publish', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });
        await Promise.resolve();
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        await refresh;

        expect(publishedPending()).toEqual([]);
    });


    it('republishes a row whose twin was already committed at capture', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });

        expect(publishedPending()).toEqual([REPUBLISHED_ROW]);
    });


    it('uses a fresh read when the transcript changes during an outstanding refresh', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        // Hold the old read while the successor requests current server truth.
        const sharedRead = (async () => { await gate; return queuedRowResponse(LOCAL_ID); })();
        let reads = 0;
        const request = async (_path: string, init?: RequestInit) => {
            expect(init?.cache).toBe('no-store');
            return ++reads === 1 ? (await sharedRead).clone() : Response.json({ pending: [] });
        };

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request,
        });
        // Transcript repair must issue a fresh read even if the pending-version receipt is lost.
        release();
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request,
        });
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([]);
    });



    it('preserves an in-flight acceptance when callers share an unchanged refresh', async () => {
        const scope = armSession();
        const isCurrent = () => true;
        setActiveServerId(scope.serverId, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        // One server read, shared by both refreshes — the in-flight de-dupe, modelled. It was read
        // BEFORE the enqueue below was accepted, so it lists only the row that already existed.
        const sharedRead = (async () => { await gate; return queuedRowResponse(SEED_LOCAL_ID); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: isCurrent,
            request: dedupedRequest,
        });

        // The user sends while that read is outstanding and the server ACKs the enqueue.
        await enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: ACCEPTED_LOCAL_ID,
            text: 'accepted while the snapshot read was outstanding',
            encryption,
            outboxScope: scope,
            requestedAction: { v: 1, kind: 'enqueue' },
            wireMode: 'pending_input_v1',
            request: withExactPendingEnqueueAckIdentityForTest(
                async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
            ),
        });
        expect(publishedLocalIds()).toEqual([ACCEPTED_LOCAL_ID]);

        // With no new receipt or transcript, both callers retain the same ACK fence.
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: isCurrent,
            request: dedupedRequest,
        });
        release();
        await Promise.all([first, second]);

        expect(publishedLocalIds()).toEqual([ACCEPTED_LOCAL_ID]);
    });


    it('keeps a localId accepted in flight when a requested-action PATCH invalidates the refresh', async () => {
        const scope = armSession();
        setActiveServerId(scope.serverId, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowResponse(SEED_LOCAL_ID); })();
        let reads = 0;
        const request = async (_path: string, init?: RequestInit) => {
            expect(init?.cache).toBe('no-store');
            return ++reads === 1 ? (await sharedRead).clone() : queuedRowResponse(ACCEPTED_LOCAL_ID);
        };

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request,
        });

        await enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: ACCEPTED_LOCAL_ID,
            text: 'accepted while the snapshot read was outstanding',
            encryption,
            outboxScope: scope,
            requestedAction: { v: 1, kind: 'enqueue' },
            wireMode: 'pending_input_v1',
            request: withExactPendingEnqueueAckIdentityForTest(
                async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
            ),
        });
        expect(publishedLocalIds()).toEqual([ACCEPTED_LOCAL_ID]);

        // The user changes the queued row's requested action while that read is still outstanding.
        await updatePendingRequestedActionV2({
            sessionId: SESSION_ID,
            localId: ACCEPTED_LOCAL_ID,
            requestedAction: { v: 1, kind: 'steer_now' },
            outboxScope: scope,
            wireMode: 'pending_input_v1',
            request: async () => Response.json({ didUpdate: true }),
        });

        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request,
        });
        release();
        await Promise.all([first, second]);

        expect(publishedLocalIds()).toContain(ACCEPTED_LOCAL_ID);
    });


    it('withholds a settled row for a refresh registered after a requested-action PATCH', async () => {
        const scope = armSession();
        setActiveServerId(scope.serverId, { scope: 'tab' });
        storage.getState().activateProfileScope(scope);
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        // Accepted BEFORE any refresh is registered, so nothing is recorded on a refresh token and
        // the accepted-localId fence stays out of this ordering entirely.
        await enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: LOCAL_ID,
            text: 'queued before the refresh',
            encryption,
            outboxScope: scope,
            requestedAction: { v: 1, kind: 'enqueue' },
            wireMode: 'pending_input_v1',
            request: withExactPendingEnqueueAckIdentityForTest(
                async () => Response.json({ requestedAction: { v: 1, kind: 'enqueue' } }),
            ),
        });

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowResponse(LOCAL_ID); })();
        let reads = 0;
        const request = async (_path: string, init?: RequestInit) => {
            expect(init?.cache).toBe('no-store');
            return ++reads === 1 ? (await sharedRead).clone() : Response.json({ pending: [] });
        };

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request,
        });

        await updatePendingRequestedActionV2({
            sessionId: SESSION_ID,
            localId: LOCAL_ID,
            requestedAction: { v: 1, kind: 'steer_now' },
            outboxScope: scope,
            wireMode: 'pending_input_v1',
            request: async () => Response.json({ didUpdate: true }),
        });

        // The settlement lands while that read is still outstanding.
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request,
        });
        release();
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([]);
    });

    it('preserves durable coexistence when an older transcript page triggers a fresh read', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await gate; return queuedRowResponse(LOCAL_ID); },
        });
        // Learned during the request (an older page, a backfill), sequenced below the loaded tail.
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID, LOADED_HEAD_SEQ - 3)]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });
        release();
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([REPUBLISHED_ROW]);
    });
});
