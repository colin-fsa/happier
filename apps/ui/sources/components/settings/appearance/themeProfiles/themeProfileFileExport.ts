import { Platform } from 'react-native';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { t } from '@/text';

export async function downloadThemeJson(fileName: string, json: string): Promise<void> {
    if (
        Platform.OS === 'web'
        && typeof document !== 'undefined'
        && typeof Blob !== 'undefined'
        && typeof URL !== 'undefined'
        && typeof URL.createObjectURL === 'function'
    ) {
        const href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = fileName;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        return;
    }

    const created = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name: fileName });
    if (!created.ok) throw new Error(created.error);
    let retainCacheFile = false;
    try {
        await created.sink.writeBytes(new TextEncoder().encode(json));
        await created.sink.close();
        const result = await shareNativeCacheFile({
            fileUri: created.sink.fileUri,
            name: fileName,
            mimeType: 'application/json',
            dialogTitle: t('settingsAppearance.themeProfiles.exportProfile'),
        });
        if (result.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
        if (result.status === 'shared') retainCacheFile = result.retainCacheFile;
    } finally {
        if (!retainCacheFile) await created.sink.cleanup();
    }
}
