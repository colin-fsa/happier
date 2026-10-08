import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
    files: new Map<string, number[]>(),
    closeError: null as Error | null,
    openError: null as Error | null,
    deleteError: null as Error | null,
}));
vi.mock('expo-file-system', () => ({
    Paths: { cache: 'file:///cache' },
    Directory: class Directory {
        uri: string;
        constructor(...parts: Array<string | { uri: string }>) {
            this.uri = parts.map((part) => typeof part === 'string' ? part : part.uri).join('/');
        }
        create() {}
    },
    File: class File {
        uri: string;
        constructor(directory: { uri: string }, name: string) { this.uri = `${directory.uri}/${name}`; }
        create() {
            if (new TextEncoder().encode(this.uri.split('/').at(-1)!).byteLength > 255) throw new Error('Filename exceeds filesystem component limit');
            if (fs.files.has(this.uri)) throw new Error('File already exists');
            fs.files.set(this.uri, []);
        }
        open() {
            if (fs.openError) throw fs.openError;
            return {
                offset: 0,
                writeBytes: (bytes: Uint8Array) => fs.files.get(this.uri)!.push(...bytes),
                close: () => { if (fs.closeError) throw fs.closeError; },
            };
        }
        delete() {
            if (fs.deleteError) throw fs.deleteError;
            if (!fs.files.delete(this.uri)) throw new Error('File already removed');
        }
    },
}));

import { createNativeCacheFileSink } from './nativeCacheFileSink';

describe('native cache file destinations', () => {
    beforeEach(() => { fs.files.clear(); fs.closeError = null; fs.openError = null; fs.deleteError = null; });

    it('keeps repeated downloads distinct while preserving the extension', async () => {
        const input = { directoryName: 'happier-downloads', name: 'recording.mp4' };
        const first = await createNativeCacheFileSink(input);
        const second = await createNativeCacheFileSink(input);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (!first.ok || !second.ok) throw new Error('expected sinks');
        expect(first.sink.fileUri).not.toBe(second.sink.fileUri);
        expect(first.sink.fileUri).toMatch(/\.mp4$/);
        expect(second.sink.fileUri).toMatch(/\.mp4$/);
        await first.sink.writeBytes(new Uint8Array([1, 2]));
        await second.sink.writeBytes(new Uint8Array([3]));
        await first.sink.close();
        await first.sink.close();
        await first.sink.cleanup();
        await first.sink.cleanup();
        expect(fs.files.get(second.sink.fileUri)).toEqual([3]);
    });

    it.each(['界'.repeat(83), '😀'.repeat(62)])('stores valid Unicode display names within the filesystem byte limit', async (stem) => {
        const results = [
            await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: `${stem}.mp4` }),
            await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: `${stem}.mp4` }),
        ];
        for (const result of results) if (!result.ok) throw new Error(result.error);
        const uris = results.map(result => {
            if (!result.ok) throw new Error(result.error);
            const filename = result.sink.fileUri.split('/').at(-1)!;
            expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(255);
            expect(filename).toMatch(/\.mp4$/);
            expect(filename).not.toContain('\uFFFD');
            return result.sink.fileUri;
        });
        expect(new Set(uris).size).toBe(2);
    });

    it('surfaces a close failure so an incomplete file cannot be reported as saved', async () => {
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: 'a.mp4' });
        if (!result.ok) throw new Error(result.error);
        fs.closeError = new Error('Disk close failed');
        await expect(result.sink.close()).rejects.toThrow('Disk close failed');
    });

    it('deletes a file allocated before opening its handle fails', async () => {
        fs.openError = new Error('File open failed');
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: 'a.mp4' });
        expect(result).toEqual({ ok: false, error: 'File open failed' });
        expect(fs.files.size).toBe(0);
    });

    it('reports cleanup failure when deleting a failed-open destination fails', async () => {
        fs.openError = new Error('File open failed');
        fs.deleteError = new Error('File delete failed');
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: 'a.mp4' });
        expect(result).toEqual({ ok: false, error: expect.stringMatching(/File open failed.*File delete failed/) });
    });

    it('still deletes a destination when closing its handle fails, and surfaces the close error', async () => {
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: 'a.mp4' });
        if (!result.ok) throw new Error(result.error);
        fs.closeError = new Error('Disk close failed');
        await expect(result.sink.cleanup()).rejects.toBe(fs.closeError);
        expect(fs.files.size).toBe(0);
    });

    it('surfaces cache deletion failure', async () => {
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: 'a.mp4' });
        if (!result.ok) throw new Error(result.error);
        fs.deleteError = new Error('File delete failed');
        const diagnostic = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await expect(result.sink.cleanup()).rejects.toBe(fs.deleteError);
            expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(fs.deleteError.message));
        } finally { diagnostic.mockRestore(); }
    });

    it('preserves the media extension when the display name needs truncation', async () => {
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: `${'recording'.repeat(20)}.mp4` });
        if (!result.ok) throw new Error(result.error);
        expect(result.sink.fileUri).toMatch(/\.mp4$/);
    });
});
