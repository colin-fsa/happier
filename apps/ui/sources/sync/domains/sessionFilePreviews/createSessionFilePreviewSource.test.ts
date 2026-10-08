import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';

const downloadDaemonSessionFileToDestination = vi.hoisted(() => vi.fn());
const nativeFileSystem = vi.hoisted(() => ({
    writes: [] as Uint8Array[],
    makeDirectoryAsync: vi.fn(async () => {
        throw new Error('legacy makeDirectoryAsync must not be used');
    }),
    directoryCreate: vi.fn(),
    close: vi.fn(),
    delete: vi.fn(),
}));
const originalPlatformOS = Platform.OS;

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline', () => ({
    downloadDaemonSessionFileToDestination,
}));

vi.mock('expo-file-system', () => ({
    cacheDirectory: 'file:///cache/',
    Paths: { cache: { uri: 'file:///cache/' } },
    makeDirectoryAsync: nativeFileSystem.makeDirectoryAsync,
    Directory: class Directory {
        public readonly uri: string;

        constructor(...paths: Array<string | { uri: string }>) {
            this.uri = paths
                .map((path) => typeof path === 'string' ? path : path.uri)
                .reduce((base, path) => {
                    if (!base) return path.replace(/\/+$/g, '');
                    return `${base.replace(/\/+$/g, '')}/${path.replace(/^\/+|\/+$/g, '')}`;
                }, '');
        }

        create(options: { intermediates: boolean; idempotent: boolean }) {
            nativeFileSystem.directoryCreate(this.uri, options);
        }
    },
    File: class File {
        public readonly uri: string;

        constructor(uri: string | { uri: string }, name?: string) {
            const baseUri = typeof uri === 'string' ? uri : uri.uri;
            this.uri = name ? `${baseUri.replace(/\/+$/g, '')}/${name}` : baseUri;
        }

        create() {}

        open() {
            return {
                offset: 0,
                writeBytes: (bytes: Uint8Array) => {
                    nativeFileSystem.writes.push(new Uint8Array(bytes));
                },
                close: nativeFileSystem.close,
            };
        }

        delete() {
            nativeFileSystem.delete();
        }
    },
}));

const { createSessionFilePreviewSource } = await import('./createSessionFilePreviewSource');

type DownloadMockParams = Readonly<{
    sessionId: string;
    request: Readonly<{ path: string; asZip: boolean }>;
    destination: Readonly<{
        writeBytes: (bytes: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
        cleanup: () => Promise<void>;
    }>;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | Readonly<{ success: false; error: string }>>) | null;
}>;

function createMemoryDestination() {
    const chunks: Uint8Array[] = [];
    const close = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const buildSource = vi.fn(async (input: { sizeBytes: number }) => ({
        uri: 'memory://preview',
        sizeBytes: input.sizeBytes,
        cacheSizeBytes: input.sizeBytes,
        svgXml: null,
        cleanup,
    }));

    return {
        chunks,
        destination: {
            writeBytes: async (bytes: Uint8Array) => {
                chunks.push(new Uint8Array(bytes));
            },
            close,
            cleanup,
            buildSource,
        },
    };
}

describe('createSessionFilePreviewSource', () => {
    beforeEach(() => {
        downloadDaemonSessionFileToDestination.mockReset();
        nativeFileSystem.writes.length = 0;
        nativeFileSystem.makeDirectoryAsync.mockClear();
        nativeFileSystem.directoryCreate.mockClear();
        nativeFileSystem.close.mockClear();
        nativeFileSystem.delete.mockClear();
        Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
    });

    it('downloads a session file into the supplied preview destination', async () => {
        const memory = createMemoryDestination();
        downloadDaemonSessionFileToDestination.mockImplementation(async (params: DownloadMockParams) => {
            await params.onInit?.({ name: 'image.png', sizeBytes: 3 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3]));
            await params.destination.close();
            return { ok: true, name: 'image.png', sizeBytes: 3 };
        });

        const result = await createSessionFilePreviewSource({
            sessionId: 'session-1',
            filePath: '.happier/uploads/generated/message/image.png',
            mimeType: 'image/png',
            maxBytes: 16,
            createDestination: () => ({ ok: true, destination: memory.destination }),
        });

        expect(result).toEqual({
            ok: true,
            source: {
                uri: 'memory://preview',
                sizeBytes: 3,
                cacheSizeBytes: 3,
                svgXml: null,
                cleanup: memory.destination.cleanup,
            },
        });
        expect(memory.chunks).toEqual([new Uint8Array([1, 2, 3])]);
        expect(downloadDaemonSessionFileToDestination).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            request: { path: '.happier/uploads/generated/message/image.png', asZip: false },
        }));
    });

    it('rejects oversized previews before chunk download work reaches the destination', async () => {
        const memory = createMemoryDestination();
        downloadDaemonSessionFileToDestination.mockImplementation(async (params: DownloadMockParams) => {
            const initResult = await params.onInit?.({ name: 'image.png', sizeBytes: 17 });
            if (initResult?.success === false) {
                await params.destination.cleanup();
                return { ok: false, error: initResult.error };
            }
            await params.destination.writeBytes(new Uint8Array([1]));
            return { ok: true, name: 'image.png', sizeBytes: 17 };
        });

        const result = await createSessionFilePreviewSource({
            sessionId: 'session-1',
            filePath: 'image.png',
            mimeType: 'image/png',
            maxBytes: 16,
            createDestination: () => ({ ok: true, destination: memory.destination }),
        });

        expect(result).toEqual({ ok: false, error: 'File exceeds preview size limit' });
        expect(memory.chunks).toEqual([]);
        expect(memory.destination.cleanup).toHaveBeenCalled();
        expect(memory.destination.buildSource).not.toHaveBeenCalled();
    });

    it('writes native previews to a cache file and exposes decoded svg xml for native rendering', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
        const svgBytes = new TextEncoder().encode(svg);
        downloadDaemonSessionFileToDestination.mockImplementation(async (params: DownloadMockParams) => {
            await params.onInit?.({ name: 'image.svg', sizeBytes: svgBytes.byteLength });
            await params.destination.writeBytes(svgBytes);
            await params.destination.close();
            return { ok: true, name: 'image.svg', sizeBytes: svgBytes.byteLength };
        });

        const result = await createSessionFilePreviewSource({
            sessionId: 'session-1',
            filePath: 'image.svg',
            mimeType: 'image/svg+xml',
            maxBytes: 1024,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.source.uri.startsWith('file:///cache/happier-previews/')).toBe(true);
        expect(result.source.svgXml).toBe(svg);
        expect(nativeFileSystem.writes).toEqual([svgBytes]);
        expect(nativeFileSystem.directoryCreate).toHaveBeenCalledWith('file:///cache/happier-previews', {
            idempotent: true,
            intermediates: true,
        });
        expect(nativeFileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
    });

    it('writes an Android MP4 preview directly to the native cache and removes it after use', async () => {
        Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
        const chunks = [new Uint8Array([0, 1, 2]), new Uint8Array([3, 4, 5])];
        downloadDaemonSessionFileToDestination.mockImplementation(async (params: DownloadMockParams) => {
            const init = await params.onInit?.({ name: 'demo.mp4', sizeBytes: 12_000_000 });
            if (init?.success === false) return { ok: false, error: init.error };
            for (const chunk of chunks) await params.destination.writeBytes(chunk);
            await params.destination.close();
            return { ok: true, name: 'demo.mp4', sizeBytes: 12_000_000 };
        });
        const result = await createSessionFilePreviewSource({ sessionId: 's1', filePath: 'demo.mp4', mimeType: 'video/mp4' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.source.uri).toMatch(/^file:\/\/\/cache\/happier-previews\/.*demo\.mp4$/);
        expect(result.source.svgXml).toBeNull();
        expect(nativeFileSystem.writes).toEqual(chunks);
        await result.source.cleanup();
        expect(nativeFileSystem.delete).toHaveBeenCalled();
    });
});
