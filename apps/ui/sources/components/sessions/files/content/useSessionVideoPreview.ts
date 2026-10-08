import * as React from 'react';
import { createSessionFilePreviewSource, type SessionFilePreviewSource } from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';
import { t } from '@/text';

type VideoPreviewState =
    | Readonly<{ status: 'disabled' | 'loading'; uri: null; error: null }>
    | Readonly<{ status: 'loaded'; uri: string; error: null }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

function releaseSource(source: SessionFilePreviewSource): void {
    void Promise.resolve().then(source.cleanup).catch(() => undefined);
}

export function useSessionVideoPreview(input: Readonly<{
    sessionId: string;
    filePath: string;
    mimeType: string;
    enabled: boolean;
    revision?: string | null;
}>) {
    const { sessionId, filePath, mimeType, enabled, revision } = input;
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [state, setState] = React.useState<VideoPreviewState>({ status: 'loading', uri: null, error: null });

    React.useEffect(() => {
        if (!enabled) {
            setState({ status: 'disabled', uri: null, error: null });
            return;
        }
        const controller = new AbortController();
        let source: SessionFilePreviewSource | null = null;
        setState({ status: 'loading', uri: null, error: null });
        void (async () => {
            try {
                const result = await createSessionFilePreviewSource({
                    sessionId, filePath, mimeType, signal: controller.signal,
                });
                if (controller.signal.aborted) {
                    if (result.ok) releaseSource(result.source);
                    return;
                }
                if (!result.ok) {
                    setState({ status: 'error', uri: null, error: result.error || t('files.fileReadFailed') });
                    return;
                }
                source = result.source;
                setState({ status: 'loaded', uri: source.uri, error: null });
            } catch (error) {
                if (controller.signal.aborted) return;
                setState({ status: 'error', uri: null, error: error instanceof Error ? error.message : t('files.fileReadFailed') });
            }
        })();
        return () => {
            controller.abort();
            if (source) releaseSource(source);
        };
    }, [sessionId, filePath, mimeType, enabled, revision, attempt]);

    return { state, retry };
}
