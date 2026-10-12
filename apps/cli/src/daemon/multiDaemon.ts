import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { resolveServingThisComputerService } from '@happier-dev/cli-common/service';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { resolveDaemonStartupSourceServiceManagedState } from '@/daemon/ownership/daemonOwnershipMetadata';
import {
  DaemonLocallyPersistedStateSchema,
  readSettings,
  resolveDaemonStateCandidatePathsForCurrentLifecycle,
  reclaimDeadDaemonPublication,
} from '@/persistence';
import { logger } from '@/ui/logger';
import { DaemonStopIncompleteError, inspectDaemonLockStartupProgress, inspectPublishedDaemonPresence, observePublishedDaemonOwner } from './controlClient';
import type { DaemonPublicationPresenceInspection } from './controlLiveness';
import type { PublishedDaemonOwnerObservation } from './controlClient';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { resolveDaemonStateCandidatePaths } from '@/daemon/ownership/daemonOwnershipPaths';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { sanitizeServerIdForFilesystem } from '@/server/serverId';
import type { DaemonStartupSource } from '@/daemon/ownership/daemonOwnershipMetadata';
type NormalizedDaemonState = Readonly<{
  pid: number;
  httpPort: number;
  startedAt: number;
  startedWithCliVersion: string;
  controlToken?: string;
  startupSource?: DaemonStartupSource;
  serviceLabel?: string;
}>;

type StopDaemonOptions = Readonly<{
  stopSessions?: boolean;
}>;

export type DaemonLifecycleOrphanReapResult = Readonly<{
  stoppedPids: readonly number[];
  preservedPids: readonly number[];
  failedPids: readonly number[];
}>;

function parseDaemonStateFromJson(value: unknown): NormalizedDaemonState | null {
  const parsed = DaemonLocallyPersistedStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (typeof data.pid !== 'number' || typeof data.httpPort !== 'number') return null;
  if ('startedAt' in data) {
    return {
      pid: data.pid,
      httpPort: data.httpPort,
      startedAt: data.startedAt,
      startedWithCliVersion: data.startedWithCliVersion,
      controlToken: typeof data.controlToken === 'string' ? data.controlToken : undefined,
      startupSource: typeof data.startupSource === 'string' ? data.startupSource : undefined,
      serviceLabel: typeof data.serviceLabel === 'string' ? data.serviceLabel : undefined,
    };
  }
  const startedAt = Date.parse(String(data.startTime ?? ''));
  return {
    pid: data.pid,
    httpPort: data.httpPort,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    startedWithCliVersion: data.startedWithCliVersion,
  };
}

async function readDaemonStateFromPath(path: string): Promise<NormalizedDaemonState | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    return parseDaemonStateFromJson(raw);
  } catch (error) {
    logger.debug(`[multi-daemon] failed to read daemon state: ${path}`, error);
    return null;
  }
}

async function resolveDaemonPublicationForServerId(serverId: string): Promise<Readonly<{
  daemonStatePath: string;
  state: NormalizedDaemonState | null;
  presence: DaemonPublicationPresenceInspection;
}>> {
  const serverDir = join(configuration.serversDir, serverId);
  const [canonicalPath, ...legacyPaths] = resolveDaemonStateCandidatePaths({
    serverDir,
    preferredRing: configuration.publicReleaseRing,
  });
  let firstReadable: Readonly<{
    daemonStatePath: string;
    state: NormalizedDaemonState;
    presence: DaemonPublicationPresenceInspection;
  }> | null = null;
  for (const candidatePath of [canonicalPath, ...legacyPaths]) {
    if (!existsSync(candidatePath)) continue;
    const state = await readDaemonStateFromPath(candidatePath);
    if (!state) continue;
    const presence = await inspectPublishedDaemonPresence(state);
    const publication = { daemonStatePath: candidatePath, state, presence };
    if (presence.status === 'running') return publication;
    if (!firstReadable || (firstReadable.presence.status === 'not_running' && presence.status === 'unverified')) firstReadable = publication;
  }
  return firstReadable ?? { daemonStatePath: canonicalPath, state: null, presence: { status: 'not_running' } };
}

/** The publication serving a relay, including authenticated owners outside this PID namespace. */
export async function readDaemonStateForServerId(serverId: string): Promise<Readonly<{
  state: NormalizedDaemonState;
  running: boolean;
  presence: DaemonPublicationPresenceInspection['status'];
}> | null> {
  const { state, presence } = await resolveDaemonPublicationForServerId(serverId);
  return state ? { state, running: presence.status === 'running', presence: presence.status } : null;
}

async function listCurrentLifecycleDaemonStates(): Promise<NormalizedDaemonState[]> {
  const states: NormalizedDaemonState[] = [];
  for (const statePath of resolveDaemonStateCandidatePathsForCurrentLifecycle()) {
    const state = await readDaemonStateFromPath(statePath);
    if (state) {
      states.push(state);
    }
  }
  return states;
}

export type DaemonStatusEntry = Readonly<{
  serverId: string;
  name: string;
  serverUrl: string;
  comparableKey: string | null;
  daemonStatePath: string;
  auth?: Readonly<{
    authenticated: boolean;
    needsAuth: boolean;
    machineRegistered: boolean;
    machineId: string | null;
    accountId: string | null;
  }>;
  drift?: Readonly<{
    activeComparableKey: string | null;
    matchesActiveRelay: boolean | null;
  }>;
  service: Readonly<{
    installed: boolean;
    running?: boolean;
    platform?: string;
    installedPath?: string;
  }>;
  daemon: Readonly<{
    pid: number | null;
    httpPort: number | null;
    running: boolean;
    presence: DaemonPublicationPresenceInspection['status'];
    staleStateFile: boolean;
  }>;
}>;

function resolveComparableKey(rawUrl: string): string | null {
  const value = String(rawUrl ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    return createServerUrlComparableKey(value);
  } catch {
    return null;
  }
}

function resolveCredentialPathCandidates(serverId: string): Readonly<{ primaryPath: string; legacyPath: string }> {
  const primaryPath = join(configuration.serversDir, serverId, 'access.key');
  const legacyPath = join(configuration.happyHomeDir, 'access.key');
  return { primaryPath, legacyPath };
}

async function readAuthTokenForServerId(serverId: string): Promise<string | null> {
  const { primaryPath, legacyPath } = resolveCredentialPathCandidates(serverId);
  const canUseLegacy = serverId === 'cloud' && existsSync(legacyPath) && !existsSync(primaryPath);

  const path = existsSync(primaryPath) ? primaryPath : canUseLegacy ? legacyPath : null;
  if (!path) return null;

  try {
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    const token = typeof raw?.token === 'string' ? raw.token.trim() : '';
    return token ? token : null;
  } catch {
    return null;
  }
}

function resolveAccountIdFromToken(token: string | null): string | null {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return null;
  try {
    const payload = decodeJwtPayload(value);
    return typeof payload?.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

type ServerServiceInstallation = Readonly<{ installed: boolean; platform?: string; installedPath?: string }>;

function resolveServiceInstallationSnapshot(
  params: Readonly<{ serverId: string; serverUrl: string; targetMode: 'pinned' | 'default-following' }>,
): ServerServiceInstallation {
  const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv({
    processEnv: {
      ...process.env,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: params.targetMode,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: params.serverId,
      HAPPIER_DAEMON_SERVICE_SERVER_URL: params.serverUrl,
    },
  });
  return { installed: snapshot.installed, platform: snapshot.platform, installedPath: snapshot.installedPath };
}

/**
 * The background service that serves `serverId` on this computer: its own pinned service, else —
 * for the relay this home's persisted selection names — the default-following service, which
 * follows that selection. Any other relay has no service unless it has a pinned one.
 */
function resolveServiceInstallationForServer(
  params: Readonly<{ serverId: string; serverUrl: string; persistedActiveServerId: string }>,
): ServerServiceInstallation {
  const pinned = resolveServiceInstallationSnapshot({ ...params, targetMode: 'pinned' });
  const selected = resolveServingThisComputerService({
    defaultFollowing: { eligible: params.serverId === params.persistedActiveServerId, value: 'default-following' },
    pinned: [{ eligible: pinned.installed, value: 'pinned' }],
  });
  return selected?.serving === 'default-following'
    ? resolveServiceInstallationSnapshot({ ...params, targetMode: 'default-following' })
    : pinned;
}

export async function listDaemonStatusesForAllKnownServers(): Promise<DaemonStatusEntry[]> {
  const settings = await readSettings();
  const persistedServers = settings.servers ?? {};
  const servers: Record<string, { name?: string; serverUrl?: string }> = { ...persistedServers };
  const activeServerId = (configuration.activeServerId ?? '').toString().trim();
  if (activeServerId && !servers[activeServerId]) {
    servers[activeServerId] = {
      name: 'Active Server (current scope)',
      serverUrl: configuration.serverUrl,
    };
  }
  const serverIds = Object.keys(servers);
  const results: DaemonStatusEntry[] = [];
  const activeComparableKey = resolveComparableKey(configuration.publicServerUrl || configuration.serverUrl);
  // The default-following service follows the persisted selection, never this invocation's `--server`.
  const persistedActiveServerId = sanitizeServerIdForFilesystem(settings.activeServerId ?? 'cloud', 'cloud');

  for (const serverId of serverIds) {
    const profile = servers[serverId];
    const name = profile?.name ?? serverId;
    const serverUrl =
      (profile?.serverUrl ?? '').toString().trim() ||
      (serverId === activeServerId ? (configuration.serverUrl ?? '').toString().trim() : '');
    const { daemonStatePath, state, presence } = await resolveDaemonPublicationForServerId(serverId);
    const running = presence.status === 'running';
    const serviceManagedDaemonRunning = running
      && resolveDaemonStartupSourceServiceManagedState(state?.startupSource, state?.serviceLabel) === true;
    const staleStateFile = Boolean(state && presence.status === 'not_running');
    const comparableKey = resolveComparableKey(serverUrl);
    const serviceInstallation = resolveServiceInstallationForServer({ serverId, serverUrl, persistedActiveServerId });
    const token = await readAuthTokenForServerId(serverId);
    const accountId = resolveAccountIdFromToken(token);
    const machineId = resolveMachineIdForServerFromSettings(settings, serverId, accountId);
    const authenticated = token != null;
    const machineRegistered = machineId != null;
    const needsAuth = !authenticated || !machineRegistered;
    const matchesActiveRelay = activeComparableKey && comparableKey ? activeComparableKey === comparableKey : null;
    results.push({
      serverId,
      name,
      serverUrl,
      comparableKey,
      daemonStatePath,
      auth: {
        authenticated,
        needsAuth,
        machineRegistered,
        machineId,
        accountId,
      },
      drift: {
        activeComparableKey,
        matchesActiveRelay,
      },
      service: {
        ...serviceInstallation,
        running: serviceInstallation.installed && serviceManagedDaemonRunning,
      },
      daemon: {
        pid: state?.pid ?? null,
        httpPort: state?.httpPort ?? null,
        running,
        presence: presence.status,
        staleStateFile,
      },
    });
  }

  return results;
}

async function waitForProcessDeath(observation: PublishedDaemonOwnerObservation, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!await observation.isPresent()) return true;
    await new Promise((r) => setTimeout(r, 75));
  }
  return !await observation.isPresent();
}

async function stopDaemonViaHttpBestEffort(state: NormalizedDaemonState, opts: StopDaemonOptions): Promise<boolean> {
  try {
    const rawTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    const parsedTimeout = typeof rawTimeout === 'string' ? Number.parseInt(rawTimeout, 10) : Number.NaN;
    const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10_000;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.controlToken) headers['x-happier-daemon-token'] = state.controlToken;

    const response = await fetch(`http://127.0.0.1:${state.httpPort}/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.stopSessions ? { stopSessions: true } : {}),
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function hasUsableControlToken(state: NormalizedDaemonState): boolean {
  return typeof state.controlToken === 'string' && state.controlToken.trim().length > 0;
}

export type DaemonsStopResult = Readonly<
  | { status: 'not_running' }
  | { status: 'stopped'; stoppedCount: number }
>;

/** Durable publications outlive mutable profiles; release rings have independent owners. */
async function listPublishedDaemonStatePaths(): Promise<readonly string[]> {
  try {
    const entries = await readdir(configuration.serversDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
      .flatMap((serverId) => resolveDaemonStateCandidatePaths({
        serverDir: join(configuration.serversDir, serverId),
        preferredRing: configuration.publicReleaseRing,
      }))
      .filter((path) => existsSync(path) || existsSync(`${path}.lock`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function assertNoLiveDaemonPublicationAfterStop(hiddenPublicationPaths: ReadonlySet<string>): Promise<void> {
  for (const statePath of await listPublishedDaemonStatePaths()) {
    const state = await readDaemonStateFromPath(statePath);
    if (!state) {
      if (existsSync(statePath)) throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
      const startup = await inspectDaemonLockStartupProgress(`${statePath}.lock`, { unobservablePidIsUnverified: hiddenPublicationPaths.has(statePath) });
      if (startup) {
        throw new DaemonStopIncompleteError({
          reason: startup.status === 'starting' ? 'startup_in_progress' : 'process_identity_unverified',
          pid: startup.pid,
        });
      }
      continue;
    }
    if (await observePublishedDaemonOwner(state, `${statePath}.lock`, { unobservablePidIsUnverified: hiddenPublicationPaths.has(statePath) }).isPresent()) {
      throw new DaemonStopIncompleteError({ reason: 'graceful_stop_unconfirmed', pid: state.pid });
    }
  }
}

/**
 * Attempts every published daemon, including removed profiles and startup-only locks.
 * Uses HTTP only; publication cleanup belongs to the daemon lifecycle lock owner.
 */
export async function stopAllDaemonsBestEffort(opts: StopDaemonOptions = {}): Promise<DaemonsStopResult> {
  try {
    let stoppedCount = 0;
    const hiddenPublicationPaths = new Set<string>();
    let incomplete: DaemonStopIncompleteError | null = null;
    for (const statePath of await listPublishedDaemonStatePaths()) {
      const state = await readDaemonStateFromPath(statePath);
      if (!state) {
        if (existsSync(statePath)) {
          incomplete ??= new DaemonStopIncompleteError({ reason: 'control_client_failure' });
          continue;
        }
        const startup = await inspectDaemonLockStartupProgress(`${statePath}.lock`);
        if (startup) {
          incomplete ??= new DaemonStopIncompleteError({
            reason: startup.status === 'starting' ? 'startup_in_progress' : 'process_identity_unverified',
            pid: startup.pid,
          });
        } else {
          await reclaimDeadDaemonPublication({ stateFile: statePath });
        }
        continue;
      }
      const observation = observePublishedDaemonOwner(state, `${statePath}.lock`);
      if (!await observation.isPresent()) {
        await observation.reclaimIfDead();
        continue;
      }
      if (!await stopDaemonViaHttpBestEffort(state, opts)) {
        incomplete ??= new DaemonStopIncompleteError({ reason: 'control_client_failure', pid: state.pid });
        continue;
      }
      observation.acknowledgeStop();
      if (!await waitForProcessDeath(observation, 2500)) {
        incomplete ??= new DaemonStopIncompleteError({ reason: 'graceful_stop_unconfirmed', pid: state.pid });
        continue;
      }
      await observation.reclaimIfDead();
      stoppedCount += 1;
      if (observation.hasHiddenPid()) hiddenPublicationPaths.add(statePath);
    }
    if (incomplete) throw incomplete;
    await assertNoLiveDaemonPublicationAfterStop(hiddenPublicationPaths);
    return stoppedCount > 0 ? { status: 'stopped', stoppedCount } : { status: 'not_running' };
  } catch (error) {
    if (error instanceof DaemonStopIncompleteError) throw error;
    logger.debug('[multi-daemon] failed to inspect daemon stop targets', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }
}

/**
 * Stops live daemons that published state in the starting daemon's own lifecycle directory but are
 * not its preserved owner — in practice a pre-canonical CLI whose ring-scoped state and lock
 * (`daemon.<ring>.state.json[.lock]`) sit beside the canonical ones, so the canonical lock cannot
 * keep it from running beside this daemon for the same relay.
 *
 * Daemons of other relay profiles live in other lifecycle directories and are never touched: one
 * daemon per relay on one machine is the supported topology (`happier daemon status --all`).
 */
export async function reapCurrentLifecycleDaemonOrphansBeforeStart(
  opts: Readonly<{
    preservePids?: readonly number[];
  }> = {},
): Promise<DaemonLifecycleOrphanReapResult> {
  const preservePids = new Set(
    [process.pid, ...(opts.preservePids ?? [])]
      .filter((pid): pid is number => Number.isInteger(pid) && pid > 0),
  );
  const stoppedPids = new Set<number>();
  const preservedPids = new Set<number>();
  const failedPids = new Set<number>();
  const stoppedOrAttemptedPids = new Set<number>();

  for (const state of await listCurrentLifecycleDaemonStates()) {
    if (preservePids.has(state.pid)) {
      preservedPids.add(state.pid);
      continue;
    }

    const observation = observePublishedDaemonOwner(state);
    if (!await observation.isPresent()) continue;

    if (stoppedOrAttemptedPids.has(state.pid)) {
      continue;
    }
    stoppedOrAttemptedPids.add(state.pid);

    if (!hasUsableControlToken(state)) {
      failedPids.add(state.pid);
      continue;
    }

    const stopped = await stopDaemonViaHttpBestEffort(state, { stopSessions: false });
    if (!stopped) {
      failedPids.add(state.pid);
      continue;
    }

    observation.acknowledgeStop();
    const exited = await waitForProcessDeath(observation, 2500);
    if (!exited) {
      failedPids.add(state.pid);
      continue;
    }

    stoppedPids.add(state.pid);
  }

  return {
    stoppedPids: [...stoppedPids],
    preservedPids: [...preservedPids],
    failedPids: [...failedPids],
  };
}
