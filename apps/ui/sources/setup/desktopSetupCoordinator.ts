import type { SystemTaskEvent, SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildLocalMachineSetupSystemTaskSpec, type LocalMachineSetupTarget } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/settings/machines/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { awaitSystemTaskResult } from '@/components/systemTasks/awaitSystemTaskResult';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolvePreferredPublicReleaseRingLabelForCurrentApp } from '@/sync/runtime/currentAppVariant';

import { toRelayHostDisplay } from '@/sync/domains/server/url/serverUrlDisplay';

import {
    readAlwaysMoveDefaultFollowingService,
    readKeptBackgroundService,
    rememberAlwaysMoveDefaultFollowingService,
    rememberKeptBackgroundService,
} from './desktopRelayMovePreference';
import {
    daemonRelayMatchesExpectation,
    desktopLocalRuntimeConverged,
    resolveThisComputerService,
    type DesktopCliChannel,
    type DesktopCliChoiceFacts,
    type DesktopCliUpdateFacts,
    type DesktopLocalInspection,
    type DesktopLocalReadinessFacts,
    type ThisComputerServiceRowFacts,
    type DesktopSetupExpectation,
    type ThisComputerRelayService,
} from './deriveDesktopLocalSetupSnapshot';
import type { RelayReconciliationConsentAnswer, ThisComputerMoveRequest } from './presentRelayReconciliationConsent';
import {
    daemonMovesToAnotherRelay,
    identifyKeptBackgroundService,
    keptBackgroundServiceApplies,
    resolveRelayReconciliationConsent,
    thisComputerCanConnectToo,
    type RelayReconciliationDecision,
} from './relayReconciliationConsent';
import { resolveAppAccountLabel, resolveDaemonAccountLabel } from './thisComputerLabels';

/**
 * The single desktop-side owner of local setup (plan §3.3).
 *
 * `inspect()` runs ONE ambient inspection per app open — `daemon.service.status.v1`, which
 * acquires/installs the managed CLI and reads what the running daemon is doing. `DesktopLocalSetupWarmup`
 * starts it the moment the desktop app opens, before anyone signs in (R5/INV4); the authenticated
 * gate then awaits that same promise rather than starting a read of its own. It is never
 * aborted and nothing re-runs it when the relay changes in the footer: the UI re-compares the
 * new target against the same immutable facts. A failed inspection is reported, not guessed
 * around, and the next `inspect()` retries it.
 *
 * `startSetup()` and `reconcile()` are the only paths that build the explicit-target executor spec
 * (R3), and the one place this computer's daemon is asked about before it moves (UD5/D1): each
 * awaits an in-flight inspection so two acquisitions never contend (C3), asks the one question the
 * facts call for, then hands the spec to the caller's runner adapter.
 *
 * The only thing it keeps beyond this app open is the person's own answers, through the existing
 * device-local preference owner ("always move", "keep it as is"). No lock, no event bus, no
 * generations, no scheduler.
 */
export type DesktopSetupStartOutcome = Readonly<{
    taskId: string;
}>;

/** One in-memory operation, retained by the shell's coordinator while its views come and go. */
export type DesktopSetupRun = Readonly<{
    taskId: string | null;
    runner: SystemTaskRunner;
    spec: SystemTaskSpec;
    movesRelay: boolean;
}>;

/**
 * Why `verifyCurrentTarget()` could not prove this computer ready. Exactly two ways to fail, both
 * named: the re-read runtime does not describe a converged daemon for this relay and account
 * (INV8), or it does but the machine did not answer the read-only RPC (INV10).
 */
export type DesktopSetupVerificationFailure = 'runtime_not_converged' | 'machine_unreachable';

/**
 * The one verdict. It always settles, and it names the facts it is ABOUT — the same object
 * `readInspectionSnapshot()` publishes, so a caller can tell when its verdict has gone stale
 * because something re-read this computer. Identity is the whole point of returning it: a verdict
 * kept past the facts it answered for is what parked the gate behind an actionless veil.
 */
export type DesktopSetupVerificationOutcome =
    | Readonly<{ status: 'verified'; machineId: string; inspection: DesktopLocalInspection }>
    | Readonly<{ status: 'blocked'; code: DesktopSetupVerificationFailure; inspection: DesktopLocalInspection }>;

/** The relay, account and server profile the app expected when the ambient facts were read. */
export type DesktopSetupObservedExpectation = DesktopSetupExpectation & Readonly<{ serverId: string }>;

export type DesktopSetupCoordinator = Readonly<{
    readSetupRun: () => DesktopSetupRun | null;
    /** Opaque existing request/spec reference, stable before and after native task allocation. */
    readSetupOperation: () => object | null;
    readSetupStarting: () => boolean;
    readSetupStartError: () => string | null;
    launchSetupTask: (params: Readonly<{
        runner: SystemTaskRunner;
        spec: SystemTaskSpec;
        onEvent: (event: SystemTaskEvent) => void;
    }>) => Promise<string>;
    /**
     * The one ambient inspection. `fresh: true` is only for the post-setup proof (INV8): the
     * executor just changed the runtime, so the app re-reads instead of trusting task success.
     */
    inspect: (options?: Readonly<{ fresh?: boolean }>) => Promise<DesktopLocalInspection>;
    /**
     * F6 — the one observation, observed. Every reader renders `readInspectionSnapshot()` and
     * re-renders when this fires, so a fresh read by ANY caller reaches all of them: previously
     * each consumer awaited the promise once and kept whatever it saw, which is why the tray kept
     * a drift title from app open and the settings row beside a repaired daemon still said it was
     * not running. Fires on both edges of a read — starting and settling — and the snapshot is
     * referentially stable between changes.
     */
    subscribe: (listener: () => void) => () => void;
    /**
     * The last facts this app open actually established. It stays put while a re-read is in
     * flight: a surface already showing true facts about this computer must not flash an empty
     * state while the CLI answers again (`apps/ui/AGENTS.md`). `pending` therefore means only one
     * thing — nothing has ever settled.
     */
    readInspectionSnapshot: () => DesktopLocalInspection;
    /**
     * Whether a read is in flight right now. It is the separate fact a reader needs when being
     * mid-check is itself worth showing — the setup surface acknowledges a Retry press with it —
     * while every other reader keeps rendering the facts above.
     */
    readInspectionRefreshing: () => boolean;
    /** Existing task owner for a surface that needs progress; facts above stay unchanged. */
    readInspectionTaskId: () => string | null;
    /**
     * A12-03/N-8 — the tray was pointed at or opened while this web UI runs (native
     * `desktop_tray_refresh_requested`, already gated by the native side's one pointer bound):
     * re-read so the menu lists current services. A demand while a read runs joins it.
     */
    refreshOnTrayPointer: () => void;
    /**
     * What the app expected of this computer when the current facts were read — or, when the read
     * was warmed before sign-in, what the first signed-in reader expected of it. UD5 compares the
     * daemon against this, never against installation history (D7). `null` until an inspection
     * is requested.
     */
    readObservedExpectation: () => DesktopSetupObservedExpectation | null;
    /**
     * The ONE proof that this computer is ready for the relay and account the app is on (INV8 +
     * INV10): read the runtime, check convergence against the current target, then ask the
     * machine to answer one read-only `capabilities.describe`. Every surface that would otherwise
     * decide readiness for itself — the automatic gate and the settings setup flow — asks here,
     * because a task result only says a command succeeded: the running daemon can still carry the
     * wrong identity, ownership may not have converged, and the relay may not reach it at all.
     *
     * `fresh: true` re-reads the runtime and is what a caller uses after the executor changed it,
     * or when the user asks to adopt what is already on the computer. Without it the one ambient
     * inspection of this app open is reused, so an already-ready computer proves itself without a
     * second read (D3/C3).
     */
    verifyCurrentTarget: (options?: Readonly<{ fresh?: boolean }>) => Promise<DesktopSetupVerificationOutcome>;
    /**
     * An explicit "set up / connect this computer". The person asked for the move, so a relay move
     * needs no second question — but an ACCOUNT move still asks (D1), because the account the
     * daemon is signed in as loses this computer. Resolves `null` when they chose to keep it.
     */
    startSetup: (params: DesktopSetupStartParams) => Promise<DesktopSetupStartOutcome | null>;
    /**
     * R8/L7 — a **direct** Relay/Home preference change, a relaunch whose daemon is elsewhere, or
     * authentication completing after one. Runs the same preflight and the same idempotent executor
     * as `startSetup`, after UD5/D1 consent — unless this device already chose to keep this daemon
     * as it is (D5). Resolves `null` when the service stays where it is.
     */
    reconcile: (params: DesktopSetupStartParams) => Promise<DesktopSetupStartOutcome | null>;
    /**
     * Whether the executor run with this task id — launched by `startSetup`/`reconcile` — moves
     * this computer's own service to another relay, decided once from the same facts the launch
     * acted on. It belongs to that run, so a re-read mid-run (the post-setup proof) cannot re-title
     * it. `false` for any other task, including one this coordinator did not launch.
     */
    readLaunchedRunMovesRelay: (taskId: string | null) => boolean;
    /**
     * F5 — whether a setup run is being launched (its question may be open) or the run this
     * coordinator last launched has not settled. The one answer every other starter of this
     * computer's services (the quiet start) consults, whichever surface launched the run.
     */
    isSetupActive: () => boolean;
}>;

export type DesktopSetupStartParams = Readonly<{
    start: (spec: SystemTaskSpec) => Promise<string>;
    /** The one ask. Defaults to the canonical presenter; a test or a headless caller may replace it. */
    confirm?: (request: ThisComputerMoveRequest) => Promise<RelayReconciliationConsentAnswer>;
    /** R12 — Settings › This computer › Command line's change action: ask the one-CLI question again. */
    reconsiderCli?: boolean;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean {
    return value === true;
}

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * UD5 fails closed on an unproven target mode, so only the two values the CLI actually publishes
 * are accepted. Anything else — a missing field from an older CLI, or output outside that
 * vocabulary — stays UNKNOWN rather than being mapped onto a mode the service may not have.
 */
function readServiceTargetMode(value: unknown): DesktopLocalReadinessFacts['service']['targetMode'] {
    return value === 'default-following' || value === 'pinned' ? value : null;
}

/**
 * Unknown stays unknown here too: a missing field is an older CLI and anything outside the two
 * modes proves nothing. Neither may become `at-login`, which would claim this computer keeps
 * answering after the app closes, nor `on-demand`, which would offer to stop it.
 */
function readServiceAutostartMode(value: unknown): DesktopLocalReadinessFacts['service']['autostart'] {
    return value === 'at-login' || value === 'on-demand' ? value : null;
}

function readCredentialState(value: unknown): DesktopLocalReadinessFacts['auth']['credentialState'] {
    return value === 'missing' || value === 'rejected' || value === 'valid' || value === 'unknown' ? value : null;
}

/** K1 — all four fields or nothing: a partial update answer proves no update. */
function readCliUpdate(value: unknown): DesktopCliUpdateFacts | null {
    const record = readRecord(value);
    const currentVersion = readString(record.currentVersion);
    if (!currentVersion || typeof record.updateAvailable !== 'boolean' || typeof record.managed !== 'boolean') {
        return null;
    }
    return {
        currentVersion,
        latestVersion: readString(record.latestVersion),
        updateAvailable: record.updateAvailable,
        managed: record.managed,
    };
}

/** R12 — unknown stays unknown: an unreadable answer is "nobody was asked, nothing else found". */
function readCliChoice(value: unknown): DesktopCliChoiceFacts {
    const record = readRecord(value);
    const mode = record.mode === 'managed' || record.mode === 'own' ? record.mode : null;
    const other = readRecord(record.otherCli);
    const command = readString(other.command);
    return {
        mode,
        otherCli: command
            ? {
                command,
                origin: other.origin === 'npm' || other.origin === 'brew' ? other.origin : 'unknown',
                removalCommand: readString(other.removalCommand),
                updateCommand: readString(other.updateCommand),
            }
            : null,
    };
}

function readRuntimeConvergence(value: unknown): DesktopLocalReadinessFacts['runtimeConvergence'] {
    const record = readRecord(value);
    const keys = ['controlReachable', 'serviceOwnsRunningDaemon', 'machineIdMatches', 'cliVersionMatches'] as const;
    if (!keys.every((key) => typeof record[key] === 'boolean')) {
        return null;
    }
    return {
        controlReachable: record.controlReachable === true,
        serviceOwnsRunningDaemon: record.serviceOwnsRunningDaemon === true,
        machineIdMatches: record.machineIdMatches === true,
        cliVersionMatches: record.cliVersionMatches === true,
    };
}

function readCliChannel(value: unknown): DesktopCliChannel | null {
    return value === 'stable' || value === 'preview' || value === 'publicdev' ? value : null;
}

/** Projects `daemon.service.status.v1`'s result into the facts the entry policy reads. */
export function readDesktopLocalReadinessFacts(data: unknown): DesktopLocalReadinessFacts | null {
    const record = readRecord(data);
    const acquisition = readRecord(record.acquisition);
    const command = readString(acquisition.command);
    const provenance = acquisition.provenance === 'managed' || acquisition.provenance === 'override' ? acquisition.provenance : null;
    if (!command || !provenance) {
        return null;
    }
    const server = readRecord(record.server);
    const auth = readRecord(record.auth);
    const service = readRecord(record.service);
    return {
        acquisition: { command, provenance, version: readString(acquisition.version), channel: readCliChannel(acquisition.channel) },
        server: {
            serverUrl: readString(server.serverUrl),
            publicServerUrl: readString(server.publicServerUrl),
            localServerUrl: readString(server.localServerUrl),
            comparableKey: readString(server.comparableKey),
        },
        auth: {
            credentialState: readCredentialState(auth.credentialState),
            validatedAccountId: readString(auth.validatedAccountId),
            accountId: readString(auth.accountId),
            accountLabel: readString(auth.accountLabel),
            machineId: readString(auth.machineId),
        },
        service: {
            installed: readBoolean(service.installed),
            running: readBoolean(service.running),
            autostart: readServiceAutostartMode(service.autostart),
            targetMode: readServiceTargetMode(service.targetMode),
        },
        runtimeConvergence: readRuntimeConvergence(record.runtimeConvergence),
        cliUpdate: readCliUpdate(readRecord(record.cli).update),
        cliChoice: readCliChoice(readRecord(record.cli).choice),
    };
}

/** Projects a `daemon.service.status.v1` result into the one inspection (exported for the tray parity fixture). */
export function inspectionFromResult(result: SystemTaskResult): DesktopLocalInspection {
    if (!result.ok) {
        return { status: 'failed', error: { code: result.error.code, message: result.error.message } };
    }
    const facts = readDesktopLocalReadinessFacts(result.data);
    if (!facts) {
        return { status: 'failed', error: { code: 'invalid_status_result', message: 'The local inspection returned no acquisition facts.' } };
    }
    const pinned = readPinnedServices(readRecord(result.data).pinnedServices);
    const serviceRows = readServiceRows(readRecord(result.data).serviceRows);
    return {
        status: 'resolved',
        facts,
        pinnedServices: pinned?.services ?? null,
        // The executor's ONE completeness signal; an older result without it is unknown, not whole.
        pinnedServicesComplete: pinned?.complete === true,
        pinnedServiceCoexistence: pinned?.coexistence === true,
        pinnedServicesUnreadable: pinned?.unreadableRelayUrls ?? [],
        managedServiceAutostart: readServiceAutostartMode(readRecord(result.data).managedServiceAutostart),
        runningManagedServiceCount: readServiceCount(readRecord(result.data).runningManagedServiceCount),
        serviceRows,
    };
}

const SERVICE_ROW_STATES: ReadonlySet<string> = new Set(['connected', 'offline', 'needs_attention']);
const SERVICE_ROW_ACTIONS: ReadonlySet<string> = new Set(['start', 'restart', 'stop']);

/** A count the producer proved, or `null` (unknown): never a guessed zero. */
function readServiceCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readServiceRowMode(value: unknown): ThisComputerServiceRowFacts['serving'] | null {
    return value === 'pinned' || value === 'default-following' ? value : null;
}

/**
 * R16 — the executor's rows as sent. A row the app cannot read is dropped and claims nothing about
 * its relay; bootstrap writes every row with the fields read here, so none is expected.
 */
function readServiceRows(value: unknown): readonly ThisComputerServiceRowFacts[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    return value.flatMap((entry): ThisComputerServiceRowFacts[] => {
        const record = readRecord(entry);
        const relayUrl = readString(record.relayUrl);
        const state = typeof record.state === 'string' && SERVICE_ROW_STATES.has(record.state) ? record.state as ThisComputerServiceRowFacts['state'] : null;
        const serving = readServiceRowMode(record.serving);
        if (!relayUrl || !state || !serving) return [];
        const actions = Array.isArray(record.actions)
            ? record.actions.filter((action): action is ThisComputerServiceRowFacts['actions'][number] => typeof action === 'string' && SERVICE_ROW_ACTIONS.has(action))
            : [];
        return [{ relayUrl, state, appManaged: record.appManaged === true, serving, actions }];
    });
}

/**
 * One daemon per relay — each pinned service's facts, projected like the default-following one's.
 * Unknown stays unknown: an executor that sent no list reads as `null`, and an entry the app cannot
 * read makes the list incomplete, so nothing is claimed about relays the app cannot see and nothing
 * that depends on the list is offered. `coexistence` is the CLI's `pinnedServiceCoexistence`
 * capability (B-03): it gates only offering "Connect to … too", never which services are listed.
 */
function readPinnedServices(value: unknown): Readonly<{
    services: readonly DesktopLocalReadinessFacts[];
    complete: boolean;
    coexistence: boolean;
    unreadableRelayUrls: readonly string[];
}> | null {
    const record = readRecord(value);
    if (!Array.isArray(record.services)) {
        return null;
    }
    const services: DesktopLocalReadinessFacts[] = [];
    let complete = record.complete === true;
    for (const entry of record.services) {
        const facts = readDesktopLocalReadinessFacts(entry);
        if (!facts) {
            // An entry the app cannot read is one more service it cannot see: known incomplete.
            complete = false;
            continue;
        }
        const managedBy = readRecord(entry).managedBy === 'desktop' ? 'desktop' : null;
        services.push({ ...facts, service: { ...facts.service, managedBy } });
    }
    const unreadableRelayUrls = Array.isArray(record.unreadable)
        ? record.unreadable.flatMap((entry) => {
            const relayUrl = readString(readRecord(entry).relayUrl);
            return relayUrl ? [relayUrl] : [];
        })
        : [];
    return { services, complete, coexistence: record.coexistence === true, unreadableRelayUrls };
}

/**
 * The explicit target for the executor, read from the app's canonical owners. A missing account
 * or relay throws by name; nothing here consults the CLI's ambient relay (B6).
 */
export function resolveDesktopSetupTarget(): LocalMachineSetupTarget {
    const activeServer = getActiveServerSnapshot();
    const activeRelayUrl = readString(activeServer.serverUrl);
    if (!activeRelayUrl) {
        throw new Error('desktop setup requires the app relay url');
    }
    const accountId = readString(getActiveServerAccountScope()?.accountId);
    if (!accountId) {
        throw new Error('desktop setup requires the signed-in account for the app relay');
    }
    return {
        activeRelayUrl,
        activeWebappUrl: resolveWebappUrlFromServerUrl(activeRelayUrl),
        activeLocalRelayUrl: readString(activeServer.activeLocalRelayUrl),
        expectedAccountId: accountId,
        channel: resolvePreferredPublicReleaseRingLabelForCurrentApp(),
    };
}

function defaultMachineRpc(params: Readonly<{ machineId: string; serverId: string }>): Promise<unknown> {
    return machineRpcWithServerScope<unknown, Record<string, never>>({
        machineId: params.machineId,
        serverId: params.serverId,
        method: RPC_METHODS.CAPABILITIES_DESCRIBE,
        payload: {},
    });
}

const PENDING_INSPECTION: DesktopLocalInspection = { status: 'pending' };


function readCurrentExpectation(): DesktopSetupObservedExpectation {
    const activeServer = getActiveServerSnapshot();
    return {
        serverId: readString(activeServer.serverId) ?? '',
        relayUrl: readString(activeServer.serverUrl) ?? '',
        localRelayUrl: readString(activeServer.activeLocalRelayUrl),
        accountId: readString(getActiveServerAccountScope()?.accountId),
    };
}

/**
 * The daemon on this computer that answers for the relay and account the app is on NOW — the
 * relay's own pinned service when it has one here (one daemon per relay), else the default-following
 * one. `null` until facts have settled. For surfaces that describe "this computer" on the app's
 * relay: its machine id, its status, its update row.
 */
export function resolveThisComputerServiceForActiveRelay(inspection: DesktopLocalInspection): ThisComputerRelayService | null {
    return inspection.status === 'resolved' ? resolveThisComputerService(inspection, readCurrentExpectation()) : null;
}

/**
 * The move a consent question is about, named from the facts the decision used: hosts for a relay
 * move, both accounts for an account move (U2/D1).
 */
function buildMoveRequest(
    decision: Exclude<RelayReconciliationDecision, 'start' | 'leave_user_service'>,
    inspection: DesktopLocalInspection,
    target: DesktopSetupExpectation,
): ThisComputerMoveRequest {
    // The daemon the question is about: the one that serves (or would be moved to) this relay.
    const facts = inspection.status === 'resolved' ? resolveThisComputerService(inspection, target)?.facts ?? null : null;
    const toRelayHost = toRelayHostDisplay(target.relayUrl);
    const fromRelayHost = facts?.server.serverUrl ? toRelayHostDisplay(facts.server.serverUrl) : null;
    const connectToo = thisComputerCanConnectToo({ inspection, target }) ? { offerConnectToo: true as const } : {};
    if (decision === 'confirm_relay' || !facts || !target.accountId) {
        return { kind: 'relay', fromRelayHost, toRelayHost, ...connectToo };
    }
    return {
        kind: 'account',
        fromAccountLabel: resolveDaemonAccountLabel(facts.auth) ?? '',
        toAccountLabel: resolveAppAccountLabel(target.accountId),
        relayHost: toRelayHost,
        fromRelayHost: daemonRelayMatchesExpectation(facts, target) ? null : fromRelayHost,
        ...connectToo,
    };
}

/** Which of this computer's services a setup run converges for the app's relay. */
type SetupServiceTargetMode = ThisComputerRelayService['serviceTargetMode'];

/** The service that serves `target` here now — the one a run that moves nothing converges. */
function servingServiceTargetMode(inspection: DesktopLocalInspection, target: DesktopSetupExpectation): SetupServiceTargetMode {
    if (inspection.status !== 'resolved') return 'default-following';
    // An unreadable relay service is still that relay's own: a run converges it, never the default (R12-F1).
    return resolveThisComputerService(inspection, target)?.serviceTargetMode ?? 'pinned';
}

export function createDesktopSetupCoordinator(deps: Readonly<{
    runner: () => SystemTaskRunner;
    /** INV10's canonical owner. Read-only, so it keeps its production default. */
    machineRpc?: (params: Readonly<{ machineId: string; serverId: string }>) => Promise<unknown>;
    /** The one consent presenter (UD5/D1). */
    confirm?: (request: ThisComputerMoveRequest) => Promise<RelayReconciliationConsentAnswer>;
}>): DesktopSetupCoordinator {
    let inspection: Promise<DesktopLocalInspection> | null = null;
    let observedExpectation: DesktopSetupObservedExpectation | null = null;
    let snapshot: DesktopLocalInspection = PENDING_INSPECTION;
    let refreshing = false;
    let inspectionTaskId: string | null = null;
    /** F5 — `startSetup`/`reconcile` calls between their start and the run they launch (or none). */
    let launching = 0;
    let setupRun: DesktopSetupRun | null = null;
    let setupStartError: string | null = null;
    let setupRequest: Promise<DesktopSetupStartOutcome | null> | null = null;
    let setupOperation: object | null = null;
    const listeners = new Set<() => void>();

    const notify = (): void => {
        for (const listener of Array.from(listeners)) {
            listener();
        }
    };

    const launchSetupTask: DesktopSetupCoordinator['launchSetupTask'] = async ({ runner, spec, onEvent }) => {
        launching += 1;
        setupStartError = null;
        if (!setupRequest) setupOperation = spec;
        setupRun = { runner, spec, taskId: null, movesRelay: false };
        notify();
        try {
            const taskId = await runner.start(spec);
            setupRun = { runner, spec, taskId, movesRelay: false };
            // This subscription belongs to the operation, not its initiating route. Replay also
            // answers a prompt emitted between native start and the retained subscription.
            let unsubscribe: (() => void) | null = null;
            let settled = false;
            unsubscribe = runner.subscribe(taskId, onEvent, (result) => {
                settled = true;
                unsubscribe?.();
                // Setup outlives its initiating route. Its successful mutation invalidates the
                // ambient facts for every reader, including one reopened after completion.
                if (result.ok) void inspect({ fresh: true });
                notify();
            });
            if (settled) unsubscribe();
            notify();
            return taskId;
        } catch (error) {
            setupStartError = error instanceof Error ? error.message : 'system_task_start_failed';
            throw error;
        } finally {
            launching -= 1;
            notify();
        }
    };

    const runInspection = async (isCurrent: () => boolean): Promise<DesktopLocalInspection> => {
        // The facts are read against the app's identity as it is NOW, when the read is requested.
        // Recording it when the read settles instead would hide every server change that lands
        // inside the acquisition window from the relay-change discriminator: a navigation-,
        // notification-, deep-link-, voice- or focus-driven switch would then read as ordinary
        // entry convergence and repoint the daemon (INV7), and a genuine direct selection landing
        // there would skip the UD5 ask.
        observedExpectation = readCurrentExpectation();
        let runner: SystemTaskRunner;
        let taskId: string;
        try {
            runner = deps.runner();
            taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
            if (isCurrent()) {
                inspectionTaskId = taskId;
                notify();
            }
        } catch (error) {
            return {
                status: 'failed',
                error: {
                    code: 'system_task_start_failed',
                    message: error instanceof Error ? error.message : 'The local inspection could not start.',
                },
            };
        }
        return inspectionFromResult(await awaitSystemTaskResult(runner, taskId));
    };

    const inspect = (options?: Readonly<{ fresh?: boolean }>): Promise<DesktopLocalInspection> => {
        if (!inspection || options?.fresh) {
            // The facts stand until they are replaced: readers keep the last established ones and
            // learn separately that a read is running.
            refreshing = true;
            inspectionTaskId = null;
            notify();
            const request: Promise<DesktopLocalInspection> = runInspection(() => inspection === request).then((result) => {
                // An older read still answers its caller, but cannot replace facts or progress
                // from a later read requested after setup changed this computer.
                if (inspection !== request) return result;
                if (result.status === 'failed') {
                    inspection = null;
                }
                refreshing = false;
                snapshot = result;
                notify();
                return result;
            });
            inspection = request;
            return request;
        }
        if (observedExpectation !== null && observedExpectation.accountId === null) {
            // R5/INV4 — the pre-auth warm-up starts this read at app open, before the user has
            // chosen where to sign in. An observation made then expected NOTHING of this
            // computer, so it cannot tell a relay CHANGE from the user simply picking their relay
            // in the welcome footer: treating it as a change would classify first-run entry as
            // L7 reconciliation and, with no direct Relay/Home preference written yet, suppress
            // setup altogether (R2). The first reader that has an account is the first one with
            // an expectation, so the expectation is recorded here, for it. Every later change is
            // still measured against that identity (INV7), exactly as before the warm-up existed.
            observedExpectation = readCurrentExpectation();
        }
        return inspection;
    };

    const verifyCurrentTarget: DesktopSetupCoordinator['verifyCurrentTarget'] = async (options) => {
        // The target is read now, the way `runInspection` reads it, so the verdict belongs to the
        // identity the app is on at the moment the proof was asked for.
        const expected = readCurrentExpectation();
        const inspection = await inspect(options?.fresh ? { fresh: true } : undefined);
        // The daemon that answers for this relay — the default-following one, or the relay's own
        // pinned service — is the machine the proof asks.
        const machineId = inspection.status === 'resolved' && desktopLocalRuntimeConverged(inspection, expected)
            ? resolveThisComputerService(inspection, expected)?.facts.auth.machineId ?? null
            : null;
        if (!machineId) {
            return { status: 'blocked', code: 'runtime_not_converged', inspection };
        }
        try {
            // INV10 — convergence describes the daemon this computer runs; it cannot say whether
            // the relay can reach it. The canonical owner bounds its own wait, so nothing here
            // adds a timeout, a retry or a poll.
            await (deps.machineRpc ?? defaultMachineRpc)({ machineId, serverId: expected.serverId });
        } catch {
            return { status: 'blocked', code: 'machine_unreachable', inspection };
        }
        return { status: 'verified', machineId, inspection };
    };

    /**
     * Asks the one question the decision named and records the answer: the service the run then
     * converges, or `null` for "Keep it as is" — remembered for exactly the daemon it was said
     * about (D5). "always" is a relay answer and is never offered for an account move;
     * "Connect to … too" gives the relay its own pinned service and is only ever an answer when it
     * was offered.
     */
    const askToMove = async (
        decision: Exclude<RelayReconciliationDecision, 'start' | 'leave_user_service'>,
        ambient: DesktopLocalInspection,
        target: DesktopSetupExpectation,
        confirm: DesktopSetupStartParams['confirm'],
    ): Promise<SetupServiceTargetMode | null> => {
        // The presenter is loaded when a question is actually asked: the modal stack is not
        // something the ambient read, or any coordinator reader, should pay for.
        const ask = confirm ?? deps.confirm ?? (await import('./presentRelayReconciliationConsent')).presentRelayReconciliationConsent;
        const request = buildMoveRequest(decision, ambient, target);
        const answer = await ask(request);
        if (answer === 'connectToo') {
            return request.offerConnectToo ? 'pinned' : null;
        }
        if (answer === 'keep') {
            const kept = identifyKeptBackgroundService(ambient);
            if (kept) rememberKeptBackgroundService(kept);
            return null;
        }
        if (answer === 'always' && decision === 'confirm_relay') {
            rememberAlwaysMoveDefaultFollowingService();
        }
        return servingServiceTargetMode(ambient, target);
    };

    const readAmbient = async (): Promise<DesktopLocalInspection> => {
        // Awaiting an in-flight ambient read keeps two adjacent acquisitions from contending (C3).
        // A failed or rejected inspection must not block setup or repair: it decides nothing.
        const settled = inspection ? await inspection.catch(() => null) : null;
        if (settled && settled.status === 'resolved' && settled.facts.auth.credentialState !== 'unknown') {
            return settled;
        }
        // D1 is decided on facts that could see the daemon's account. Facts read while the relay
        // was unreachable — or no facts at all — cannot, and the executor validates the account
        // itself the moment the relay answers, so it would claim this computer with no question.
        // One fresh read through the one inspection owner; if the relay still cannot be reached,
        // the executor's own `auth status` answers `auth_unavailable` and it stops by name.
        return await inspect({ fresh: true }).catch(() => settled ?? PENDING_INSPECTION);
    };

    const launch = async (
        params: DesktopSetupStartParams,
        target: LocalMachineSetupTarget,
        ambient: DesktopLocalInspection,
    ): Promise<DesktopSetupStartOutcome> => {
        // A pinned run gives the relay its own service; it moves nothing.
        const movesRelay = target.cliOnly !== true && target.serviceTargetMode !== 'pinned' && daemonMovesToAnotherRelay({
            inspection: ambient,
            target: { relayUrl: target.activeRelayUrl, localRelayUrl: target.activeLocalRelayUrl, accountId: target.expectedAccountId },
        });
        const spec = buildLocalMachineSetupSystemTaskSpec({
            ...target,
            ...(params.reconsiderCli ? { reconsiderCli: true } : {}),
        });
        const taskId = await params.start(spec);
        setupRun = { runner: setupRun?.taskId === taskId ? setupRun.runner : deps.runner(), spec, taskId, movesRelay };
        notify();
        return { taskId };
    };

    /**
     * What the run is told: which service it converges and, for an answered account move, the
     * validated account that move is about (D1). "Connect to … too" replaces nobody's account: the
     * other relay's daemon keeps it, and the executor still asks about the target relay's own
     * saved credentials itself.
     */
    const runPlacement = (
        decision: RelayReconciliationDecision,
        ambient: DesktopLocalInspection,
        target: DesktopSetupExpectation,
        serviceTargetMode: SetupServiceTargetMode,
    ): Readonly<{ replaceAccountId: string | null; serviceTargetMode?: 'pinned' }> => {
        const replaced = decision === 'confirm_account' && ambient.status === 'resolved'
            ? resolveThisComputerService(ambient, target)
            : null;
        return {
            replaceAccountId: replaced && replaced.serviceTargetMode === serviceTargetMode ? replaced.facts.auth.validatedAccountId : null,
            ...(serviceTargetMode === 'pinned' ? { serviceTargetMode: 'pinned' as const } : {}),
        };
    };

    const trackLaunch = (run: () => Promise<DesktopSetupStartOutcome | null>): Promise<DesktopSetupStartOutcome | null> => {
        if (setupRequest) return setupRequest;
        const active = setupRun?.taskId ? setupRun.runner.getSnapshot(setupRun.taskId) : null;
        if (active && !active.result) return Promise.resolve({ taskId: active.taskId });
        launching += 1;
        setupStartError = null;
        notify();
        setupRequest = run().catch((error: unknown) => {
            setupStartError = error instanceof Error ? error.message : 'system_task_start_failed';
            throw error;
        }).finally(() => {
            launching -= 1;
            setupRequest = null;
            notify();
        });
        setupOperation = setupRequest;
        notify();
        return setupRequest;
    };

    const startSetupUntracked: DesktopSetupCoordinator['startSetup'] = async (params) => {
        const target = resolveDesktopSetupTarget();
        const ambient = await readAmbient();
        const expectation: DesktopSetupExpectation = {
            relayUrl: target.activeRelayUrl,
            localRelayUrl: target.activeLocalRelayUrl,
            accountId: target.expectedAccountId,
        };
        const decision = resolveRelayReconciliationConsent({
            inspection: ambient,
            observedExpectation,
            target: expectation,
            alwaysMoveDefaultFollowingService: readAlwaysMoveDefaultFollowingService(),
        });
        // H2 — the relay's own service here was set up by the user: nothing of the app's to converge.
        if (decision === 'leave_user_service') {
            // The CLI choice belongs to the home, independent of who owns this relay's service.
            // The same executor handles it before any relay/auth/service convergence.
            if (params.reconsiderCli) {
                return await launch(params, { ...target, cliOnly: true }, ambient);
            }
            return null;
        }
        // An explicit request is the relay answer for a first setup; it is not an answer to taking
        // this computer OFF a relay it serves (N1), nor to an account move (D1) — both are asked.
        const asks = decision === 'confirm_account'
            || (decision === 'confirm_relay' && daemonMovesToAnotherRelay({ inspection: ambient, target: expectation }));
        const serviceTargetMode = asks
            ? await askToMove(decision, ambient, expectation, params.confirm)
            : servingServiceTargetMode(ambient, expectation);
        if (serviceTargetMode === null) {
            return null;
        }
        return await launch(params, { ...target, ...runPlacement(decision, ambient, expectation, serviceTargetMode) }, ambient);
    };

    const startSetup: DesktopSetupCoordinator['startSetup'] = (params) => trackLaunch(() => startSetupUntracked(params));

    const reconcileUntracked: DesktopSetupCoordinator['reconcile'] = async (params) => {
        const setupTarget = resolveDesktopSetupTarget();
        const target = readCurrentExpectation();
        const ambient = await readAmbient();
        if (keptBackgroundServiceApplies({ inspection: ambient, target, kept: readKeptBackgroundService() })) {
            return null;
        }
        const decision = resolveRelayReconciliationConsent({
            inspection: ambient,
            observedExpectation,
            target,
            alwaysMoveDefaultFollowingService: readAlwaysMoveDefaultFollowingService(),
        });
        if (decision === 'leave_user_service') {
            return null;
        }
        const serviceTargetMode = decision === 'start'
            ? servingServiceTargetMode(ambient, target)
            : await askToMove(decision, ambient, target, params.confirm);
        if (serviceTargetMode === null) {
            return null;
        }
        return await launch(params, { ...setupTarget, ...runPlacement(decision, ambient, target, serviceTargetMode) }, ambient);
    };

    const reconcile: DesktopSetupCoordinator['reconcile'] = (params) => trackLaunch(() => reconcileUntracked(params));

    return {
        readSetupRun: () => setupRun,
        readSetupOperation: () => setupOperation,
        readSetupStarting: () => launching > 0,
        readSetupStartError: () => setupStartError,
        launchSetupTask,
        inspect,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        readInspectionSnapshot: () => snapshot,
        refreshOnTrayPointer: () => {
            if (refreshing) return;
            void inspect({ fresh: true });
        },
        readInspectionRefreshing: () => refreshing,
        readInspectionTaskId: () => inspectionTaskId,
        readObservedExpectation: () => observedExpectation,
        verifyCurrentTarget,
        startSetup,
        reconcile,
        readLaunchedRunMovesRelay: (taskId) => setupRun !== null && taskId !== null && setupRun.taskId === taskId && setupRun.movesRelay,
        isSetupActive: () => launching > 0
            || (setupRun?.taskId != null && setupRun.runner.getSnapshot(setupRun.taskId)?.result == null),
    };
}

export const desktopSetupCoordinator: DesktopSetupCoordinator = createDesktopSetupCoordinator({
    runner: getSystemTasksRunner,
});
