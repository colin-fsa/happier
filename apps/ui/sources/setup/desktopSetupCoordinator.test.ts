import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskSpec } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const mocks = vi.hoisted(() => ({
    runner: {
        start: vi.fn(async (_spec: SystemTaskSpec) => 'task_status_1'),
        cancel: vi.fn(async () => {}),
        respond: vi.fn(async () => {}),
        getSnapshot: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
        mode: 'dev' as const,
    },
    activeServer: {
        serverId: 'custom-2',
        serverUrl: 'https://relay.example.test',
        activeLocalRelayUrl: null as string | null,
        generation: 1,
    },
    accountId: 'acct_app' as string | null,
    alwaysMove: false,
    rememberAlwaysMove: vi.fn(() => {}),
    kept: null as { relayKey: string; accountId: string | null } | null,
    rememberKept: vi.fn((_identity: unknown) => {}),
    machineRpc: vi.fn(async (_params: unknown) => ({ ok: true }) as unknown),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => mocks.machineRpc(params),
}));

vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => mocks.runner,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => mocks.activeServer,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => (mocks.accountId ? { serverId: mocks.activeServer.serverId, accountId: mocks.accountId } : null),
}));

vi.mock('./desktopRelayMovePreference', () => ({
    readAlwaysMoveDefaultFollowingService: () => mocks.alwaysMove,
    rememberAlwaysMoveDefaultFollowingService: () => mocks.rememberAlwaysMove(),
    readKeptBackgroundService: () => mocks.kept,
    rememberKeptBackgroundService: (identity: unknown) => mocks.rememberKept(identity),
}));

const AMBIENT_RESULT = {
    protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
    taskId: 'task_status_1',
    ok: true as const,
    data: {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: 'machine-1',
        acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
        server: {
            activeServerId: 'custom-2',
            serverUrl: 'https://relay.example.test',
            publicServerUrl: 'https://relay.example.test',
            localServerUrl: null,
            comparableKey: 'https://relay.example.test',
        },
        auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-1',
            needsAuth: false,
            accountId: 'acct_app',
            credentialState: 'valid',
            validatedAccountId: 'acct_app',
        },
        service: { installed: true, running: true, targetMode: 'default-following' },
        daemon: { running: true, startedWithCliVersion: '0.2.13', serviceManaged: true, serviceLabel: 'com.happier.cli.daemon.default' },
        runtimeConvergence: {
            controlReachable: true,
            serviceOwnsRunningDaemon: true,
            machineIdMatches: true,
            cliVersionMatches: true,
        },
    },
};

function resolveWith(result: unknown, options: Readonly<{ taskId?: string }> = {}): void {
    const taskId = options.taskId ?? 'task_status_1';
    mocks.runner.start.mockImplementation(async () => taskId);
    mocks.runner.subscribe.mockImplementation(((_taskId: string, _onEvent: unknown, onResult: unknown) => {
        if (typeof onResult === 'function') {
            (onResult as (value: unknown) => void)(result);
        }
        return () => {};
    }) as never);
}

async function importCoordinator() {
    return await import('./desktopSetupCoordinator');
}

describe('desktopSetupCoordinator', () => {
    it('keeps post-setup facts and task identity when an older tray inspection starts and settles late', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { buildLocalMachineSetupSystemTaskSpec } = await import('@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec');
        const { createDesktopSetupCoordinator } = await importCoordinator();
        const callbacks = new Map<string, import('@/components/systemTasks/types').SystemTaskBridgeListenerSet>();
        const olderStart: { finish: ((taskId: string) => void) | null } = { finish: null };
        let inspections = 0;
        const runner = createSystemTaskRunner({ bridge: {
            start: async (spec) => {
                if (spec.kind === 'setup.thisComputer.v1') return 'setup_overlap';
                inspections += 1;
                if (inspections === 2) return await new Promise<string>((resolve) => { olderStart.finish = resolve; });
                return `status_${inspections}`;
            },
            subscribe: async (id, listeners) => { callbacks.set(id, listeners); return () => callbacks.delete(id); },
            cancel: async () => {}, respond: async () => {},
        } });
        const coordinator = createDesktopSetupCoordinator({ runner: () => runner });
        const staleResult = (taskId: string) => ({ ...AMBIENT_RESULT, taskId, data: {
            ...AMBIENT_RESULT.data, server: { ...AMBIENT_RESULT.data.server, serverUrl: 'https://old-relay.example.test' },
        } });
        const opening = coordinator.inspect();
        await vi.waitFor(() => expect(callbacks.has('status_1')).toBe(true));
        callbacks.get('status_1')!.onResult(staleResult('status_1'));
        await opening;
        await coordinator.launchSetupTask({ runner, onEvent: () => {}, spec: buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test', activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: null, channel: 'stable', expectedAccountId: 'acct_app',
        }) });
        await vi.waitFor(() => expect(callbacks.has('setup_overlap')).toBe(true));
        coordinator.refreshOnTrayPointer();
        await vi.waitFor(() => expect(olderStart.finish).not.toBeNull());
        const olderInspection = coordinator.inspect();
        callbacks.get('setup_overlap')!.onResult({ protocolVersion: 1, taskId: 'setup_overlap', ok: true, data: {} });
        await vi.waitFor(() => expect(callbacks.has('status_3')).toBe(true));
        callbacks.get('status_3')!.onResult({ ...AMBIENT_RESULT, taskId: 'status_3' });
        await coordinator.inspect();
        expect(coordinator.readInspectionTaskId()).toBe('status_3');
        expect(coordinator.readInspectionSnapshot()).toMatchObject({ facts: { server: { serverUrl: 'https://relay.example.test' } } });

        if (!olderStart.finish) throw new Error('The older inspection did not reach the bridge');
        olderStart.finish('status_2');
        await vi.waitFor(() => expect(callbacks.has('status_2')).toBe(true));
        expect.soft(coordinator.readInspectionTaskId()).toBe('status_3');
        callbacks.get('status_2')!.onResult(staleResult('status_2'));
        // The old caller receives its own requested result, without republishing it to readers.
        await expect(olderInspection).resolves.toMatchObject({ facts: { server: { serverUrl: 'https://old-relay.example.test' } } });
        expect.soft(coordinator.readInspectionSnapshot()).toMatchObject({ facts: { server: { serverUrl: 'https://relay.example.test' } } });
        expect(coordinator.readInspectionTaskId()).toBe('status_3');
    });

    it('refreshes shared local facts when retained setup succeeds after its reader leaves', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { buildLocalMachineSetupSystemTaskSpec } = await import('@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec');
        const { createDesktopSetupCoordinator } = await importCoordinator();
        const setupResult: { finish: import('@/components/systemTasks/types').SystemTaskBridgeListenerSet['onResult'] | null } = { finish: null };
        let repaired = false;
        const runner = createSystemTaskRunner({ bridge: {
            start: async (spec) => spec.kind === 'setup.thisComputer.v1' ? 'retained_setup' : `status_${repaired}`,
            subscribe: async (taskId, listeners) => {
                if (taskId === 'retained_setup') {
                    setupResult.finish = listeners.onResult;
                } else {
                    queueMicrotask(() => listeners.onResult({
                        ...AMBIENT_RESULT,
                        taskId,
                        data: { ...AMBIENT_RESULT.data, server: {
                            ...AMBIENT_RESULT.data.server,
                            serverUrl: repaired ? 'https://relay.example.test' : 'https://old-relay.example.test',
                        } },
                    }));
                }
                return () => {};
            },
            cancel: async () => {}, respond: async () => {},
        } });
        const coordinator = createDesktopSetupCoordinator({ runner: () => runner });
        await coordinator.inspect();
        expect(coordinator.readInspectionSnapshot()).toMatchObject({
            facts: { server: { serverUrl: 'https://old-relay.example.test' } },
        });
        const unsubscribeReader = coordinator.subscribe(() => {});
        await coordinator.launchSetupTask({ runner, onEvent: () => {}, spec: buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test', activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: null, channel: 'stable', expectedAccountId: 'acct_app',
        }) });
        unsubscribeReader();
        repaired = true;
        if (!setupResult.finish) throw new Error('The setup bridge did not subscribe');
        setupResult.finish({ protocolVersion: 1, taskId: 'retained_setup', ok: true, data: {} });
        await vi.waitFor(() => expect(coordinator.readInspectionSnapshot()).toMatchObject({
            facts: { server: { serverUrl: 'https://relay.example.test' } },
        }));
    });

    it('answers every native tray demand with a read, joining one that is already running (A12-03/N-8)', async () => {
        // The native side owns the one pointer bound and only emits demands that pass it (N-8).
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { createDesktopSetupCoordinator } = await importCoordinator();
        const callbacks = new Map<string, import('@/components/systemTasks/types').SystemTaskBridgeListenerSet>();
        let starts = 0;
        const runner = createSystemTaskRunner({ bridge: {
            start: async () => `status_${++starts}`,
            subscribe: async (id, listeners) => { callbacks.set(id, listeners); return () => callbacks.delete(id); },
            cancel: async () => {}, respond: async () => {},
        } });
        const settle = async () => {
            for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
            for (const [id, listeners] of Array.from(callbacks)) {
                listeners.onResult({ ...AMBIENT_RESULT, taskId: id });
                callbacks.delete(id);
            }
            for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        };
        const coordinator = createDesktopSetupCoordinator({ runner: () => runner });
        const opening = coordinator.inspect();
        await settle();
        await opening;
        const afterOpen = starts;

        // Demands while a read runs join it.
        coordinator.refreshOnTrayPointer();
        coordinator.refreshOnTrayPointer();
        await settle();
        expect(starts).toBe(afterOpen + 1);

        // Every later demand the native side sends reads again — no second bound here.
        coordinator.refreshOnTrayPointer();
        await settle();
        expect(starts).toBe(afterOpen + 2);
    });

    it('exposes the shared ambient task to late readers and preserves settled readiness during a refresh', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { createDesktopSetupCoordinator } = await importCoordinator();
        const callbacks = new Map<string, import('@/components/systemTasks/types').SystemTaskBridgeListenerSet>();
        let counter = 0;
        const runner = createSystemTaskRunner({ bridge: {
            start: async () => `ambient_${++counter}`,
            subscribe: async (id, listeners) => { callbacks.set(id, listeners); return () => callbacks.delete(id); },
            cancel: async () => {}, respond: async () => {},
        } });
        const coordinator = createDesktopSetupCoordinator({ runner: () => runner });
        const pending = coordinator.inspect();
        await vi.waitFor(() => expect(callbacks.has('ambient_1')).toBe(true));
        callbacks.get('ambient_1')!.onEvent({ protocolVersion: 1, taskId: 'ambient_1', tsMs: 1,
            type: 'cli.acquisition.progress', stepId: 'setup.thisComputer.ensureCli', data: { phase: 'downloading', receivedBytes: 8192 } });
        const taskId = coordinator.readInspectionTaskId();
        expect(taskId).toBe('ambient_1');
        expect(runner.getSnapshot(taskId!)?.events[0]?.data).toEqual({ phase: 'downloading', receivedBytes: 8192 });
        expect(coordinator.readInspectionSnapshot()).toEqual({ status: 'pending' });
        callbacks.get('ambient_1')!.onResult({ ...AMBIENT_RESULT, taskId: 'ambient_1' });
        await pending;
        const settled = coordinator.readInspectionSnapshot();
        const refreshing = coordinator.inspect({ fresh: true });
        expect(coordinator.readInspectionTaskId()).toBeNull();
        expect(coordinator.readInspectionSnapshot()).toBe(settled);
        await vi.waitFor(() => expect(callbacks.has('ambient_2')).toBe(true));
        expect(coordinator.readInspectionTaskId()).toBe('ambient_2');
        callbacks.get('ambient_2')!.onResult({ ...AMBIENT_RESULT, taskId: 'ambient_2' });
        await refreshing;
    });

    beforeEach(() => {
        vi.resetModules();
        mocks.runner.start.mockClear();
        mocks.runner.subscribe.mockReset();
        mocks.accountId = 'acct_app';
        mocks.alwaysMove = false;
        mocks.rememberAlwaysMove.mockClear();
        mocks.kept = null;
        mocks.rememberKept.mockClear();
        mocks.machineRpc.mockReset();
        mocks.machineRpc.mockImplementation(async () => ({ ok: true }));
        mocks.activeServer = {
            serverId: 'custom-2',
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            generation: 1,
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('runs one ambient inspection per app open and projects the CLI facts', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        const [first, second] = await Promise.all([desktopSetupCoordinator.inspect(), desktopSetupCoordinator.inspect()]);

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
        expect(first).toMatchObject({
            status: 'resolved',
            facts: {
                acquisition: { command: '/home/user/.happier/cli/current/happier', provenance: 'managed' },
                auth: { credentialState: 'valid', validatedAccountId: 'acct_app' },
                runtimeConvergence: { controlReachable: true, machineIdMatches: true },
            },
        });
    });

    it('publishes the one observation to every reader instead of handing each a promise snapshot (F6)', async () => {
        // Two readers, one fact. A reader that snapshots the promise keeps whatever it saw when it
        // mounted, so a fresh read by anyone else — the gate after setup, the toggle after a
        // change, the banner's refresh — reached nobody: the tray kept a title from app open and
        // the settings row beside a repaired daemon still said it was not running.
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        const seen: string[] = [];
        const unsubscribe = desktopSetupCoordinator.subscribe(() => {
            seen.push(desktopSetupCoordinator.readInspectionSnapshot().status);
        });

        try {
            expect(desktopSetupCoordinator.readInspectionSnapshot()).toEqual({ status: 'pending' });
            await desktopSetupCoordinator.inspect();

            expect(desktopSetupCoordinator.readInspectionSnapshot()).toMatchObject({ status: 'resolved' });
            // Start, task availability, and settlement are published; byte samples stay in the runner.
            expect(seen).toEqual(['pending', 'pending', 'resolved']);
            // Referentially stable, so `useSyncExternalStore` readers do not re-render on a read.
            expect(desktopSetupCoordinator.readInspectionSnapshot()).toBe(desktopSetupCoordinator.readInspectionSnapshot());

            await desktopSetupCoordinator.inspect({ fresh: true });
            expect(seen).toEqual(['pending', 'pending', 'resolved', 'resolved', 'resolved', 'resolved']);
        } finally {
            unsubscribe();
        }

        await desktopSetupCoordinator.inspect({ fresh: true });
        expect(seen).toHaveLength(6);
    });

    it('keeps the last settled facts while a fresh read is in flight (last-known-good)', async () => {
        // `apps/ui/AGENTS.md`: never flash an empty state over hydrated state. Publishing `pending`
        // the moment a re-read starts took the drift banner and the tray title away from surfaces
        // that were already showing true facts about this computer, for as long as the CLI took to
        // answer. The read being in flight is its own fact, reported separately.
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        const settled = await desktopSetupCoordinator.inspect();
        expect(settled).toMatchObject({ status: 'resolved' });

        // A read that never answers, so the in-flight window is observable.
        mocks.runner.subscribe.mockImplementation(((() => () => {}) as never));
        void desktopSetupCoordinator.inspect({ fresh: true });

        expect(desktopSetupCoordinator.readInspectionRefreshing()).toBe(true);
        expect(desktopSetupCoordinator.readInspectionSnapshot()).toBe(settled);
    });

    it('reports pending only until the first read has ever settled', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        expect(desktopSetupCoordinator.readInspectionSnapshot()).toEqual({ status: 'pending' });
        expect(desktopSetupCoordinator.readInspectionRefreshing()).toBe(false);

        await desktopSetupCoordinator.inspect();

        expect(desktopSetupCoordinator.readInspectionRefreshing()).toBe(false);
        expect(desktopSetupCoordinator.readInspectionSnapshot()).toMatchObject({ status: 'resolved' });
    });

    it('starts no second inspection when the footer relay changes; the UI re-compares the same facts', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        const afterChange = await desktopSetupCoordinator.inspect();

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(afterChange).toMatchObject({ status: 'resolved' });
    });

    it('issues exactly one ambient status command and no service-inventory command on the fast path', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();

        const kinds = mocks.runner.start.mock.calls.map(([spec]) => (spec as SystemTaskSpec).kind);
        expect(kinds).toEqual(['daemon.service.status.v1']);
        const params = (mocks.runner.start.mock.calls[0]?.[0] as SystemTaskSpec).params as Record<string, unknown>;
        expect(JSON.stringify(params)).not.toContain('--no-persist');
        expect(params).not.toHaveProperty('relayUrl');
        expect(params).not.toHaveProperty('serverUrl');
    });

    it('reports a failed inspection instead of guessing, and retries it when setup asks again', async () => {
        resolveWith({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: 'task_status_1',
            ok: false,
            error: { code: 'cli_spawn_failed', message: 'boom' },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.inspect()).resolves.toEqual({
            status: 'failed',
            error: { code: 'cli_spawn_failed', message: 'boom' },
        });

        resolveWith(AMBIENT_RESULT);
        await expect(desktopSetupCoordinator.inspect()).resolves.toMatchObject({ status: 'resolved' });
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
    });

    it('re-reads facts only when the post-setup proof asks for a fresh inspection', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        await desktopSetupCoordinator.inspect();
        expect(mocks.runner.start).toHaveBeenCalledTimes(1);

        await desktopSetupCoordinator.inspect({ fresh: true });
        await desktopSetupCoordinator.inspect();
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
    });

    it('awaits the in-flight inspection, then starts the executor with the app relay, account and ring', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        const inspecting = desktopSetupCoordinator.inspect();
        const outcome = await desktopSetupCoordinator.startSetup({ start: startExecutor });
        await inspecting;

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({ taskId: 'task_setup_1' });
        expect(startExecutor).toHaveBeenCalledTimes(1);
        const spec = startExecutor.mock.calls[0]?.[0] as SystemTaskSpec;
        expect(spec.kind).toBe('setup.thisComputer.v1');
        expect(spec.params).toMatchObject({
            activeRelayUrl: 'https://relay.example.test',
            expectedAccountId: 'acct_app',
            channel: 'stable',
            surface: 'desktop.ui',
        });
    });

    it('asks before a direct relay change takes the app\'s own service off the relay it serves, then moves on "Move" (N1)', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        const confirm = vi.fn(async () => 'move' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        const outcome = await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm });

        expect(confirm).toHaveBeenCalledWith({ kind: 'relay', fromRelayHost: 'relay.example.test', toRelayHost: 'other.example.test' });
        expect(outcome).toEqual({ taskId: 'task_setup_1' });
        expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).toMatchObject({
            activeRelayUrl: 'https://other.example.test',
        });
    });

    it('remembers, for the run it launched, whether that run moves this computer to another relay', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        // Same relay as the daemon: converging, not moving.
        await desktopSetupCoordinator.startSetup({ start: async () => 'task_setup_same' });
        expect(desktopSetupCoordinator.readLaunchedRunMovesRelay('task_setup_same')).toBe(false);

        mocks.activeServer = { serverId: 'custom-3', serverUrl: 'https://other.example.test', activeLocalRelayUrl: null, generation: 2 };
        await desktopSetupCoordinator.reconcile({ start: async () => 'task_setup_move', confirm: async () => 'move' as const });
        expect(desktopSetupCoordinator.readLaunchedRunMovesRelay('task_setup_move')).toBe(true);
        // The fact belongs to the run it was decided for, never to another task.
        expect(desktopSetupCoordinator.readLaunchedRunMovesRelay('task_setup_same')).toBe(false);
        expect(desktopSetupCoordinator.readLaunchedRunMovesRelay(null)).toBe(false);
    });

    it('retains the target that reconciliation asked about while the user changes focused relay', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        mocks.activeServer = { serverId: 'custom-3', serverUrl: 'https://other.example.test', activeLocalRelayUrl: null, generation: 2 };
        let answer!: (value: 'move') => void;
        const consent = new Promise<'move'>((resolve) => { answer = resolve; });
        let asked!: () => void;
        const question = new Promise<void>((resolve) => { asked = resolve; });
        const confirm = vi.fn(async () => { asked(); return await consent; });
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_original');
        const pending = desktopSetupCoordinator.reconcile({ start: startExecutor, confirm });
        await question;
        mocks.activeServer = { serverId: 'custom-4', serverUrl: 'https://newly-focused.example.test', activeLocalRelayUrl: null, generation: 3 };
        answer('move');
        await pending;
        expect(startExecutor.mock.calls[0]?.[0].params).toMatchObject({ activeRelayUrl: 'https://other.example.test' });
    });

    it('asks before moving a service whose target mode the CLI did not prove (UD5)', async () => {
        // `service.targetMode` is absent from an older CLI's status. UNKNOWN is not evidence that
        // this service follows the app's selected default relay, so the projection keeps it `null`
        // and the decision asks instead of moving it silently.
        const { service: _service, ...restData } = AMBIENT_RESULT.data;
        resolveWith({ ...AMBIENT_RESULT, data: { ...restData, service: { installed: true, running: true } } });
        const { desktopSetupCoordinator } = await importCoordinator();
        const inspection = await desktopSetupCoordinator.inspect();
        expect(inspection).toMatchObject({ status: 'resolved', facts: { service: { targetMode: null } } });

        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        mocks.alwaysMove = true;
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('asks before moving a service that is not where the app put it, and does nothing when kept', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                server: { ...AMBIENT_RESULT.data.server, serverUrl: 'https://hand-configured.example.test', publicServerUrl: null, comparableKey: 'https://hand-configured.example.test' },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toBeNull();
        // Relay-move copy names both relay hosts (U2).
        expect(confirm).toHaveBeenCalledWith({
            kind: 'relay',
            fromRelayHost: 'hand-configured.example.test',
            toRelayHost: 'other.example.test',
        });
        // "Keep it as is" is remembered on this device for that daemon (D5).
        expect(mocks.rememberKept).toHaveBeenCalledWith({ relayKey: 'https://hand-configured.example.test', accountId: 'acct_app' });
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('remembers the device preference only when the user chose "always"', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                server: { ...AMBIENT_RESULT.data.server, serverUrl: 'https://hand-configured.example.test', publicServerUrl: null, comparableKey: 'https://hand-configured.example.test' },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');
        await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: async () => 'move' });
        expect(mocks.rememberAlwaysMove).not.toHaveBeenCalled();

        await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: async () => 'always' });
        expect(mocks.rememberAlwaysMove).toHaveBeenCalledTimes(1);
    });

    it('does not double-start: reconcile drives the same executor once per call', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: async () => 'move' });

        expect(startExecutor).toHaveBeenCalledTimes(1);
        const kinds = startExecutor.mock.calls.map(([spec]) => (spec as SystemTaskSpec).kind);
        expect(kinds).toEqual(['setup.thisComputer.v1']);
    });

    it('does not report acquisition complete when the inspection failed', async () => {
        resolveWith({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            taskId: 'task_status_1',
            ok: false,
            error: { code: 'cli_spawn_failed', message: 'boom' },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        const outcome = await desktopSetupCoordinator.startSetup({ start: async () => 'task_setup_1' });

        expect(outcome).toEqual({ taskId: 'task_setup_1' });
    });

    it('records the identity the app had when the ambient read was requested, not when it settled (INV7)', async () => {
        // The ambient read acquires and installs the managed CLI, so it is open for seconds. A
        // navigation-, notification-, deep-link-, voice- or focus-driven switch can land inside
        // that window. Capturing the app identity only once the read settles would make such a
        // switch invisible to the relay-change discriminator: it would read as ordinary entry
        // convergence and mutate the daemon onto a relay the user never chose (INV7), and a
        // genuine direct selection landing there would skip UD5 consent.
        const settlers: ((result: unknown) => void)[] = [];
        mocks.runner.start.mockImplementation(async () => 'task_status_1');
        mocks.runner.subscribe.mockImplementation(((_taskId: string, _onEvent: unknown, onResult: unknown) => {
            settlers.push(onResult as (result: unknown) => void);
            return () => {};
        }) as never);
        const { desktopSetupCoordinator } = await importCoordinator();

        const inspecting = desktopSetupCoordinator.inspect();
        // Let the coordinator reach its subscription; the read is now genuinely in flight.
        await new Promise((resolve) => setTimeout(resolve, 0));
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        settlers[0]?.(AMBIENT_RESULT);
        await inspecting;

        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({
            serverId: 'custom-2',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('adopts the first signed-in reader\'s identity when the read was warmed before sign-in (R5/INV4)', async () => {
        // The warm-up starts at app open, before the user has chosen where to sign in. An
        // observation made then expected NOTHING of this computer, so it cannot discriminate a
        // relay change: the user picking a relay in the welcome footer and then signing in would
        // otherwise read as "the app moved" and suppress first-run setup entirely (R2).
        resolveWith(AMBIENT_RESULT);
        mocks.accountId = null;
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({ serverId: 'custom-2', accountId: null });

        // The welcome footer relay change, then sign-in.
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        mocks.accountId = 'acct_app';
        const reused = await desktopSetupCoordinator.inspect();

        expect(mocks.runner.start).toHaveBeenCalledTimes(1);
        expect(reused).toMatchObject({ status: 'resolved' });
        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({
            serverId: 'custom-3',
            relayUrl: 'https://other.example.test',
            accountId: 'acct_app',
        });
    });

    it('keeps a signed-in observation even when the app moves afterwards (INV7)', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };
        await desktopSetupCoordinator.inspect();

        expect(desktopSetupCoordinator.readObservedExpectation()).toMatchObject({
            serverId: 'custom-2',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('proves readiness through the running daemon and one read-only machine RPC, never a task result (INV8/INV10)', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'verified',
            machineId: 'machine-1',
        });
        expect(mocks.machineRpc).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'custom-2',
            method: RPC_METHODS.CAPABILITIES_DESCRIBE,
            payload: {},
        });
    });

    it('names a resolved-but-non-convergent runtime instead of hanging, and asks the machine nothing (INV8)', async () => {
        // The service command can succeed while the running daemon still carries the wrong
        // identity. There is nothing to ask the relay about, so the verdict settles here.
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                runtimeConvergence: { ...AMBIENT_RESULT.data.runtimeConvergence, machineIdMatches: false },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'blocked',
            code: 'runtime_not_converged',
        });
        expect(mocks.machineRpc).not.toHaveBeenCalled();
    });

    it('names an unreachable machine when the runtime converged but the relay cannot reach it (INV10)', async () => {
        resolveWith(AMBIENT_RESULT);
        mocks.machineRpc.mockImplementation(async () => {
            throw new Error('Machine RPC timed out after 30000ms');
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'blocked',
            code: 'machine_unreachable',
        });
    });

    it('never claims ready for a converged daemon that belongs to a relay the app is not on', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        mocks.activeServer = {
            serverId: 'custom-3',
            serverUrl: 'https://other.example.test',
            activeLocalRelayUrl: null,
            generation: 2,
        };

        await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({
            status: 'blocked',
            code: 'runtime_not_converged',
        });
        expect(mocks.machineRpc).not.toHaveBeenCalled();
    });

    it('re-reads the runtime only when the caller asks for a fresh proof', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await desktopSetupCoordinator.inspect();
        await desktopSetupCoordinator.verifyCurrentTarget();
        expect(mocks.runner.start).toHaveBeenCalledTimes(1);

        await desktopSetupCoordinator.verifyCurrentTarget({ fresh: true });
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
    });

    it('projects the account label and the CLI version and update facts (K1/R17)', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                acquisition: { ...AMBIENT_RESULT.data.acquisition, version: '0.2.13' },
                auth: { ...AMBIENT_RESULT.data.auth, accountLabel: 'alice' },
                cli: { update: { currentVersion: '0.2.13', latestVersion: '0.2.14', updateAvailable: true, managed: true } },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.inspect()).resolves.toMatchObject({
            status: 'resolved',
            facts: {
                acquisition: { version: '0.2.13' },
                auth: { accountLabel: 'alice' },
                cliUpdate: { currentVersion: '0.2.13', latestVersion: '0.2.14', updateAvailable: true, managed: true },
            },
        });
    });

    it('keeps the new facts unknown when an older CLI does not report them', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();

        await expect(desktopSetupCoordinator.inspect()).resolves.toMatchObject({
            status: 'resolved',
            facts: { acquisition: { version: null }, auth: { accountLabel: null }, cliUpdate: null },
        });
    });

    it('asks before moving this computer to the account the app signed in to later in the same run (U1/D1)', async () => {
        // Sign out of A, sign in to C: the observation was taken as A and the daemon is A, so
        // measured against the observation nothing contradicted anything and C claimed this
        // computer with no question.
        resolveWith({
            ...AMBIENT_RESULT,
            data: { ...AMBIENT_RESULT.data, auth: { ...AMBIENT_RESULT.data.auth, accountId: 'acct_a', validatedAccountId: 'acct_a', accountLabel: 'alice' } },
        });
        mocks.accountId = 'acct_a';
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();

        mocks.accountId = 'acct_c_0123456789';
        mocks.alwaysMove = true;
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(confirm).toHaveBeenCalledWith({
            kind: 'account',
            fromAccountLabel: 'alice',
            toAccountLabel: 'acct_c…6789',
            relayHost: 'relay.example.test',
            fromRelayHost: null,
        });
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('asks the account question on an explicit setup too, and starts nothing when kept (D1)', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: { ...AMBIENT_RESULT.data, auth: { ...AMBIENT_RESULT.data.auth, accountId: 'acct_other', validatedAccountId: 'acct_other' } },
        });
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.startSetup({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account', fromAccountLabel: 'acct_other' }));
        expect(startExecutor).not.toHaveBeenCalled();

        confirm.mockImplementation(async () => 'move' as never);
        await expect(desktopSetupCoordinator.startSetup({ start: startExecutor, confirm })).resolves.toEqual({ taskId: 'task_setup_1' });
        expect(confirm).toHaveBeenCalledTimes(2);
        // The answer travels with the run for exactly that account, so the executor — which
        // enforces D1 on the credentials it would replace — does not ask the same question again.
        expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).toMatchObject({ replaceAccountId: 'acct_other' });
    });

    it('carries Settings\' request to ask the one-CLI question again into the run it starts (R12)', async () => {
        resolveWith(AMBIENT_RESULT);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await desktopSetupCoordinator.startSetup({ start: startExecutor, reconsiderCli: true });
        await desktopSetupCoordinator.startSetup({ start: startExecutor });

        expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).toMatchObject({ reconsiderCli: true });
        expect((startExecutor.mock.calls[1]?.[0] as SystemTaskSpec).params).not.toHaveProperty('reconsiderCli');
    });

    it('re-reads facts that could not see the daemon\'s account before deciding, then asks the account question (D1)', async () => {
        // The relay was unreachable when the ambient read ran, so the daemon's account is unknown.
        // Deciding on that read found no account to contradict and let the executor claim this
        // computer for the app's account with `--replace-existing` once the relay answered.
        const unknownAccount = {
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                auth: { ...AMBIENT_RESULT.data.auth, authenticated: false, accountId: null, credentialState: 'unknown', validatedAccountId: null },
            },
        };
        const otherAccount = {
            ...AMBIENT_RESULT,
            data: { ...AMBIENT_RESULT.data, auth: { ...AMBIENT_RESULT.data.auth, accountId: 'acct_other', validatedAccountId: 'acct_other', accountLabel: 'bob' } },
        };
        const results: unknown[] = [unknownAccount, otherAccount];
        mocks.runner.start.mockImplementation(async () => 'task_status_1');
        mocks.runner.subscribe.mockImplementation(((_taskId: string, _onEvent: unknown, onResult: unknown) => {
            if (typeof onResult === 'function') {
                (onResult as (value: unknown) => void)(results.shift() ?? otherAccount);
            }
            return () => {};
        }) as never);
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.startSetup({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account', fromAccountLabel: 'bob' }));
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('decides once on a fresh read that still cannot see the account, leaving the offline failure to the executor', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                auth: { ...AMBIENT_RESULT.data.auth, authenticated: false, accountId: null, credentialState: 'unknown', validatedAccountId: null },
            },
        });
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const confirm = vi.fn(async () => 'keep' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toEqual({ taskId: 'task_setup_1' });
        expect(mocks.runner.start).toHaveBeenCalledTimes(2);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('does not ask again about a daemon this device already chose to keep (D5)', async () => {
        resolveWith({
            ...AMBIENT_RESULT,
            data: {
                ...AMBIENT_RESULT.data,
                server: { ...AMBIENT_RESULT.data.server, serverUrl: 'https://hand-configured.example.test', publicServerUrl: null, comparableKey: 'https://hand-configured.example.test' },
            },
        });
        mocks.kept = { relayKey: 'https://hand-configured.example.test', accountId: 'acct_app' };
        const { desktopSetupCoordinator } = await importCoordinator();
        await desktopSetupCoordinator.inspect();
        const confirm = vi.fn(async () => 'move' as const);
        const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

        await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toBeNull();
        expect(confirm).not.toHaveBeenCalled();
        expect(startExecutor).not.toHaveBeenCalled();
    });

    it('refuses to start setup without an explicit relay and account rather than falling back to ambient state (R3/B6)', async () => {
        resolveWith(AMBIENT_RESULT);
        mocks.accountId = null;
        const { desktopSetupCoordinator } = await importCoordinator();
        const startExecutor = vi.fn(async () => 'task_setup_1');

        await expect(desktopSetupCoordinator.startSetup({ start: startExecutor })).rejects.toThrow(/account/i);
        expect(startExecutor).not.toHaveBeenCalled();
    });
    describe('one daemon per relay ("connect to this relay too")', () => {
        const RELAY_B = 'https://relay-b.example.test';
        const appOnRelayB = () => {
            mocks.activeServer = { serverId: 'relay-b', serverUrl: RELAY_B, activeLocalRelayUrl: null, generation: 2 };
        };
        const pinnedOnRelayB = {
            ...AMBIENT_RESULT.data,
            machineId: 'machine-b',
            server: { activeServerId: 'relay-b', serverUrl: RELAY_B, publicServerUrl: RELAY_B, localServerUrl: null, comparableKey: 'relay-b.example.test' },
            auth: { ...AMBIENT_RESULT.data.auth, machineId: 'machine-b' },
            service: { installed: true, running: true, targetMode: 'pinned' },
            daemon: { ...AMBIENT_RESULT.data.daemon, serviceLabel: 'com.happier.cli.daemon.relay-b' },
            managedBy: 'desktop',
        };
        /** Bootstrap's row for relay B: its own pinned service serves it (D11-2). */
        const relayBServedByPinned = [{ relayUrl: RELAY_B, state: 'connected', appManaged: true, serving: 'pinned', actions: ['restart', 'stop'] }];

        it('offers "connect too" beside the move when the executor can give the relay its own service', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] } } });
            const { desktopSetupCoordinator } = await importCoordinator();
            // Read while the app is on relay B: the daemon is not where the app last put it, so moving it asks.
            appOnRelayB();
            await desktopSetupCoordinator.inspect();
            const confirm = vi.fn(async () => 'connectToo' as const);
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

            await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm })).resolves.toEqual({ taskId: 'task_setup_1' });

            expect(confirm).toHaveBeenCalledWith({
                kind: 'relay',
                fromRelayHost: 'relay.example.test',
                toRelayHost: 'relay-b.example.test',
                offerConnectToo: true,
            });
            const params = (startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params as Record<string, unknown>;
            expect(params).toMatchObject({ activeRelayUrl: RELAY_B, expectedAccountId: 'acct_app', serviceTargetMode: 'pinned' });
            // The daemon on the other relay keeps its account: nothing is replaced, nothing is "kept".
            expect(params).not.toHaveProperty('replaceAccountId');
            expect(mocks.rememberKept).not.toHaveBeenCalled();
            expect(mocks.rememberAlwaysMove).not.toHaveBeenCalled();
        });

        it('offers it on a cross-relay account move too, where the other relay\'s account keeps this computer', async () => {
            resolveWith({
                ...AMBIENT_RESULT,
                data: { ...AMBIENT_RESULT.data, auth: { ...AMBIENT_RESULT.data.auth, accountId: 'acct_a', validatedAccountId: 'acct_a', accountLabel: 'alice' }, pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] } },
            });
            const { desktopSetupCoordinator } = await importCoordinator();
            await desktopSetupCoordinator.inspect();
            appOnRelayB();
            const confirm = vi.fn(async () => 'connectToo' as const);
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

            await desktopSetupCoordinator.startSetup({ start: startExecutor, confirm });

            expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account', fromRelayHost: 'relay.example.test', offerConnectToo: true }));
            const params = (startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params as Record<string, unknown>;
            expect(params).toMatchObject({ serviceTargetMode: 'pinned' });
            expect(params).not.toHaveProperty('replaceAccountId');
        });

        it('asks on an explicit setup when the move would take this computer off another relay, unless "always move" was chosen', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] } } });
            const { desktopSetupCoordinator } = await importCoordinator();
            appOnRelayB();
            await desktopSetupCoordinator.inspect();
            const confirm = vi.fn(async () => 'move' as const);
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

            await desktopSetupCoordinator.startSetup({ start: startExecutor, confirm });
            expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'relay', offerConnectToo: true }));
            expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).not.toHaveProperty('serviceTargetMode');

            mocks.alwaysMove = true;
            confirm.mockClear();
            await desktopSetupCoordinator.startSetup({ start: startExecutor, confirm });
            expect(confirm).not.toHaveBeenCalled();
        });

        it('asks Move / Connect too / Keep when the user adds relay B, picks it and signs in as the same account (N1)', async () => {
            // The direct pick: the app observed A (where the daemon is), then moved to B.
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] } } });
            const { desktopSetupCoordinator } = await importCoordinator();
            await desktopSetupCoordinator.inspect();
            appOnRelayB();
            const confirm = vi.fn(async () => 'connectToo' as const);
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

            await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm });
            expect(confirm).toHaveBeenLastCalledWith({ kind: 'relay', fromRelayHost: 'relay.example.test', toRelayHost: 'relay-b.example.test', offerConnectToo: true });
            expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).toMatchObject({ serviceTargetMode: 'pinned' });

            await desktopSetupCoordinator.startSetup({ start: startExecutor, confirm });
            expect(confirm).toHaveBeenCalledTimes(2);
        });

        it('never offers it when the CLI cannot run a relay\'s own service beside the default one (version skew fails closed)', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: false, services: [], unreadable: [] } } });
            const { desktopSetupCoordinator } = await importCoordinator();
            appOnRelayB();
            await desktopSetupCoordinator.inspect();
            const confirm = vi.fn(async () => 'keep' as const);

            await desktopSetupCoordinator.reconcile({ start: vi.fn(async () => 'task_setup_1'), confirm });

            expect(confirm).toHaveBeenCalledWith({ kind: 'relay', fromRelayHost: 'relay.example.test', toRelayHost: 'relay-b.example.test' });
        });

        it('never offers it while a service here could not be read (M6: unknown is not "none")', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: false, coexistence: true, services: [], unreadable: [{ relayUrl: 'https://relay-c.example.test', code: 'invalid_cli_response', message: 'x' }] } } });
            const { desktopSetupCoordinator } = await importCoordinator();
            appOnRelayB();
            await desktopSetupCoordinator.inspect();
            const confirm = vi.fn(async () => 'keep' as const);

            await desktopSetupCoordinator.reconcile({ start: vi.fn(async () => 'task_setup_1'), confirm });

            expect(confirm).toHaveBeenCalledWith({ kind: 'relay', fromRelayHost: 'relay.example.test', toRelayHost: 'relay-b.example.test' });
        });

        it('leaves a relay service the user set up to them: nothing is launched for it (H2)', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [{ ...pinnedOnRelayB, managedBy: null, runtimeConvergence: { ...pinnedOnRelayB.runtimeConvergence, controlReachable: false } }], unreadable: [] }, serviceRows: relayBServedByPinned } });
            const { desktopSetupCoordinator } = await importCoordinator();
            appOnRelayB();
            await desktopSetupCoordinator.inspect();
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

            await expect(desktopSetupCoordinator.reconcile({ start: startExecutor, confirm: vi.fn(async () => 'move' as const) })).resolves.toBeNull();
            await expect(desktopSetupCoordinator.startSetup({ start: startExecutor, confirm: vi.fn(async () => 'move' as const) })).resolves.toBeNull();
            expect(startExecutor).not.toHaveBeenCalled();
        });

        it('handles the home-wide CLI change before convergence of a user-owned relay pin', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [{ ...pinnedOnRelayB, managedBy: null }], unreadable: [] }, serviceRows: relayBServedByPinned } });
            const { desktopSetupCoordinator } = await importCoordinator();
            appOnRelayB();
            await desktopSetupCoordinator.inspect();
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_cli_choice');
            const confirm = vi.fn(async () => 'move' as const);

            await expect(desktopSetupCoordinator.startSetup({ start: startExecutor, confirm, reconsiderCli: true }))
                .resolves.toEqual({ taskId: 'task_cli_choice' });
            expect(startExecutor.mock.calls[0]?.[0].params).toMatchObject({ reconsiderCli: true, cliOnly: true });
            expect(confirm).not.toHaveBeenCalled();
        });

        it('knows while a setup run it launched is active, so nothing else starts services beside it (F5)', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [], unreadable: [] } } });
            const { desktopSetupCoordinator } = await importCoordinator();
            await desktopSetupCoordinator.inspect();
            mocks.runner.getSnapshot.mockImplementation((() => ({ taskId: 'task_setup_1', result: null })) as never);

            expect(desktopSetupCoordinator.isSetupActive()).toBe(false);
            await desktopSetupCoordinator.startSetup({ start: vi.fn(async () => 'task_setup_1') });
            expect(desktopSetupCoordinator.isSetupActive()).toBe(true);
            mocks.runner.getSnapshot.mockImplementation((() => ({ taskId: 'task_setup_1', result: { ok: true } })) as never);
            expect(desktopSetupCoordinator.isSetupActive()).toBe(false);
        });

        it('treats a pinned service on the app relay as this computer there: no question, and setup converges that service', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [pinnedOnRelayB], unreadable: [] }, serviceRows: relayBServedByPinned } });
            const { desktopSetupCoordinator } = await importCoordinator();
            await desktopSetupCoordinator.inspect();
            appOnRelayB();
            const confirm = vi.fn(async () => 'keep' as const);
            const startExecutor = vi.fn(async (_spec: SystemTaskSpec) => 'task_setup_1');

            await desktopSetupCoordinator.reconcile({ start: startExecutor, confirm });

            expect(confirm).not.toHaveBeenCalled();
            expect((startExecutor.mock.calls[0]?.[0] as SystemTaskSpec).params).toMatchObject({ serviceTargetMode: 'pinned' });
        });

        it('proves the pinned daemon ready for its relay, and the default-following one for its own', async () => {
            resolveWith({ ...AMBIENT_RESULT, data: { ...AMBIENT_RESULT.data, pinnedServices: { complete: true, coexistence: true, services: [pinnedOnRelayB], unreadable: [] }, serviceRows: relayBServedByPinned } });
            const { desktopSetupCoordinator } = await importCoordinator();

            appOnRelayB();
            await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({ status: 'verified', machineId: 'machine-b' });
            expect(mocks.machineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'machine-b', serverId: 'relay-b' }));

            mocks.activeServer = { serverId: 'custom-2', serverUrl: 'https://relay.example.test', activeLocalRelayUrl: null, generation: 3 };
            await expect(desktopSetupCoordinator.verifyCurrentTarget()).resolves.toMatchObject({ status: 'verified', machineId: 'machine-1' });
        });
    });
});
