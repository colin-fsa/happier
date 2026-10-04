import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';
import { Icon } from '@/components/ui/icons/Icon';

export const SessionRuntimeSettingsView = React.memo(function SessionRuntimeSettingsView() {
    const { theme } = useUnistyles();
    const useTmux = useSetting('sessionUseTmux');
    const terminalHost = useSetting('sessionTerminalHost');
    const applySettings = useApplySettings();
    const [tmuxSessionName, setTmuxSessionName] = useSettingMutable('sessionTmuxSessionName');
    const [tmuxIsolated, setTmuxIsolated] = useSettingMutable('sessionTmuxIsolated');
    const [tmuxTmpDir, setTmuxTmpDir] = useSettingMutable('sessionTmuxTmpDir');
    const [windowsRemoteSessionLaunchMode, setWindowsRemoteSessionLaunchMode] = useSettingMutable('sessionWindowsRemoteSessionLaunchMode');
    const [windowsTerminalWindowName, setWindowsTerminalWindowName] = useSettingMutable('sessionWindowsTerminalWindowName');
    const [terminalConnectLegacySecretExportEnabled, setTerminalConnectLegacySecretExportEnabled] = useSettingMutable('terminalConnectLegacySecretExportEnabled');
    const [openWindowsRemoteSessionLaunchModeMenu, setOpenWindowsRemoteSessionLaunchModeMenu] = React.useState(false);
    const [openTerminalHostMenu, setOpenTerminalHostMenu] = React.useState(false);
    const selectedTerminalHost = resolveTerminalHost({ settings: {
        sessionUseTmux: useTmux, sessionTerminalHost: terminalHost,
        sessionTmuxByMachineId: {}, sessionTerminalHostByMachineId: {},
    }, machineId: null });

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSession.terminalHostTitle')}>
                <DropdownMenu
                    open={openTerminalHostMenu}
                    onOpenChange={setOpenTerminalHostMenu}
                    items={[
                        { id: 'none', title: t('settingsSession.terminalHostNone') },
                        { id: 'tmux', title: 'tmux', testID: 'settings-session-terminal-host-option-tmux' },
                        { id: 'zellij', title: 'Zellij' },
                        { id: 'herdr', title: 'Herdr' },
                    ]}
                    selectedId={selectedTerminalHost}
                    onSelect={(id) => {
                        if (id === 'none' || id === 'tmux' || id === 'zellij' || id === 'herdr') {
                            applySettings({ sessionTerminalHost: id, sessionUseTmux: id === 'tmux' });
                            setOpenTerminalHostMenu(false);
                        }
                    }}
                    itemTrigger={{
                        itemProps: { testID: 'settings-session-terminal-host-item' },
                        title: t('settingsSession.terminalHostTitle'),
                        subtitle: selectedTerminalHost === 'none'
                            ? t('settingsSession.terminalHostNone')
                            : selectedTerminalHost === 'tmux' ? 'tmux' : selectedTerminalHost === 'zellij' ? 'Zellij' : 'Herdr',
                        icon: <Icon name="terminal" size={29} color={theme.colors.accent.indigo} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
                {selectedTerminalHost === 'tmux' ? (
                    <>
                        <View style={[styles.inputContainer, { paddingTop: 0 }]}>
                            <Text style={styles.fieldLabel}>{t('profiles.tmuxSession')} ({t('common.optional')})</Text>
                            <TextInput
                                testID="settings-session-tmux-sessionName-input"
                                style={styles.textInput}
                                placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                value={tmuxSessionName ?? ''}
                                onChangeText={setTmuxSessionName}
                            />
                        </View>
                        <Item
                            testID="settings-session-tmux-isolated-item"
                            title={t('profiles.tmux.isolatedServerTitle')}
                            subtitle={tmuxIsolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                            icon={<Icon name="stack" size={29} color={theme.colors.accent.indigo} />}
                            rightElement={<Switch value={tmuxIsolated} onValueChange={setTmuxIsolated} />}
                            showChevron={false}
                            onPress={() => setTmuxIsolated(!tmuxIsolated)}
                        />
                        {tmuxIsolated ? (
                            <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                                <Text style={styles.fieldLabel}>{t('profiles.tmuxTempDir')} ({t('common.optional')})</Text>
                                <TextInput
                                    testID="settings-session-tmux-tmpDir-input"
                                    style={styles.textInput}
                                    placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                    placeholderTextColor={theme.colors.input.placeholder}
                                    value={tmuxTmpDir ?? ''}
                                    onChangeText={(value) => setTmuxTmpDir(value.trim().length > 0 ? value : null)}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>
                        ) : null}
                    </>
                ) : null}
            </ItemGroup>

            <ItemGroup title={t('settingsSession.windows.title')}>
                <DropdownMenu
                    open={openWindowsRemoteSessionLaunchModeMenu}
                    onOpenChange={setOpenWindowsRemoteSessionLaunchModeMenu}
                    items={WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.map((option) => ({
                        id: option.value,
                        title: t(option.labelKey),
                        subtitle: t(option.subtitleKey),
                    }))}
                    selectedId={windowsRemoteSessionLaunchMode}
                    onSelect={(id) => {
                        if (id === 'hidden' || id === 'windows_terminal' || id === 'console') {
                            setWindowsRemoteSessionLaunchMode(id);
                            setOpenWindowsRemoteSessionLaunchModeMenu(false);
                        }
                    }}
                    itemTrigger={{
                        title: t('settingsSession.windows.defaultModeTitle'),
                        subtitle: t(
                            WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.find((option) => option.value === windowsRemoteSessionLaunchMode)?.subtitleKey
                                ?? 'windowsRemoteSessionLaunchMode.hiddenSubtitle',
                        ),
                        icon: <Icon name="windows-logo" size={29} color={theme.colors.accent.blue} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
                <View style={[styles.inputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                    <Text style={styles.fieldLabel}>{t('settingsSession.windows.windowNameTitle')}</Text>
                    <TextInput
                        testID="settings-session-windows-terminal-window-name-input"
                        style={styles.textInput}
                        placeholder={t('settingsSession.windows.windowNamePlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={windowsTerminalWindowName ?? ''}
                        onChangeText={setWindowsTerminalWindowName}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <Text style={styles.fieldLabelMuted}>{t('settingsSession.windows.windowNameHint')}</Text>
                </View>
            </ItemGroup>

            <ItemGroup title={t('settingsSession.terminalConnect.title')} style={styles.sectionSpacerTop}>
                <Item
                    title={t('settingsSession.terminalConnect.legacySecretExportTitle')}
                    subtitle={terminalConnectLegacySecretExportEnabled
                        ? t('settingsSession.terminalConnect.legacySecretExportEnabledSubtitle')
                        : t('settingsSession.terminalConnect.legacySecretExportDisabledSubtitle')}
                    icon={<Icon name="shield" size={29} color={theme.colors.accent.indigo} />}
                    rightElement={<Switch value={terminalConnectLegacySecretExportEnabled} onValueChange={setTerminalConnectLegacySecretExportEnabled} />}
                    showChevron={false}
                    onPress={() => setTerminalConnectLegacySecretExportEnabled(!terminalConnectLegacySecretExportEnabled)}
                />
            </ItemGroup>
        </ItemList>
    );
});

const styles = StyleSheet.create((theme) => ({
    sectionSpacerTop: {
        marginTop: Platform.select({ ios: 8, default: 16 }),
    },
    inputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 4,
    },
    fieldLabelMuted: {
        ...Typography.default('regular'),
        fontSize: 12,
        color: theme.colors.text.secondary,
        marginBottom: 4,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        color: theme.colors.input.text,
    },
}));

export default SessionRuntimeSettingsView;
