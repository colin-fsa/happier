import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';

const routerPushSpy = vi.hoisted(() => vi.fn());
const setClipboardStringSafeSpy = vi.hoisted(() => vi.fn(async (_value: string) => true));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() => vi.fn(async () => true));
const setPendingSetupIntentSpy = vi.hoisted(() => vi.fn());
const upsertAndActivateServerSpy = vi.hoisted(() => vi.fn());
const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(async () => {}));

let activeServerSnapshotState: {
    serverId: string;
    serverUrl: string;
    activeLocalRelayUrl?: string | null;
    generation: number;
} = {
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null,
    generation: 1,
};

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'ios',
                select: (options: Record<string, unknown>) => options?.ios ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
            },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: routerPushSpy,
            },
        }).module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement(
            'Group',
            { title },
            typeof title === 'string' || typeof title === 'number'
                ? React.createElement('Text', null, String(title))
                : title ?? null,
            children,
        ),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        const title = (props as any).title;
        const subtitle = (props as any).subtitle;
        const subtitleTestID = (props as any).subtitleTestID;
        const subtitleAccessory = (props as any).subtitleAccessory;
        return React.createElement(
            'Item',
            props,
            title != null ? React.createElement('Text', null, String(title)) : null,
            typeof subtitle === 'string' || typeof subtitle === 'number'
                ? React.createElement('Text', { testID: subtitleTestID }, String(subtitle))
                : subtitle ?? null,
            subtitleAccessory ?? null,
        );
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafeSpy(value),
}));

vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: (value: unknown) => setPendingSetupIntentSpy(value),
}));

vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
}));

vi.mock('@/components/ui/cards/ActionCard', () => ({
    ActionCard: (props: Record<string, unknown> & {
        primaryAction?: { onPress?: () => void };
        secondaryAction?: { onPress?: () => void };
        testID?: string;
    }) => React.createElement(
        'ActionCard',
        props,
        props.testID && props.primaryAction
            ? React.createElement('RoundButton', {
                testID: `${props.testID}-primary`,
                onPress: props.primaryAction.onPress,
            })
            : null,
        props.testID && props.secondaryAction
            ? React.createElement('RoundButton', {
                testID: `${props.testID}-secondary`,
                onPress: props.secondaryAction.onPress,
            })
            : null,
    ),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshotState,
    };
});

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...actual,
        // The setup coordinator reads the app's relay from here; keep it on the same relay the
        // rest of this screen's mocks describe so the readiness proof compares like with like.
        getActiveServerSnapshot: () => activeServerSnapshotState,
        upsertAndActivateServer: upsertAndActivateServerSpy,
    };
});

/** INV10's read-only reachability call. The only real network boundary in this flow. */
const machineRpcSpy = vi.hoisted(() => vi.fn(async (_params: unknown) => ({ ok: true }) as unknown));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcSpy(params),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: () => switchConnectionToActiveServerSpy(),
}));

// The signed-in account for the active relay: the executor's explicit target needs it (R3).
// `LocalDaemonControlSection` and the drift banner read the coordinator's one ambient inspection,
// which goes through the app-wide runner rather than the runner this screen is handed. Point that
// at a bridge that always answers so the shared inspection settles instead of leaving a pending
// promise the executor start would wait on.
const ambientRunnerRef = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/components/systemTasks/systemTasksRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks/systemTasksRuntime')>();
    return {
        ...actual,
        getSystemTasksRunner: () => ambientRunnerRef.current ?? actual.getSystemTasksRunner(),
    };
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: activeServerSnapshotState.serverId, accountId: 'acct_app' }),
}));

function findTextNodeByTestId(scope: renderer.ReactTestInstance, testID: string) {
    return scope.findAllByType('Text' as never).find((node) => node.props?.testID === testID);
}

function findProgressCardByTitle(scope: RenderScreenResult, title: string) {
    return scope.findAllByTestId('system-task-progress-card').find((card) => (
        card.findAllByType('Text' as never).some((node: renderer.ReactTestInstance) => node.props?.children === title)
    ));
}


/**
 * A converged ambient `daemon.service.status.v1` reply for the relay and account this screen is
 * on: the running daemon is this computer's, owned by the installed service, on the app's relay.
 * It is what the coordinator's one readiness proof reads before it asks the machine anything.
 */
function convergedAmbientResult(taskId: string, overrides: Record<string, unknown> = {}) {
    return {
        protocolVersion: 1,
        taskId,
        ok: true as const,
        data: {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-local-1',
            acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
            server: {
                serverUrl: 'https://relay.example.test',
                publicServerUrl: 'https://relay.example.test',
                localServerUrl: null,
                comparableKey: 'https://relay.example.test',
            },
            auth: {
                credentialState: 'valid',
                validatedAccountId: 'acct_app',
                accountId: 'acct_app',
                machineId: 'machine-local-1',
            },
            service: { installed: true, running: true },
            runtimeConvergence: {
                controlReachable: true,
                serviceOwnsRunningDaemon: true,
                machineIdMatches: true,
                cliVersionMatches: true,
            },
            ...overrides,
        },
    };
}

/** Points the app-wide runner (the coordinator's) at a bridge answering with `result`. */
async function installAmbientResult(result: (taskId: string) => unknown, onStart?: (kind: string) => void): Promise<void> {
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    ambientRunnerRef.current = createSystemTaskRunner({
        bridge: {
            async start(spec) {
                onStart?.(spec.kind);
                return 'ambient:daemon.service.status.v1';
            },
            async subscribe(taskId, listenerSet) {
                queueMicrotask(() => {
                    listenerSet.onResult(result(taskId) as never);
                });
                return () => {};
            },
            async cancel() {},
            async respond() {},
        },
    });
}

describe('MachineSetupFlowScreen', () => {
    beforeEach(async () => {
        // Each case models a new app open. The coordinator intentionally retains unfinished
        // setup across route mounts, so a previous case's run must not belong to this app.
        vi.resetModules();
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        ambientRunnerRef.current = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'ambient:daemon.service.status.v1';
                },
                async subscribe(taskId, listenerSet) {
                    queueMicrotask(() => {
                        listenerSet.onResult({
                            protocolVersion: 1,
                            taskId,
                            ok: false,
                            error: { code: 'cli_unavailable', message: 'no local cli in this test' },
                        });
                    });
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        vi.useRealTimers();
        routerPushSpy.mockReset();
        setClipboardStringSafeSpy.mockReset();
        modalAlertSpy.mockReset();
        modalConfirmSpy.mockReset();
        modalConfirmSpy.mockResolvedValue(true);
        setPendingSetupIntentSpy.mockReset();
        machineRpcSpy.mockReset();
        machineRpcSpy.mockImplementation(async () => ({ ok: true }));
        activeServerSnapshotState = {
            serverId: 'relay-example',
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            generation: 1,
        };
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('renders local and SSH bootstrap entry points alongside the setup stages', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_local_smoke';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        expect(screen.findByTestId('settings.machineSetup.startLocalTask')?.props.title).toBe('settings.machineSetupCurrentMachineTitle');
        expect(screen.findByTestId('settings.machineSetup.startRemoteTask')?.props.title).toBe('settings.machineSetupSshMachineTitle');
        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')).toBeNull();
    });

    it('starts the local system task flow and renders task progress after the entry row is pressed', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const taskIdByKind = new Map<string, string>();
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    const taskId = `task_${nextTaskId++}`;
                    taskIdByKind.set(spec.kind, taskId);
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');

        const taskId = taskIdByKind.get('setup.thisComputer.v1');
        expect(taskId).toBeTruthy();
        await renderer.act(async () => {
            listeners.get(taskId!)?.onEvent({
                protocolVersion: 1,
                taskId: taskId!,
                tsMs: 100,
                type: 'progress',
                stepId: 'install.runtime',
                message: 'Installing runtime',
            });
        });

        const progressCard = findProgressCardByTitle(screen, 'settings.machineSetupCurrentMachineTitle');
        expect(progressCard).toBeTruthy();
        expect(findTextNodeByTestId(progressCard!, 'system-task-message')?.props.children).toBe('Installing runtime');
        expect(findTextNodeByTestId(progressCard!, 'system-task-step-label')?.props.children).toBe('settings.systemTaskStepInstallRuntime');
    });

    it('answers the local setup task\'s consent and pairing prompts through the shared setup owners (C6)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const {
            SystemTaskSpecSchema,
            createSetupPairingPromptData,
            createSetupServiceConsentPromptData,
        } = await import('@happier-dev/protocol');
        const { createServerUrlComparableKey } = await import('@/sync/domains/server/url/serverUrlCanonical');
        const { desktopSetupCoordinator } = await import('@/setup/desktopSetupCoordinator');

        // A resolved ambient inspection, so this exercises the ordinary desktop state. Install
        // ownership itself rides the executor's own prompt, not this read (INV2/R13).
        const ambientRunnerWithoutCli = ambientRunnerRef.current;
        ambientRunnerRef.current = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'ambient:daemon.service.status.v1';
                },
                async subscribe(taskId, listenerSet) {
                    queueMicrotask(() => {
                        listenerSet.onResult({
                            protocolVersion: 1,
                            taskId,
                            ok: true,
                            data: { acquisition: { command: '/managed/happier', provenance: 'managed' } },
                        });
                    });
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        await desktopSetupCoordinator.inspect({ fresh: true });

        try {
            const answers: unknown[] = [];
            let nextTaskId = 1;
            const taskIdByKind = new Map<string, string>();
            const listeners = new Map<string, {
                onEvent: (payload: unknown) => void;
                onResult: (payload: unknown) => void;
            }>();

            const runner = createSystemTaskRunner({
                bridge: {
                    async start(spec) {
                        const parsed = SystemTaskSpecSchema.parse(spec);
                        const taskId = `task_${nextTaskId++}`;
                        taskIdByKind.set(parsed.kind, taskId);
                        return taskId;
                    },
                    async subscribe(taskId, listenerSet) {
                        listeners.set(taskId, listenerSet);
                        return () => {
                            listeners.delete(taskId);
                        };
                    },
                    async cancel() {},
                    async respond(_taskId, answer) {
                        answers.push(answer);
                    },
                },
            });

            const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
            const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

            await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');
            const setupTaskId = taskIdByKind.get('setup.thisComputer.v1');
            expect(setupTaskId).toBeTruthy();

            // The executor asks for the service-ownership decision before it mutates anything (UD5).
            await renderer.act(async () => {
                listeners.get(setupTaskId!)?.onEvent({
                    protocolVersion: 1,
                    taskId: setupTaskId!,
                    tsMs: 100,
                    type: 'prompt',
                    stepId: 'setup.thisComputer.serviceConsent',
                    message: 'Another service already manages this computer',
                    data: createSetupServiceConsentPromptData({
                        takeover: 'com.example.other',
                        message: 'Another service owns this computer.',
                        competingServices: ['com.example.other'],
                        servicesToRemove: [],
                    }),
                });
            });
            expect(modalConfirmSpy).toHaveBeenCalled();
            expect(answers).toContainEqual({ approved: true });

            // ...and then for pairing approval. A `v3` requirement is refused by the approval owner
            // itself, which is what tells "the owner ran and failed closed" apart from "no owner was
            // wired, so the prompt was declined by name and setup dead-ends".
            const relayUrl = 'https://relay.example.test';
            await renderer.act(async () => {
                listeners.get(setupTaskId!)?.onEvent({
                    protocolVersion: 1,
                    taskId: setupTaskId!,
                    tsMs: 200,
                    type: 'prompt',
                    stepId: 'setup.thisComputer.authRequest',
                    message: 'Approve this computer in Happier to continue',
                    data: createSetupPairingPromptData({
                        publicKeyB64Url: 'cHVibGljLWtleQ',
                        relayUrl,
                        serverIdentityKey: createServerUrlComparableKey(relayUrl),
                        accountId: 'acct_app',
                        pairingRequirement: 'v3',
                        cliProvenance: 'managed',
                        cliCommand: '/managed/happier',
                    }),
                });
            });
            expect(answers).toContainEqual({ approved: false, reason: 'pairing_requirement_v3' });
            expect(answers).not.toContainEqual({ approved: false, reason: 'approval_unavailable' });
        } finally {
            ambientRunnerRef.current = ambientRunnerWithoutCli;
            await desktopSetupCoordinator.inspect({ fresh: true }).catch(() => {});
        }
    });

    it('treats a not_authenticated local setup result as a guided follow-up instead of a hard failure', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const taskIdByKind = new Map<string, string>();
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    const taskId = `task_${nextTaskId++}`;
                    taskIdByKind.set(parsed.kind, taskId);
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');
        const setupTaskId = taskIdByKind.get('setup.thisComputer.v1');
        expect(setupTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(setupTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: setupTaskId!,
                ok: false,
                error: {
                    code: 'not_authenticated',
                    message: 'Authenticate this computer with the selected Relay before continuing.',
                },
            });
        });

        const progressCard = findProgressCardByTitle(screen, 'settings.machineSetupCurrentMachineTitle');
        expect(progressCard).toBeTruthy();
        const statusItem = progressCard!.findByProps({ testID: 'system-task-progress-status-running' });
        const statusTitle = statusItem.findAllByType('Text' as never)[0]?.props?.children;
        expect(statusTitle).toBe('settings.machineSetupTaskWaitingForInput');

        expect(screen.findByTestId('settings.machineSetup.localSetupFollowUp.authenticate')).toBeTruthy();
        expect(screen.findByTestId('settings.machineSetup.localSetupFollowUp.authenticate')?.props.title).toBe('common.authenticate');

        await screen.pressByTestIdAsync('settings.machineSetup.localSetupFollowUp.authenticate');
        expect(taskIdByKind.get('relay.connectBackgroundService.v1')).toBeFalsy();
        expect(setPendingSetupIntentSpy).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/server?url=https%3A%2F%2Frelay.example.test&auto=1');
    });

    it('shows a recoverable error when the local system task bridge is unavailable', async () => {
        const runner = {
            mode: 'tauri' as const,
            async start() {
                throw new Error('system_tasks_unavailable');
            },
            async cancel() {},
            async respond() {},
            getSnapshot() {
                return null;
            },
            subscribe() {
                return () => {};
            },
        };

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');

        expect(screen.findByTestId('settings.machineSetup.startError')).toBeTruthy();
        expect(screen.findByTestId('settings.machineSetup.startError')?.props.subtitle).toBe('settings.systemTaskBridgeUnavailable');
    });

    it('adopts an existing installation only through the same canonical readiness proof', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        await installAmbientResult(convergedAmbientResult);
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        expect(screen.findAllByType('ProviderSetupFlow' as any)).toHaveLength(0);

        await screen.pressByTestIdAsync('settings.machineSetup.adoptExisting');
        await renderer.act(async () => {});

        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        const providerFlows = screen.findAllByType('ProviderSetupFlow' as any);
        expect(providerFlows).toHaveLength(1);
        expect(providerFlows[0]?.props.machineId).toBe('machine-local-1');
    });

    it('does not adopt a daemon that is running but not this relay\'s, and says so (D1/INV8)', async () => {
        // Service installed + a live PID + credentials on disk is exactly the state that looked
        // ready and was not: the running daemon carries a different machine id.
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        await installAmbientResult((taskId) => convergedAmbientResult(taskId, {
            runtimeConvergence: {
                controlReachable: true,
                serviceOwnsRunningDaemon: true,
                machineIdMatches: false,
                cliVersionMatches: true,
            },
        }));
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_unused';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.adoptExisting');
        await renderer.act(async () => {});

        expect(machineRpcSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('ProviderSetupFlow' as any)).toHaveLength(0);
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'settings.machineSetupAdoptExistingNotReady');
    });

    it('shows a generic start failure when the local setup task fails for an unknown reason', async () => {
        const runner = {
            mode: 'tauri' as const,
            async start() {
                throw new Error('boom');
            },
            async cancel() {},
            async respond() {},
            getSnapshot() {
                return null;
            },
            subscribe() {
                return () => {};
            },
        };

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');

        expect(screen.findByTestId('settings.machineSetup.startError')).toBeTruthy();
        expect(screen.findByTestId('settings.machineSetup.startError')?.props.subtitle).toBe('settings.systemTaskStartFailed');
    });

    it('does not present a ready machine on task success alone: the canonical proof decides (INV8/INV10)', async () => {
        // A service command can succeed while the running daemon carries the wrong identity, or
        // while the relay cannot reach this computer at all. Reading `machineId` off the task
        // result was a second readiness definition, and this is the case it got wrong.
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        await installAmbientResult(convergedAmbientResult);
        machineRpcSpy.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms');
        });

        const taskIdByKind = new Map<string, string>();
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    taskIdByKind.set(parsed.kind, 'task_setup_1');
                    return 'task_setup_1';
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => listeners.delete(taskId);
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');
        await renderer.act(async () => {
            listeners.get('task_setup_1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_setup_1',
                ok: true,
                data: { machineId: 'machine-local-1' },
            });
        });
        await renderer.act(async () => {});

        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
        expect(screen.findAllByType('ProviderSetupFlow' as any)).toHaveLength(0);
        expect(screen.findByTestId('settings.machineSetup.localReadinessBlocked')).toBeTruthy();
    });

    it('shows the canonical provider setup flow after the local setup task succeeds', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const taskIdByKind = new Map<string, string>();
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    const taskId = `task_${nextTaskId++}`;
                    taskIdByKind.set(parsed.kind, taskId);
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const inspectionKinds: string[] = [];
        await installAmbientResult(convergedAmbientResult, (kind) => inspectionKinds.push(kind));
        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');
        const setupTaskId = taskIdByKind.get('setup.thisComputer.v1');
        expect(setupTaskId).toBeTruthy();
        const inspectionsBeforeSuccess = inspectionKinds.length;

        await renderer.act(async () => {
            listeners.get(setupTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: setupTaskId!,
                ok: true,
                data: { machineId: 'machine-1' },
            });
        });
        await renderer.act(async () => {});

        // The machine id comes from the proven runtime, never from the task's own result.
        const providerFlows = screen.findAllByType('ProviderSetupFlow' as any);
        expect(providerFlows).toHaveLength(1);
        expect(providerFlows[0]?.props.machineId).toBe('machine-local-1');
        // Setup owns one fresh read shared by every reader; readiness consumes it, without
        // starting a second managed-CLI acquisition for the same successful operation.
        expect(inspectionKinds.slice(inspectionsBeforeSuccess)).toEqual(['daemon.service.status.v1']);
        expect(machineRpcSpy).toHaveBeenCalledTimes(1);
    });

    it('starts no local setup task on mount — auto-start belongs to the desktop setup gate alone (R9/INV1)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const starts: unknown[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    starts.push(SystemTaskSpecSchema.parse(spec));
                    return 'task_auto_start';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        expect(starts.map((entry) => (entry as { kind?: unknown }).kind)).not.toContain('setup.thisComputer.v1');
    });

    it('does not show the provider setup flow when the local setup task succeeds without a machine id', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const taskIdByKind = new Map<string, string>();
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    const taskId = `task_${nextTaskId++}`;
                    taskIdByKind.set(parsed.kind, taskId);
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');
        const setupTaskId = taskIdByKind.get('setup.thisComputer.v1');
        expect(setupTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(setupTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: setupTaskId!,
                ok: true,
                data: {},
            });
        });

        const providerFlows = screen.findAllByType('ProviderSetupFlow' as any);
        expect(providerFlows).toHaveLength(0);
    });

    it('starts remote bootstrap against the public relay identity when the app is using a local relay alias', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        activeServerSnapshotState = {
            serverId: 'relay-example',
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3012',
            generation: 2,
        };

        let nextTaskId = 1;
        const taskIdByKind = new Map<string, string>();
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    expect(parsed.kind).toBe('remote.ssh.bootstrapMachine.v1');
                    expect(parsed.params).toMatchObject({
                        ssh: {
                            target: 'dev@example.test',
                            auth: 'agent',
                        },
                        relay: {
                            relayUrl: 'http://127.0.0.1:3012',
                            webappUrl: 'https://relay.example.test',
                            publicRelayUrl: 'https://relay.example.test',
                        },
                        serviceMode: 'user',
                        knownHostsMode: 'app',
                    });
                    const taskId = `task_${nextTaskId++}`;
                    taskIdByKind.set(parsed.kind, taskId);
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startRemoteTask');
        await renderer.act(async () => {
            screen.changeTextByTestId('settings.machineSetup.remoteSshTargetInput', 'dev@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');

        const taskId = taskIdByKind.get('remote.ssh.bootstrapMachine.v1');
        expect(taskId).toBeTruthy();
        await renderer.act(async () => {
            listeners.get(taskId!)?.onEvent({
                protocolVersion: 1,
                taskId: taskId!,
                tsMs: 100,
                type: 'progress',
                stepId: 'ssh.installCli',
                message: 'Installing Happier on the remote machine',
            });
        });

        const progressCard = findProgressCardByTitle(screen, 'settings.machineSetupSshMachineTitle');
        expect(progressCard).toBeTruthy();
        expect(findTextNodeByTestId(progressCard!, 'system-task-message')?.props.children).toBe('Installing Happier on the remote machine');
    });

    it('can include remote relay runtime installation when the user opts into running a Relay on that machine', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const starts: unknown[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    starts.push(SystemTaskSpecSchema.parse(spec));
                    return 'task_remote_relay';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startRemoteTask');
        await renderer.act(async () => {
            screen.changeTextByTestId('settings.machineSetup.remoteSshTargetInput', 'dev@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteRelayRuntime');
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');

        const remoteStarts = starts.filter((entry) => (entry as { kind?: unknown }).kind === 'remote.ssh.bootstrapMachine.v1');
        expect(remoteStarts).toHaveLength(1);
        expect((remoteStarts[0] as { params?: unknown }).params).toMatchObject({
            relayRuntime: {
                enabled: true,
                mode: 'user',
            },
        });
    });

    it('restarts remote bootstrap with an explicit host-trust resolution after a prompt_required result', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];
        const remoteTaskIds: string[] = [];
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    const taskId = `task_${nextTaskId++}`;
                    if (parsed.kind === 'remote.ssh.bootstrapMachine.v1') {
                        remoteTaskIds.push(taskId);
                    }
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startRemoteTask');
        await renderer.act(async () => {
            screen.changeTextByTestId('settings.machineSetup.remoteSshTargetInput', 'dev@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');
        const initialRemoteTaskId = remoteTaskIds[0];
        expect(initialRemoteTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(initialRemoteTaskId!)?.onEvent({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                tsMs: 100,
                type: 'prompt',
                stepId: 'ssh.hostTrust',
                message: 'Trust this SSH host?',
                data: {
                    kind: 'ssh.trustHost',
                    host: 'example.test',
                    keyType: 'ssh-ed25519',
                    fingerprint: 'SHA256:abc',
                },
            });
            listeners.get(initialRemoteTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                ok: false,
                error: {
                    code: 'prompt_required',
                    message: 'Trust this SSH host?',
                },
            });
        });

        const promptCard = screen.findByTestId('settings.machineSetup.remotePromptCard');
        expect(promptCard).toBeTruthy();
        const promptCardNode = promptCard!;
        expect(String(promptCardNode.props.subtitle ?? '')).toContain('example.test');
        expect(String(promptCardNode.props.subtitle ?? '')).toContain('SHA256:abc');
        expect(screen.findByTestId('settings.machineSetup.remotePromptCard-primary')?.props.title)
            .toBe('settings.machineSetupRemotePromptTrustAction');

        await screen.pressByTestIdAsync('settings.machineSetup.remotePromptCard-primary');

        const remoteStarts = starts.filter((entry) => (entry as { kind?: unknown }).kind === 'remote.ssh.bootstrapMachine.v1');
        expect(remoteStarts).toHaveLength(2);
        expect((remoteStarts[1] as { params?: unknown }).params).toMatchObject({
            promptResolution: {
                hostTrust: {
                    kind: 'ssh.trustHost',
                    fingerprint: 'SHA256:abc',
                },
            },
        });
    });

    it('retries remote bootstrap without attempting a prompt response while the host-trust prompt is still pending', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];
        const remoteTaskIds: string[] = [];
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const cancelMock = vi.fn(async (_taskId: string) => {});
        const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {
            throw new Error('respond should not be called while remote bootstrap is still pending');
        });

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    const taskId = `task_${nextTaskId++}`;
                    if (parsed.kind === 'remote.ssh.bootstrapMachine.v1') {
                        remoteTaskIds.push(taskId);
                    }
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel(taskId) {
                    await cancelMock(taskId);
                },
                async respond(taskId, answer) {
                    await respondMock(taskId, answer);
                },
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startRemoteTask');
        await renderer.act(async () => {
            screen.changeTextByTestId('settings.machineSetup.remoteSshTargetInput', 'dev@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');
        const initialRemoteTaskId = remoteTaskIds[0];
        expect(initialRemoteTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(initialRemoteTaskId!)?.onEvent({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                tsMs: 100,
                type: 'prompt',
                stepId: 'ssh.hostTrust',
                message: 'Trust this SSH host?',
                data: {
                    kind: 'ssh.trustHost',
                    host: 'example.test',
                    keyType: 'ssh-ed25519',
                    fingerprint: 'SHA256:abc',
                },
            });
        });

        expect(screen.findByTestId('settings.machineSetup.remotePromptCard')).toBeTruthy();

        await screen.pressByTestIdAsync('settings.machineSetup.remotePromptCard-primary');

        expect(cancelMock).toHaveBeenCalledWith(initialRemoteTaskId);
        expect(respondMock).not.toHaveBeenCalled();

        const remoteStarts = starts.filter((entry) => (entry as { kind?: unknown }).kind === 'remote.ssh.bootstrapMachine.v1');
        expect(remoteStarts).toHaveLength(2);
        expect((remoteStarts[1] as { params?: unknown }).params).toMatchObject({
            promptResolution: {
                hostTrust: {
                    kind: 'ssh.trustHost',
                    fingerprint: 'SHA256:abc',
                },
            },
        });
    });

    it('restarts remote bootstrap with desktop approval enabled and shows provider follow-up after success', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];
        const remoteTaskIds: string[] = [];
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    const taskId = `task_${nextTaskId++}`;
                    if (parsed.kind === 'remote.ssh.bootstrapMachine.v1') {
                        remoteTaskIds.push(taskId);
                    }
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startRemoteTask');
        await renderer.act(async () => {
            screen.changeTextByTestId('settings.machineSetup.remoteSshTargetInput', 'dev@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');
        const initialRemoteTaskId = remoteTaskIds[0];
        expect(initialRemoteTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(initialRemoteTaskId!)?.onEvent({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                tsMs: 100,
                type: 'prompt',
                stepId: 'ssh.auth.approval',
                message: 'Approve remote machine pairing',
                data: {
                    kind: 'auth.approveRemoteProvisioning',
                    publicKey: 'ssh-ed25519 AAA',
                },
            });
            listeners.get(initialRemoteTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                ok: false,
                error: {
                    code: 'prompt_required',
                    message: 'Approve remote machine pairing',
                },
            });
        });

        expect(screen.findByTestId('settings.machineSetup.remotePromptCard-primary')?.props.title)
            .toBe('settings.machineSetupRemotePromptApproveAction');
        await screen.pressByTestIdAsync('settings.machineSetup.remotePromptCard-primary');

        const remoteStarts = starts.filter((entry) => (entry as { kind?: unknown }).kind === 'remote.ssh.bootstrapMachine.v1');
        expect(remoteStarts).toHaveLength(2);
        expect((remoteStarts[1] as { params?: unknown }).params).toMatchObject({
            promptResolution: {
                authApproval: {
                    publicKey: 'ssh-ed25519 AAA',
                },
            },
        });
        const secondRemoteTaskId = remoteTaskIds[1];
        expect(secondRemoteTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(secondRemoteTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: secondRemoteTaskId!,
                ok: true,
                data: {
                    machineId: 'machine-remote-1',
                    relayRuntime: {
                        relayUrl: 'https://relay.remote.example.test',
                        mode: 'user',
                    },
                },
            });
        });

        expect(screen.findByTestId('settings.machineSetup.remoteRelayRuntimeUrl')?.props.subtitle).toBe('https://relay.remote.example.test');
        expect(screen.findByTestId('settings.machineSetup.remoteRelayKeepCurrent')?.props.title).toBe('settings.machineSetupRemoteRelayKeepCurrentTitle');
        expect(screen.findByTestId('settings.machineSetup.remoteRelaySwitch')?.props.title).toBe('settings.machineSetupRemoteRelaySwitchTitle');
        const providerFlows = screen.findAllByType('ProviderSetupFlow' as any);
        expect(providerFlows).toHaveLength(1);
        expect(providerFlows[0]?.props.machineId).toBe('machine-remote-1');

        await screen.pressByTestIdAsync('settings.machineSetup.copyRemoteRelayUrl');
        expect(setClipboardStringSafeSpy).toHaveBeenCalledWith('https://relay.remote.example.test');
        expect(modalAlertSpy).not.toHaveBeenCalledWith('common.copied', 'items.copiedToClipboard');
        expect(screen.findByTestId('settings.machineSetup.copyRemoteRelayUrl')?.props.rightElement?.props.testID)
            .toBe('settings.machineSetup.copyRemoteRelayUrl.copied');

        await screen.pressByTestIdAsync('settings.machineSetup.remoteRelayKeepCurrent');
        expect(setPendingSetupIntentSpy).not.toHaveBeenCalled();
        expect(routerPushSpy).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings.machineSetup.remoteRelaySwitch');
        expect(modalConfirmSpy).toHaveBeenCalled();
        expect(upsertAndActivateServerSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://relay.remote.example.test',
        }));
        expect(switchConnectionToActiveServerSpy).toHaveBeenCalled();
        expect(setPendingSetupIntentSpy).toHaveBeenCalledWith({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/server?url=https%3A%2F%2Frelay.remote.example.test&auto=1');
    });

    it('clears a stale remote prompt when the relay runtime toggle changes before retrying', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];
        const remoteTaskIds: string[] = [];
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    const taskId = `task_${nextTaskId++}`;
                    if (parsed.kind === 'remote.ssh.bootstrapMachine.v1') {
                        remoteTaskIds.push(taskId);
                    }
                    return taskId;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startRemoteTask');
        await renderer.act(async () => {
            screen.changeTextByTestId('settings.machineSetup.remoteSshTargetInput', 'dev@example.test');
        });
        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');
        const initialRemoteTaskId = remoteTaskIds[0];
        expect(initialRemoteTaskId).toBeTruthy();

        await renderer.act(async () => {
            listeners.get(initialRemoteTaskId!)?.onEvent({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                tsMs: 100,
                type: 'prompt',
                stepId: 'ssh.hostTrust',
                message: 'Trust this SSH host?',
                data: {
                    kind: 'ssh.trustHost',
                    host: 'example.test',
                    keyType: 'ssh-ed25519',
                    fingerprint: 'SHA256:abc',
                },
            });
            listeners.get(initialRemoteTaskId!)?.onResult({
                protocolVersion: 1,
                taskId: initialRemoteTaskId!,
                ok: false,
                error: {
                    code: 'prompt_required',
                    message: 'Trust this SSH host?',
                },
            });
        });

        expect(screen.findByTestId('settings.machineSetup.remotePromptCard')).toBeTruthy();

        await screen.pressByTestIdAsync('settings.machineSetup.remoteRelayRuntime');

        expect(screen.findByTestId('settings.machineSetup.remotePromptCard')).toBeNull();

        await screen.pressByTestIdAsync('settings.machineSetup.remoteStart');

        const remoteStarts = starts.filter((entry) => (entry as { kind?: unknown }).kind === 'remote.ssh.bootstrapMachine.v1');
        expect(remoteStarts).toHaveLength(2);
        expect((remoteStarts[1] as { params?: unknown }).params).toMatchObject({
            relayRuntime: {
                enabled: true,
                mode: 'user',
            },
        });
        expect((remoteStarts[1] as { params?: unknown }).params).not.toMatchObject({
            promptResolution: {
                hostTrust: expect.anything(),
            },
        });
    });
});
