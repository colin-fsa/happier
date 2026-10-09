import { describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { fetchAndApplyMachines } from './syncMachines';

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

const credentials: AuthCredentials = { token: 'token', secret: 'secret' };
const machineRow = {
    id: 'machine-1',
    metadata: 'encrypted-metadata',
    metadataVersion: 3,
    daemonState: 'encrypted-daemon-state',
    daemonStateVersion: 7,
    dataEncryptionKey: null,
    seq: 1,
    active: true,
    activeAt: 10,
    revokedAt: null,
    createdAt: 1,
    updatedAt: 10,
};

function createHarness() {
    const decryptMetadata = vi.fn(async () => ({
        displayName: 'EnPassant',
        host: 'EnPassant',
        platform: 'win32',
        homeDir: 'C:\\Users\\user',
        happyCliVersion: '0.2.12',
        happyHomeDir: 'C:\\Users\\user\\.happier',
    }));
    const decryptDaemonState = vi.fn(async () => {
        throw new Error('invalid daemon-state ciphertext');
    });
    return {
        decryptMetadata,
        decryptDaemonState,
        encryption: {
            decryptEncryptionKeys: vi.fn(async (values: readonly string[]) => values.map(() => null)),
            initializeMachines: vi.fn(async () => {}),
            getMachineEncryption: () => ({ decryptMetadata, decryptDaemonState }),
        },
        request: vi.fn(async () => new Response(JSON.stringify([machineRow]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })),
    };
}

describe('machine metadata hydration when daemon-state decryption fails', () => {
    it('preserves the machine name in the fully awaited fetch path', async () => {
        const h = createHarness();
        const applied: Machine[][] = [];
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await fetchAndApplyMachines({
                credentials,
                encryption: h.encryption,
                machineDataKeys: new Map(),
                request: h.request,
                applyMachines: (machines) => { applied.push(machines); },
            });

            expect(h.decryptMetadata).toHaveBeenCalledWith(3, 'encrypted-metadata');
            expect(h.decryptDaemonState).toHaveBeenCalledWith(7, 'encrypted-daemon-state');
            expect(applied).toHaveLength(1);
            expect(applied[0]?.[0]).toMatchObject({
                id: 'machine-1',
                metadata: { displayName: 'EnPassant', host: 'EnPassant' },
                metadataVersion: 3,
                daemonState: null,
                daemonStateVersion: 0,
            });
            expect(consoleError).toHaveBeenCalledWith(
                'Failed to decrypt machine daemonState for machine-1:',
                expect.any(Error),
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it('eventually publishes the machine name during background display hydration', async () => {
        const h = createHarness();
        const applyMachines = vi.fn();
        const applyMachineDisplayEntries = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await fetchAndApplyMachines({
                credentials,
                encryption: h.encryption,
                machineDataKeys: new Map(),
                request: h.request,
                applyMachines,
                applyMachineDisplayEntries,
            });

            expect(applyMachineDisplayEntries).toHaveBeenCalledOnce();
            await vi.waitFor(() => {
                expect(applyMachines).toHaveBeenCalledWith([
                    expect.objectContaining({
                        id: 'machine-1',
                        metadata: expect.objectContaining({ displayName: 'EnPassant' }),
                        daemonState: null,
                    }),
                ], false);
            });
        } finally {
            consoleError.mockRestore();
        }
    });
});
