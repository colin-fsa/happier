import * as React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import { resolveThisComputerSetupFollowUp, useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { ProviderSetupFlow } from '@/components/settings/providers/setup/ProviderSetupFlow';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import { LocalTailscaleSecureAccessSection } from '@/components/settings/server/localControl/LocalTailscaleSecureAccessSection';
import { resolveKnownLocalRelayUrl } from '@/components/settings/server/localControl/resolveKnownLocalRelayUrl';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { desktopSetupCoordinator, type DesktopSetupVerificationFailure } from '@/setup/desktopSetupCoordinator';
import { presentSetupServiceConsent } from '@/setup/presentSetupServiceConsent';
import { presentUnmanagedCliConsent } from '@/setup/presentUnmanagedCliConsent';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { DesktopOnlySetupNotice } from './DesktopOnlySetupNotice';
import { LocalCliPathExposureSection } from './localControl/LocalCliPathExposureSection';
import { LocalDaemonControlSection } from './localControl/LocalDaemonControlSection';
import { RemoteSshMachineSetupSection } from './RemoteSshMachineSetupSection';
import { upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { Icon } from '@/components/ui/icons/Icon';

type MachineSetupFlowScreenProps = Readonly<{
    embedded?: boolean;
    initialProviderMachineId?: string | null;
    mode?: 'full' | 'localOnly' | 'remoteOnly';
    onLocalSetupSucceeded?: (machineId: string | null) => void;
    runner?: SystemTaskRunner;
}>;

function resolveLocalSetupStartErrorSubtitle(startError: string): string {
    if (!String(startError ?? '').trim()) {
        return t('settings.systemTaskStartFailed');
    }
    if (isSystemTaskBridgeUnavailableError(startError)) {
        return t('settings.systemTaskBridgeUnavailable');
    }
    return t('settings.systemTaskStartFailed');
}

/**
 * Where this screen's readiness proof stands. Both entry points — finishing setup here, and
 * adopting whatever is already on this computer — ask the coordinator's ONE
 * `verifyCurrentTarget()` (INV8 + INV10). Neither reads `machineId` off a task result: a service
 * command can succeed while the running daemon carries the wrong identity, while ownership has
 * not converged, or while the relay cannot reach this computer at all.
 */
type LocalReadiness =
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'verifying'; source: 'setup' | 'adopt' }>
    | Readonly<{ status: 'verified'; machineId: string }>
    | Readonly<{ status: 'blocked'; source: 'setup' | 'adopt'; code: DesktopSetupVerificationFailure }>;

export const MachineSetupFlowScreen = React.memo(function MachineSetupFlowScreen(props: MachineSetupFlowScreenProps) {
    const isRemoteOnly = props.mode === 'remoteOnly';
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop();
    const supportsDesktopControls = props.runner != null || isTauriDesktop();

    if (isBrowserWeb || !supportsDesktopControls) {
        const notice = (
            <DesktopOnlySetupNotice
                testID="settings.machineSetup.desktopOnlyNotice"
                groupTitle={isRemoteOnly ? t('settings.machineSetupSshMachineTitle') : t('settings.addMachine')}
                title={t('setupOnboarding.webDesktopOnlyTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
        );
        return props.embedded ? notice : <ItemList>{notice}</ItemList>;
    }

    return <DesktopMachineSetupFlowScreen {...props} />;
});

const DesktopMachineSetupFlowScreen = React.memo(function DesktopMachineSetupFlowScreen(props: MachineSetupFlowScreenProps) {
    const { theme } = useUnistyles();
    const isBrowserWeb = Platform.OS === 'web' && !isTauriDesktop() && props.runner == null;
    const isRemoteOnly = props.mode === 'remoteOnly';
    const isLocalOnly = props.mode === 'localOnly';
    const [showRemoteSetupState, setShowRemoteSetupState] = React.useState(false);
    const [localRelayUrl, setLocalRelayUrl] = React.useState<string | null>(null);
    const [remoteCompletedMachine, setRemoteCompletedMachine] = React.useState<Readonly<{
        machineId: string | null;
        serverId: string | null;
        relayRuntimeUrl: string | null;
    }> | null>(null);
    const showRemoteSetup = isRemoteOnly ? true : (isLocalOnly ? false : showRemoteSetupState);
    // This screen starts the one setup executor too, so it answers the executor's prompts through
    // the same owners the drift banner and the local daemon control use (C6). Starting it unwired
    // declines its own pairing request by name, so the user presses "set up this computer" and the
    // task dead-ends. Install ownership rides the executor's own prompt (INV2/R13); a CLI this
    // app's install path did not place is put to the user rather than silently refused.
    const activeServerSnapshot = getActiveServerSnapshot();
    const expectedAccountId = getActiveServerAccountScope()?.accountId ?? null;
    const {
        activeTaskSnapshot,
        cancel,
        start,
        startError,
    } = useThisComputerSetupTask({
        ...(expectedAccountId
            ? {
                authRequestApproval: {
                    expectedRelayUrl: activeServerSnapshot.serverUrl,
                    expectedAccountId,
                    serverId: activeServerSnapshot.serverId,
                },
            }
            : {}),
        onServiceConsentRequired: presentSetupServiceConsent,
        onUnmanagedCliConsentRequired: presentUnmanagedCliConsent,
        onSucceeded: () => {
            void verifyLocalReadinessRef.current?.('setup');
        },
        ...(props.runner ? { runner: props.runner } : {}),
    });
    const [localReadiness, setLocalReadiness] = React.useState<LocalReadiness>({ status: 'idle' });
    const copyFeedback = useTemporaryCopyFeedback();

    const onLocalSetupSucceeded = props.onLocalSetupSucceeded;
    const verifyLocalReadiness = React.useCallback(async (source: 'setup' | 'adopt') => {
        setLocalReadiness({ status: 'verifying', source });
        // Successful setup already refreshes the shared facts through the operation owner.
        // Adoption separately asks what is on this computer right now.
        const outcome = await desktopSetupCoordinator.verifyCurrentTarget({ fresh: source === 'adopt' });
        if (outcome.status === 'verified') {
            setLocalReadiness({ status: 'verified', machineId: outcome.machineId });
            onLocalSetupSucceeded?.(outcome.machineId);
            return;
        }
        setLocalReadiness({ status: 'blocked', source, code: outcome.code });
        if (source === 'adopt') {
            Modal.alert(t('common.error'), t('settings.machineSetupAdoptExistingNotReady'));
        }
    }, [onLocalSetupSucceeded]);
    // The task hook's `onSucceeded` is captured before the callback exists; the ref keeps one
    // owner of the proof rather than a second copy of it inside the task options.
    const verifyLocalReadinessRef = React.useRef<((source: 'setup' | 'adopt') => Promise<void>) | null>(null);
    verifyLocalReadinessRef.current = verifyLocalReadiness;

    const localSetupFollowUp = React.useMemo(() => {
        return resolveThisComputerSetupFollowUp(activeTaskSnapshot?.result ?? null);
    }, [activeTaskSnapshot?.result]);

    const localSetupSnapshotForCard = React.useMemo(() => {
        if (!activeTaskSnapshot) {
            return null;
        }
        if (!localSetupFollowUp) {
            return activeTaskSnapshot;
        }
        return {
            ...activeTaskSnapshot,
            awaitingInput: true,
            status: 'running' as const,
            latestMessage: t('server.relayDrift.progressStepAuthenticate'),
        };
    }, [activeTaskSnapshot, localSetupFollowUp]);

    const handleStartLocalTask = React.useCallback(async () => {
        try {
            await start();
        } catch {
            // startError state is rendered below
        }
    }, [start]);
    const knownLocalRelayUrl = React.useMemo(() => resolveKnownLocalRelayUrl({
        activeServerUrl: activeServerSnapshot.serverUrl,
        activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl,
    }), [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverUrl]);
    const handleLocalRelayStatusChange = React.useCallback((status: Readonly<{ relayUrl: string }> | null | undefined) => {
        const nextRelayUrl = typeof status?.relayUrl === 'string' && status.relayUrl.trim().length > 0
            ? status.relayUrl.trim()
            : null;
        setLocalRelayUrl((current) => current === nextRelayUrl ? current : nextRelayUrl);
    }, []);
    const remoteRelayRuntimeUrl = remoteCompletedMachine?.relayRuntimeUrl ?? null;
    const verifiedLocalMachineId = localReadiness.status === 'verified' ? localReadiness.machineId : null;
    const providerMachineId = remoteCompletedMachine?.machineId ?? verifiedLocalMachineId ?? props.initialProviderMachineId ?? null;
    const providerServerId = remoteCompletedMachine?.machineId
        ? remoteCompletedMachine.serverId ?? undefined
        : undefined;
    const copyRemoteRelayUrl = React.useCallback(() => {
        if (!remoteRelayRuntimeUrl) {
            return;
        }
        void setClipboardStringSafe(remoteRelayRuntimeUrl).then((copied) => {
            if (copied) {
                copyFeedback.markCopied('remoteRelayRuntimeUrl');
                return;
            }
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
        });
    }, [copyFeedback, remoteRelayRuntimeUrl]);
    const saveRemoteRelayUrl = React.useCallback(() => {
        if (!remoteRelayRuntimeUrl) {
            return;
        }
        try {
            upsertServerProfile({ serverUrl: remoteRelayRuntimeUrl, source: 'url' });
        } catch {
            // ignore: invalid url or storage failure should not block setup completion
        }
    }, [remoteRelayRuntimeUrl]);
    const desktopOnlyNoticeTitle = isRemoteOnly
        ? t('settings.machineSetupSshMachineTitle')
        : isLocalOnly
            ? t('settings.machineSetupCurrentMachineTitle')
            : t('settings.addMachine');

    if (isBrowserWeb) {
        const notice = (
            <DesktopOnlySetupNotice
                testID="settings.machineSetup.desktopOnlyNotice"
                groupTitle={desktopOnlyNoticeTitle}
                title={t('setupOnboarding.webDesktopOnlyTitle')}
                subtitle={t('setupOnboarding.webDesktopOnlyBody')}
            />
        );
        return props.embedded ? notice : <ItemList>{notice}</ItemList>;
    }

    const handleAuthenticateLocalSetup = React.useCallback(() => {
        const relayUrl = typeof activeServerSnapshot.serverUrl === 'string'
            ? activeServerSnapshot.serverUrl.trim()
            : '';
        if (!relayUrl) {
            Modal.alert(t('common.error'), t('server.failedToConnectToServer'));
            return;
        }
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl,
        });
        router.push(`/settings/server?url=${encodeURIComponent(relayUrl)}&auto=1`);
    }, [activeServerSnapshot.serverUrl]);

    const handleAdoptExistingInstallation = React.useCallback(async () => {
        try {
            await verifyLocalReadiness('adopt');
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            Modal.alert(t('common.error'), message ?? t('settings.systemTaskStartFailed'));
        }
    }, [verifyLocalReadiness]);

    const handleSwitchToRemoteRelay = React.useCallback(async () => {
        if (!remoteRelayRuntimeUrl) {
            return;
        }

        const confirmed = await Modal.confirm(
            t('settings.machineSetupRemoteRelaySwitchConfirmTitle'),
            t('settings.machineSetupRemoteRelaySwitchConfirmBody', { relayUrl: remoteRelayRuntimeUrl }),
            {
                confirmText: t('common.continue'),
                cancelText: t('common.cancel'),
            },
        );
        if (!confirmed) {
            return;
        }

        try {
            await upsertActivateAndSwitchServer({
                serverUrl: remoteRelayRuntimeUrl,
                source: 'url',
                scope: 'device',
            });
        } catch (error) {
            const message = error instanceof Error ? error.message.trim() : '';
            Modal.alert(t('common.error'), message || t('server.failedToConnectToServer'));
            return;
        }

        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: remoteRelayRuntimeUrl,
            machineId: remoteCompletedMachine?.machineId ?? null,
        });
        router.push(`/settings/server?url=${encodeURIComponent(remoteRelayRuntimeUrl)}&auto=1`);
    }, [remoteCompletedMachine?.machineId, remoteRelayRuntimeUrl]);

    const content = (
        <>
            {(isRemoteOnly || isLocalOnly) ? null : (
                <ItemGroup title={t('settings.addMachine')}>
                    <Item
                        testID="settings.machineSetup.startLocalTask"
                        title={t('settings.machineSetupCurrentMachineTitle')}
                        subtitle={t('settings.machineSetupCurrentMachineSubtitle')}
                        icon={<Icon name="laptop" size={29} color={theme.colors.accent.blue} />}
                        onPress={() => {
                            void handleStartLocalTask();
                        }}
                    />
                    <Item
                        testID="settings.machineSetup.adoptExisting"
                        title={t('settings.machineSetupAdoptExistingTitle')}
                        subtitle={t('settings.machineSetupAdoptExistingSubtitle')}
                        icon={<Icon name="checks" size={29} color={theme.colors.accent.indigo} />}
                        onPress={() => {
                            void handleAdoptExistingInstallation();
                        }}
                    />
                    <Item
                        testID="settings.machineSetup.startRemoteTask"
                        title={t('settings.machineSetupSshMachineTitle')}
                        subtitle={t('settings.machineSetupSshMachineSubtitle')}
                        icon={<Icon name="hard-drives" size={29} color={theme.colors.accent.orange} />}
                        onPress={() => {
                            setShowRemoteSetupState((current) => !current);
                        }}
                    />
                </ItemGroup>
            )}

            <ItemGroup title={t('settings.machineSetupStagesTitle')}>
                <Item
                    title={t('settings.machineSetupStageConnect')}
                    icon={<Icon name="link" size={29} color={theme.colors.accent.blue} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.machineSetupStageInstall')}
                    icon={<Icon name="download" size={29} color={theme.colors.accent.orange} />}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('settings.machineSetupStageFinish')}
                    icon={<Icon name="terminal" size={29} color={theme.colors.accent.indigo} />}
                    showChevron={false}
                    mode="info"
                />
            </ItemGroup>

            {!isBrowserWeb && !isRemoteOnly && activeTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={t('settings.machineSetupCurrentMachineTitle')}
                    snapshot={localSetupSnapshotForCard ?? activeTaskSnapshot}
                    onCancel={activeTaskSnapshot.result ? undefined : cancel}
                />
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && localReadiness.status === 'verifying' ? (
                <ItemGroup title={t('settings.machineSetupAdoptExistingProgressTitle')}>
                    <Item
                        testID="settings.machineSetup.localReadinessVerifying"
                        title={t('setupSurface.stageVerifyStatus', { relay: activeServerSnapshot.serverUrl })}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && localReadiness.status === 'blocked' && localReadiness.source === 'setup' ? (
                <ItemGroup title={t('common.error')}>
                    <Item
                        testID="settings.machineSetup.localReadinessBlocked"
                        title={t('setupSurface.blockedTitle')}
                        subtitle={localReadiness.code === 'machine_unreachable'
                            ? t('setupSurface.unreachableStatus', { relay: activeServerSnapshot.serverUrl })
                            : t('setupSurface.notConvergedStatus', { relay: activeServerSnapshot.serverUrl })}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && localSetupFollowUp ? (
                <ItemGroup title={t('common.next')}>
                    <Item
                        testID="settings.machineSetup.localSetupFollowUp.authenticate"
                        title={t('common.authenticate')}
                        subtitle={t('server.relayDrift.bannerNeedsAuthDescription', { activeRelayUrl: activeServerSnapshot.serverUrl })}
                        onPress={handleAuthenticateLocalSetup}
                    />
                </ItemGroup>
            ) : null}

            {!isBrowserWeb && !isRemoteOnly && startError ? (
                <ItemGroup title={t('common.error')}>
                    <Item
                        testID="settings.machineSetup.startError"
                        title={t('common.error')}
                        subtitle={resolveLocalSetupStartErrorSubtitle(startError)}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            <RemoteSshMachineSetupSection
                runner={props.runner}
                expanded={showRemoteSetup}
                onCompletedChange={setRemoteCompletedMachine}
            />

            {remoteRelayRuntimeUrl ? (
                <ItemGroup title={t('settings.machineSetupRemoteRelayRuntimeReadyTitle')}>
                    <Item
                        testID="settings.machineSetup.remoteRelayRuntimeUrl"
                        title={t('settings.machineSetupRemoteRelayRuntimeUrlTitle')}
                        subtitle={remoteRelayRuntimeUrl}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        testID="settings.machineSetup.copyRemoteRelayUrl"
                        title={t('common.copy')}
                        onPress={copyRemoteRelayUrl}
                        rightElement={
                            <CopiedPill
                                visible={copyFeedback.isCopied('remoteRelayRuntimeUrl')}
                                testID="settings.machineSetup.copyRemoteRelayUrl.copied"
                            />
                        }
                    />
                    <Item
                        testID="settings.machineSetup.remoteRelayKeepCurrent"
                        title={t('settings.machineSetupRemoteRelayKeepCurrentTitle')}
                        subtitle={t('settings.machineSetupRemoteRelayKeepCurrentSubtitle')}
                        onPress={saveRemoteRelayUrl}
                    />
                    <Item
                        testID="settings.machineSetup.remoteRelaySwitch"
                        title={t('settings.machineSetupRemoteRelaySwitchTitle')}
                        subtitle={t('settings.machineSetupRemoteRelaySwitchSubtitle')}
                        onPress={handleSwitchToRemoteRelay}
                    />
                </ItemGroup>
            ) : null}

            {!isBrowserWeb && !isRemoteOnly ? (
                <>
                    <LocalDaemonControlSection runner={props.runner} />
                    <LocalCliPathExposureSection runner={props.runner} />
                    <LocalRelayRuntimeControlSection
                        runner={props.runner}
                        onStatusChange={handleLocalRelayStatusChange}
                    />
                    <LocalTailscaleSecureAccessSection
                        runner={props.runner}
                        upstreamUrl={localRelayUrl ?? knownLocalRelayUrl}
                    />
                </>
            ) : null}

            {providerMachineId ? (
                <ProviderSetupFlow
                    machineId={providerMachineId}
                    serverId={providerServerId}
                />
            ) : null}
        </>
    );

    return props.embedded ? content : <ItemList>{content}</ItemList>;
});
