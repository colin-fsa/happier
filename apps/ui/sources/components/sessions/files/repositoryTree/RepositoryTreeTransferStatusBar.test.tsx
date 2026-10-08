import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

installRepositoryTreeCommonModuleMocks();

describe('RepositoryTreeTransferStatusBar download cancellation', () => {
    it.each([true, false])('offers app cancellation only when the download owner allows it (%s)', async cancelable => {
        const { RepositoryTreeTransferStatusBar } = await import('./RepositoryTreeTransferStatusBar');
        const screen = await renderScreen(<RepositoryTreeTransferStatusBar
            uploadState={{ status: 'idle' }}
            downloadState={{ status: 'downloading', name: 'recording.mp4', downloadedBytes: 4, totalBytes: 4, cancelable }}
            onCancelUploads={vi.fn()}
            onCancelDownload={vi.fn()}
        />);
        expect(screen.findByTestId('repository-tree-download-status')).not.toBeNull();
        const control = screen.findByTestId('repository-tree-download-cancel');
        if (cancelable) expect(control).not.toBeNull();
        else expect(control).toBeNull();
    });
});
