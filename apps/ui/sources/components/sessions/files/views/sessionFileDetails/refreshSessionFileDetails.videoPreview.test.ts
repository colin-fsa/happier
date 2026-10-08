import { describe, expect, it, vi } from 'vitest';
import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';

const boundaries = vi.hoisted(() => ({
    read: vi.fn(),
    stat: vi.fn(async () => ({ success: true, exists: true, kind: 'file', sizeBytes: 12_000_000, modifiedMs: 1 })),
    diff: vi.fn(),
}));
vi.mock('@/sync/ops', () => ({
    sessionReadFile: boundaries.read,
    sessionStatFile: boundaries.stat,
    sessionScmDiffFile: boundaries.diff,
}));
vi.mock('@/config', () => ({ config: { filesPreviewMaxBytes: 2_500_000 } }));
installSessionFileDetailsCommonModuleMocks();

import { refreshSessionFileDetails } from './refreshSessionFileDetails';

describe('session video preview metadata', () => {
    it('allows an MP4 larger than the text preview limit without reading or diffing video bytes inline', async () => {
        const result = await refreshSessionFileDetails({
            sessionId: 's1', filePath: 'media/demo.MP4', diffMode: 'pending',
            sessionPath: '/repo', sessionsReady: true, includeFile: false,
        });
        expect(result).toMatchObject({
            status: 'ready', error: null, diffContent: null,
            fileContent: { isBinary: true, binaryMime: 'video/mp4', binarySizeBytes: 12_000_000 },
        });
        expect(boundaries.read).not.toHaveBeenCalled();
        expect(boundaries.diff).not.toHaveBeenCalled();
    });

    it('classifies other known binary files without applying the text preview limit', async () => {
        const result = await refreshSessionFileDetails({
            sessionId: 's1', filePath: 'archive.zip', diffMode: 'pending',
            sessionPath: '/repo', sessionsReady: true,
        });
        expect(result).toMatchObject({ status: 'ready', error: null, fileContent: { isBinary: true } });
        expect(boundaries.read).not.toHaveBeenCalled();
    });
});
