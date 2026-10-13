import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { resetReactNativeMmkvStub } from '@/dev/testkit/mocks/mmkv';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { loadPendingAccountSettings, saveAccountSettings, savePendingAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { markLegacySessionOrganizationImportComplete } from './legacySessionOrganizationImport';
import { syncSettings } from './syncSettings';

const http = vi.hoisted(() => vi.fn<(path: string, init?: RequestInit) => Promise<Response>>());
vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    serverFetch: (path: string, init?: RequestInit) => http(path, init),
}));

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('settings sync pending projection', () => {
    const scope = { serverId: 'server-a', accountId: 'account-a' };
    beforeEach(() => {
        resetReactNativeMmkvStub();
        invalidateAccountEncryptionModeCache();
        http.mockReset();
        storage.getState().clearSettingsScope();
    });

    it.each(['GET', 'POST'] as const)('preserves an unflushed local edit while an account settings %s is pending', async (heldMethod) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const incoming = structuredClone(settingsDefaults);
        incoming.voice.adapters.local_conversation.stt.fallbackToDevice = true;
        saveAccountSettings(scope, incoming, 317);
        storage.getState().activateSettingsScope(scope);
        markLegacySessionOrganizationImportComplete(scope);
        let pending: Partial<Settings> = heldMethod === 'POST' ? { analyticsOptOut: true } : {};
        savePendingAccountSettings(scope, pending);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let reached!: () => void;
        const requestReached = new Promise<void>((resolve) => { reached = resolve; });
        http.mockImplementation(async (path, init) => {
            if (path === '/v1/account/encryption') return jsonResponse({ mode: 'e2ee', updatedAt: 0 });
            if (path !== '/v2/account/settings') throw new Error(`Unexpected HTTP request: ${path}`);
            const method = init?.method ?? 'GET';
            if (method === heldMethod) { reached(); await held; }
            if (method === 'POST') return jsonResponse({ success: true, version: 318 });
            return jsonResponse({ content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: 'account_settings', material: { type: 'dataKey', machineKey: encryption.getContentPrivateKey() },
                payload: incoming, randomBytes: getRandomBytes,
            }) }, version: 317 });
        });
        const params = {
            credentials: { token: 'test-token', secret: 'test-secret' }, encryption, settingsScope: scope,
            pendingSettings: { ...pending },
            getPendingSettings: () => pending,
            clearPendingSettings: (next: Partial<Settings>) => { pending = next; savePendingAccountSettings(scope, next); },
        };
        const syncing = syncSettings(params);
        await requestReached;
        const voice = structuredClone(incoming.voice);
        voice.adapters.local_conversation.tts.fallbackToDevice = true;
        storage.getState().applySettingsLocal({ voice });
        pending = { ...pending, voice };
        // The existing UI debounce has not flushed this new pending delta to MMKV yet.
        expect(loadPendingAccountSettings(scope).voice).toBeUndefined();
        release();
        await syncing;
        expect(storage.getState().settings.voice.adapters.local_conversation.tts.fallbackToDevice).toBe(true);
        expect(pending.voice?.adapters.local_conversation.tts.fallbackToDevice).toBe(true);
    });
});
