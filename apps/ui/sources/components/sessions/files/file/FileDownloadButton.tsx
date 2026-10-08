import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

import { t } from '@/text';
import { useWorkspaceFileTransfers, type WorkspaceFileDownloadAction } from '@/hooks/session/files/useWorkspaceFileTransfers';
import { Icon } from '@/components/ui/icons/Icon';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Modal } from '@/modal';

export const FileDownloadButton = React.memo((props: Readonly<{
    sessionId: string;
    path: string;
    asZip?: boolean;
    testID?: string;
}>) => {
    const { theme } = useUnistyles();
    const [menuOpen, setMenuOpen] = React.useState(false);

    const transfers = useWorkspaceFileTransfers({
        sessionId: props.sessionId,
    });

    const busy = transfers.downloadState.status === 'downloading';
    const disabled = busy;
    const android = Platform.OS === 'android';

    const download = async (action?: WorkspaceFileDownloadAction) => {
        const res = await transfers.startDownload({ path: props.path, asZip: props.asZip === true, action });
        if (!res.ok && !res.canceled) Modal.alert(t('common.error'), res.error);
    };

    const renderButton = (onPress: () => void) => (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={t('files.repositoryTree.actions.download')}
            disabled={disabled}
            onPress={(event) => {
                event?.stopPropagation?.();
                onPress();
            }}
            style={({ pressed }) => ({
                width: android ? 48 : 28,
                height: android ? 48 : 28,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.55 : pressed ? 0.78 : 1,
            })}
        >
            {busy ? (
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            ) : (
                <Icon name="download" size={14} color={theme.colors.text.secondary} />
            )}
        </Pressable>
    );

    if (!android) return renderButton(() => { void download(); });

    return <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        items={[
            { id: 'save', title: t('common.saveAs'), disabled },
            { id: 'open', title: t('files.repositoryTree.actions.openWith'), disabled },
            { id: 'share', title: t('files.repositoryTree.actions.share'), disabled },
        ]}
        onSelect={async (action) => {
            setMenuOpen(false);
            if (action === 'save' || action === 'open' || action === 'share') await download(action);
        }}
        search={false}
        matchTriggerWidth={false}
        placement="bottom"
        popoverAnchorAlign="end"
        trigger={({ toggle }) => renderButton(toggle)}
    />;
});
