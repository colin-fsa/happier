import { describe, expect, it, vi } from 'vitest';

import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';

const sessionScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: 'Binary files a/src/image.png and b/src/image.png differ',
}));

const sessionReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
}));

vi.mock('@/sync/ops', () => ({
    sessionScmDiffFile: (...args: any[]) => sessionScmDiffFileSpy(...args),
    sessionStatFile: vi.fn(async () => ({ success: true, exists: true, kind: 'file', sizeBytes: 2_700_000, modifiedMs: 1 })),
    sessionReadFile: (...args: any[]) => sessionReadFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 2_500_000 },
}));

vi.mock('@/hooks/session/files/sessionPathState', () => ({
    resolveSessionPathState: () => ({ status: 'ready', sessionPath: '/repo', homeDir: null }),
}));

installSessionFileDetailsCommonModuleMocks();


vi.mock('@/scm/diff/looksLikeUnifiedDiff', () => ({
    looksLikeUnifiedDiff: () => false,
}));

const { refreshSessionFileDetails } = await import('./refreshSessionFileDetails');

describe('refreshSessionFileDetails (image preview)', () => {
    it('returns image preview metadata for known image files without reading preview bytes inline', async () => {
        sessionScmDiffFileSpy.mockClear();
        sessionReadFileSpy.mockClear();

        const result = await refreshSessionFileDetails({
            sessionId: 's1',
            filePath: 'src/image.png',
            diffMode: 'pending',
            sessionPath: '/repo',
            sessionsReady: true,
            fileEntryKind: 'modified',
            imagePreviewMaxBytes: 16 * 1024 * 1024,
        });

        expect(result.status).toBe('ready');
        if (result.status !== 'ready') return;
        expect(result.error).toBeNull();
        expect(result.diffContent).toBeNull();
        expect(result.fileContent?.isBinary).toBe(true);
        expect(result.fileContent?.binaryMime).toBe('image/png');
        expect(result.fileContent?.binaryBase64).toBeUndefined();
        expect(result.fileContent?.binarySizeBytes).toBe(2_700_000);
        expect(sessionReadFileSpy).not.toHaveBeenCalled();
    });
});
