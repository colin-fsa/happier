import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useVideoPlayer, VideoView, type VideoPlayerStatus } from 'expo-video';
import { StyleSheet } from 'react-native-unistyles';
import { useIsHostVisible } from '@/hooks/ui/useIsHostVisible';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSessionVideoPreview } from './useSessionVideoPreview';

export function FileVideoPreview(props: Readonly<{
    sessionId: string;
    filePath: string;
    mimeType: string;
    isActive: boolean;
    revision?: string | null;
}>) {
    const focused = useIsFocused();
    const hostVisible = useIsHostVisible();
    const [isFullscreen, setIsFullscreen] = React.useState(false);
    // Android's fullscreen Activity pauses the React Activity. Expo's fullscreen
    // Activity owns genuine background pausing via staysActiveInBackground=false.
    const enabled = props.isActive && focused && (hostVisible || (Platform.OS === 'android' && isFullscreen));
    React.useEffect(() => {
        if (!props.isActive || !focused) setIsFullscreen(false);
    }, [props.isActive, focused]);
    const { state, retry } = useSessionVideoPreview({ ...props, enabled });
    const { height } = useWindowDimensions();

    if (!enabled) return null;
    return (
        <View style={styles.container}>
            <View style={[styles.media, { maxHeight: Math.max(160, height * 0.6) }]}>
                {state.status === 'loaded' ? (
                    <FileVideoPlayer key={state.uri} uri={state.uri} filePath={props.filePath} onRetry={retry} onFullscreenChange={setIsFullscreen} />
                ) : state.status === 'error' ? (
                    <VideoPreviewError error={state.error} onRetry={retry} />
                ) : (
                    <VideoPreviewLoading filePath={props.filePath} />
                )}
            </View>
        </View>
    );
}

function VideoPreviewLoading(props: Readonly<{ filePath: string }>) {
    return (
        <View testID="file-video-loading" style={styles.status} accessibilityLiveRegion="polite" pointerEvents="none">
            <ActivitySpinner size="small" />
            <Text style={styles.label}>{t('files.loadingFile', { fileName: props.filePath.split(/[\\/]/).at(-1) ?? props.filePath })}</Text>
        </View>
    );
}

function VideoPreviewError(props: Readonly<{ error: string; onRetry: () => void }>) {
    return (
        <View testID="file-video-error" style={styles.status} accessibilityLiveRegion="polite">
            <Text style={styles.error}>{props.error}</Text>
            <RoundButton testID="file-video-retry" title={t('common.retry')} onPress={props.onRetry} style={styles.retry} />
        </View>
    );
}

function FileVideoPlayer(props: Readonly<{ uri: string; filePath: string; onRetry: () => void; onFullscreenChange: (fullscreen: boolean) => void }>) {
    const player = useVideoPlayer(props.uri, (instance) => {
        instance.loop = false;
        instance.muted = false;
        instance.staysActiveInBackground = false;
        instance.allowsExternalPlayback = false;
        instance.timeUpdateEventInterval = 0;
    });
    const [status, setStatus] = React.useState<VideoPlayerStatus>(player.status);
    const [error, setError] = React.useState<string | null>(null);
    React.useEffect(() => {
        const subscription = player.addListener('statusChange', (event) => {
            setStatus(event.status);
            setError(event.status === 'error' ? event.error?.message || t('files.fileReadFailed') : null);
        });
        setStatus(player.status);
        return () => subscription.remove();
    }, [player]);
    React.useLayoutEffect(() => () => {
        // Stop before expo-video releases the native player on unmount.
        try { player.pause(); } catch { /* The native handle may already be released. */ }
    }, [player]);
    return (
        <>
            <VideoView
                testID="file-video-player"
                player={player}
                nativeControls
                allowsFullscreen
                allowsPictureInPicture={false}
                onFullscreenEnter={() => props.onFullscreenChange(true)}
                onFullscreenExit={() => props.onFullscreenChange(false)}
                contentFit="contain"
                style={styles.player}
                accessibilityLabel={t('files.videoPreview')}
            />
            {status === 'loading' || status === 'idle' ? <VideoPreviewLoading filePath={props.filePath} /> : null}
            {status === 'error' ? <VideoPreviewError error={error ?? t('files.fileReadFailed')} onRetry={props.onRetry} /> : null}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { width: '100%', maxWidth: 720, marginBottom: 14 },
    media: {
        width: '100%', aspectRatio: 16 / 9, minHeight: 160,
        borderRadius: 12, overflow: 'hidden', borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    player: { width: '100%', height: '100%' },
    status: {
        position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
        alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12,
        backgroundColor: theme.colors.surface.inset,
    },
    label: { color: theme.colors.text.secondary, textAlign: 'center', ...Typography.default() },
    error: { color: theme.colors.state.danger.foreground, textAlign: 'center', ...Typography.default() },
    retry: { minHeight: 48, minWidth: 48 },
}));
