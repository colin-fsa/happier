import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { readSettings } from '@/persistence';
import { happierHomeDirsMatch } from './happierHomeDirComparableKey';

import {
  discoverInstalledDaemonServiceEntries,
  readInstalledDaemonServiceHomeDir,
  type InstalledDaemonServiceEntry,
} from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import type { DaemonServiceCliRuntime, DaemonServiceListEntry } from '@/daemon/service/paths';
import type { DaemonServiceMode } from '@/daemon/service/plan';
import { commandExistsInPath } from '@/daemon/service/commandExistsInPath';
import { type DaemonStartupSource, isDaemonStartupSourceServiceManaged } from '@/daemon/ownership/daemonOwnershipMetadata';

function resolveDiscoveryModes(platform: DaemonServiceCliRuntime['platform']): readonly DaemonServiceMode[] {
  return platform === 'linux' ? ['user', 'system'] : ['user'];
}

async function discoverInstalledEntriesForMode(
  runtime: DaemonServiceCliRuntime,
  mode: DaemonServiceMode,
): Promise<readonly InstalledDaemonServiceEntry[]> {
  const settings = await readSettings();
  return await discoverInstalledDaemonServiceEntries({
    platform: runtime.platform,
    userHomeDir: runtime.userHomeDir,
    happierHomeDir: runtime.happierHomeDir,
    mode,
    serversById: (settings.servers ?? {}) as Readonly<Record<string, unknown>>,
  });
}

function normalizeComparableServerUrl(url: string | null | undefined): string | null {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return null;
  try {
    return createServerUrlComparableKey(trimmed);
  } catch {
    return null;
  }
}

async function resolveDefaultFollowingRelayMatch(
  runtime: DaemonServiceCliRuntime,
): Promise<boolean> {
  const settings = await readSettings().catch(() => null);
  const activeServerId = String(settings?.activeServerId ?? '').trim() || 'cloud';
  const activeServer = settings?.servers?.[activeServerId];
  if (!activeServer) {
    return runtime.instanceId === 'cloud';
  }

  if (runtime.instanceId !== activeServer.id) {
    return false;
  }

  const currentRelayKey = normalizeComparableServerUrl(runtime.serverUrl);
  if (!currentRelayKey) {
    return true;
  }

  const activeRelayKeys = [
    normalizeComparableServerUrl(activeServer.serverUrl),
    normalizeComparableServerUrl(activeServer.localServerUrl ?? null),
  ].filter((value): value is string => Boolean(value));

  return activeRelayKeys.length === 0 || activeRelayKeys.includes(currentRelayKey);
}

function resolveInstalledServiceHomeDir(entry: Pick<DaemonServiceListEntry, 'platform' | 'path' | 'happierHomeDir'>): string | null {
  return String(entry.happierHomeDir ?? '').trim()
    || readInstalledDaemonServiceHomeDir(entry);
}

type SettingsSnapshot = Readonly<{
  activeServerId: string;
  servers: Readonly<Record<string, SettingsServerSnapshot>>;
}>;

type SettingsServerSnapshot = Readonly<{
  id?: string;
  serverUrl?: string;
  localServerUrl?: string | null;
}>;

function isSettingsServerSnapshot(value: unknown): value is SettingsServerSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSettingsSnapshot(value: unknown): SettingsSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const activeServerId = String((value as { activeServerId?: unknown }).activeServerId ?? '').trim();
  const rawServers = (value as { servers?: unknown }).servers;
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    return null;
  }

  const servers: Record<string, SettingsServerSnapshot> = {};
  for (const [serverId, server] of Object.entries(rawServers as Record<string, unknown>)) {
    if (!isSettingsServerSnapshot(server)) {
      continue;
    }
    servers[serverId] = server;
  }

  return {
    activeServerId,
    servers,
  };
}

async function readSettingsSnapshotForHomeDir(homeDir: string | null | undefined): Promise<SettingsSnapshot | null> {
  const resolvedHomeDir = String(homeDir ?? '').trim();
  if (!resolvedHomeDir) return null;

  try {
    const { readFileSync } = await import('node:fs');
    const parsed = JSON.parse(readFileSync(`${resolvedHomeDir}/settings.json`, 'utf8'));
    return normalizeSettingsSnapshot(parsed);
  } catch {
    return null;
  }
}

function resolveDefaultFollowingRelayMatchFromSettings(
  settings: SettingsSnapshot | null,
  runtime: DaemonServiceCliRuntime,
): boolean {
  const activeServerId = String(settings?.activeServerId ?? '').trim() || 'cloud';
  const activeServer = settings?.servers?.[activeServerId];
  if (!activeServer) {
    return runtime.instanceId === 'cloud';
  }

  if (runtime.instanceId !== activeServer.id) {
    return false;
  }

  const currentRelayKey = normalizeComparableServerUrl(runtime.serverUrl);
  if (!currentRelayKey) {
    return true;
  }

  const activeRelayKeys = [
    normalizeComparableServerUrl(activeServer.serverUrl),
    normalizeComparableServerUrl(activeServer.localServerUrl ?? null),
  ].filter((value): value is string => Boolean(value));

  return activeRelayKeys.length === 0 || activeRelayKeys.includes(currentRelayKey);
}

async function resolveDefaultFollowingRelayMatchForInstalledService(
  entry: InstalledDaemonServiceEntry,
  runtime: DaemonServiceCliRuntime,
): Promise<boolean> {
  const serviceHomeDir = resolveInstalledServiceHomeDir(entry);
  if (!happierHomeDirsMatch(serviceHomeDir, runtime.happierHomeDir)) return false;

  const serviceSettings = await readSettingsSnapshotForHomeDir(serviceHomeDir);
  if (!serviceSettings) {
    return await resolveDefaultFollowingRelayMatch(runtime);
  }

  return resolveDefaultFollowingRelayMatchFromSettings(serviceSettings, runtime);
}

export async function resolveInstalledDaemonServiceInventoryForCurrentRelay(
  runtime: DaemonServiceCliRuntime,
): Promise<readonly DaemonServiceListEntry[]> {
  const entries = await Promise.all(
    resolveDiscoveryModes(runtime.platform).map(async (mode) => await discoverInstalledEntriesForMode(runtime, mode)),
  );
  const matchingEntries: InstalledDaemonServiceEntry[] = [];
  for (const entry of entries.flat()) {
    if (entry.targetMode !== 'default-following') {
      if (entry.serverId === runtime.instanceId) {
        matchingEntries.push(entry);
      }
      continue;
    }
    if (await resolveDefaultFollowingRelayMatchForInstalledService(entry, runtime)) {
      matchingEntries.push(entry);
    }
  }
  return matchingEntries.filter((entry, index, allEntries) => allEntries.findIndex((candidate) => candidate.path === entry.path) === index);
}

function describeDaemonServiceInventoryEntry(entry: InstalledDaemonServiceEntry | DaemonServiceListEntry): string {
  return `${entry.label} (${entry.releaseChannel}, ${entry.targetMode}) — ${entry.path}`;
}

export function renderDaemonServiceInventory(entries: readonly DaemonServiceListEntry[]): Readonly<{
  title: string;
  lines: readonly string[];
}> {
  if (entries.length === 0) {
    return {
      title: 'Installed background services for the selected relay:',
      lines: ['  (none)'],
    };
  }

  return {
    title: 'Installed background services for the selected relay:',
    lines: entries.map((entry) => `  ${describeDaemonServiceInventoryEntry(entry)}`),
  };
}

export function renderDaemonInstalledServiceConflict(params: Readonly<{
  action: 'session-autostart' | 'daemon-start' | 'daemon-start-sync' | 'daemon-restart';
  services: readonly DaemonServiceListEntry[];
}>): Readonly<{ title: string; lines: readonly string[] }> {
  const actionDescription =
    params.action === 'session-autostart'
      ? 'continue without taking over the background service'
      : params.action === 'daemon-start'
        ? 'start another daemon'
        : params.action === 'daemon-start-sync'
          ? 'start another daemon synchronously'
          : 'restart the daemon manually';
  const serviceCommand =
    params.action === 'daemon-restart'
      ? 'Use `happier doctor repair` to switch automatic startup to this installation.'
      : 'Use `happier service start` to start the installed background service instead of starting another daemon.';
  const serviceSummary = renderDaemonServiceInventory(params.services);
  return {
    title: 'A background service is already installed for the selected relay.',
    lines: [
      ...serviceSummary.lines,
      serviceCommand,
      `If you want to ${actionDescription}, stop or replace the installed background service first.`,
    ],
  };
}

export async function evaluateDaemonStartupServiceConflict(params: Readonly<{
  startupSource: DaemonStartupSource | null | undefined;
  runtime: DaemonServiceCliRuntime;
}>): Promise<Readonly<{ kind: 'none' }> | Readonly<{ kind: 'installed-background-service-conflict'; services: readonly DaemonServiceListEntry[] }>> {
  if (isDaemonStartupSourceServiceManaged(params.startupSource) || params.startupSource === 'self-restart') {
    return { kind: 'none' };
  }

  const services = await resolveInstalledDaemonServiceInventoryForCurrentRelay(params.runtime);
  if (services.length === 0) {
    return { kind: 'none' };
  }

  // A readable unit alone does not block manual recovery when systemctl is unavailable in PATH.
  // Live daemon ownership is checked separately; unreadable inventory still fails above.
  if (params.runtime.platform === 'linux'
    && !commandExistsInPath({ cmd: 'systemctl', envPath: process.env.PATH, platform: params.runtime.platform })) {
    return { kind: 'none' };
  }

  return { kind: 'installed-background-service-conflict', services };
}

export function hasInstalledBackgroundServiceConflictForCurrentInstallation(params: Readonly<{
  services: readonly DaemonServiceListEntry[];
  runtime: DaemonServiceCliRuntime;
}>): boolean {
  return params.services.some((service) => happierHomeDirsMatch(resolveInstalledServiceHomeDir(service), params.runtime.happierHomeDir));
}
