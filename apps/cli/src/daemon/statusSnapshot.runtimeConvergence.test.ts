import http from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { clearDaemonStateForTests, updateSettings, writeCredentialsLegacy, writeDaemonState } from '@/persistence';
import { projectPath } from '@/projectPath';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

const ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
] as const;

function listen(server: http.Server): Promise<{ port: number; url: string }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function encodeJwtPayload(payload: Record<string, unknown>): string {
  const segment = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
  return `${segment(JSON.stringify({ alg: 'none' }))}.${segment(JSON.stringify(payload))}.sig`;
}

function currentCliVersion(): string {
  return resolveComparableCliVersion({
    fallbackVersion: configuration.currentCliVersion,
    projectRootPath: projectPath(),
    readFileSyncImpl: readFileSync,
  });
}

function installManagedServiceUnit(): string {
  const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
  mkdirSync(dirname(snapshot.installedPath), { recursive: true });
  writeFileSync(snapshot.installedPath, [
    '[Service]',
    'ExecStart=/opt/happier/happier daemon start-sync',
    'Environment=HAPPIER_DAEMON_STARTUP_SOURCE=background-service',
    `Environment=HAPPIER_HOME_DIR=${configuration.happyHomeDir}`,
    '',
  ].join('\n'));
  return snapshot.label;
}

describe('readDaemonStatusSnapshot runtimeConvergence', () => {
  let envScope = createEnvKeyScope([...ENV_KEYS]);
  let tmpHomeDir: string | null = null;
  const servers: http.Server[] = [];

  beforeEach(async () => {
    tmpHomeDir = await createTempDir('happier-status-runtime-convergence-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearDaemonStateForTests();
    for (const server of servers.splice(0)) {
      await closeServer(server);
    }
    envScope.restore();
    envScope = createEnvKeyScope([...ENV_KEYS]);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  async function startRelay(validatedAccountId: string, profile: Record<string, unknown> = {}): Promise<string> {
    const relay = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/account/profile') {
        res.statusCode = 200;
        res.end(JSON.stringify({ id: validatedAccountId, ...profile }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    servers.push(relay);
    return (await listen(relay)).url;
  }

  async function startDaemonControl(controlToken: string): Promise<number> {
    const control = http.createServer((req, res) => {
      const authorized = req.headers['x-happier-daemon-token'] === controlToken;
      res.statusCode = authorized ? 200 : 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(authorized ? { status: 'ok' } : {}));
    });
    servers.push(control);
    return (await listen(control)).port;
  }

  async function seedHome(params: Readonly<{ relayUrl: string; accountId: string; machineId: string }>): Promise<void> {
    envScope.patch({
      HAPPIER_HOME_DIR: tmpHomeDir!,
      HAPPIER_SERVER_URL: params.relayUrl,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmpHomeDir!,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: tmpHomeDir!,
    });
    reloadConfiguration();
    await writeCredentialsLegacy({
      secret: new Uint8Array(32),
      token: encodeJwtPayload({ sub: params.accountId }),
    });
    const activeServerId = configuration.activeServerId;
    await updateSettings((current) => ({
      ...current,
      lastTokenSubByServerId: { ...(current.lastTokenSubByServerId ?? {}), [activeServerId]: params.accountId },
      machineIdByServerIdByAccountId: {
        ...(current.machineIdByServerIdByAccountId ?? {}),
        [activeServerId]: { [params.accountId]: params.machineId },
      },
    }));
  }

  it('names the validated account and reports the cached CLI update of this channel without a network check', async () => {
    const relayUrl = await startRelay('acct_b', { username: 'bea' });
    await seedHome({ relayUrl, accountId: 'acct_b', machineId: 'machine-b' });
    const cacheFile = `${configuration.happyHomeDir}/cache/${configuration.publicReleaseRing === 'stable' ? 'update.json' : `update.${configuration.publicReleaseRing === 'publicdev' ? 'dev' : 'preview'}.json`}`;
    mkdirSync(dirname(cacheFile), { recursive: true });
    const latest = configuration.publicReleaseRing === 'stable' ? '999.0.0' : configuration.publicReleaseRing === 'preview' ? '999.0.0-preview.1' : '999.0.0-dev.1';
    writeFileSync(cacheFile, JSON.stringify({
      checkedAt: Date.now(),
      latest,
      current: '0.0.1',
      runtimeVersion: null,
      invokerVersion: '0.0.1',
      updateAvailable: true,
      notifiedAt: null,
    }));

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.auth.accountLabel).toBe('bea');
    expect(snapshot.cliUpdate).toEqual({
      currentVersion: configuration.currentCliVersion,
      latestVersion: latest,
      updateAvailable: true,
      // K5: the same facts every daemon publishes in its machine metadata. A test process runs
      // from the repo, not a managed install, so it names no update command and no remote update.
      channel: configuration.publicReleaseRing === 'publicdev' ? 'dev' : configuration.publicReleaseRing,
      installSource: 'other',
      updateCommand: null,
      canUpdateRemotely: false,
      lastUpdate: null,
    });
  });

  it('does not report a daemon running as account A as converged once account B credentials are on disk', async () => {
    const relayUrl = await startRelay('acct_b');
    await seedHome({ relayUrl, accountId: 'acct_b', machineId: 'machine-b' });
    const serviceLabel = installManagedServiceUnit();
    const controlToken = 'control-token';
    const httpPort = await startDaemonControl(controlToken);
    writeDaemonState({
      pid: process.pid,
      httpPort,
      startedAt: Date.now(),
      startedWithCliVersion: currentCliVersion(),
      startupSource: 'background-service',
      serviceLabel,
      machineId: 'machine-a',
      controlToken,
    });

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.auth).toMatchObject({
      authenticated: true,
      credentialState: 'valid',
      validatedAccountId: 'acct_b',
      machineId: 'machine-b',
    });
    expect(snapshot.daemon.running).toBe(true);
    expect(snapshot.service).toEqual({ installed: true, running: true, targetMode: 'default-following', autostart: null });
    expect(snapshot.runtimeConvergence).toEqual({
      controlReachable: true,
      serviceOwnsRunningDaemon: true,
      machineIdMatches: false,
      cliVersionMatches: true,
    });
  });

  it('reports full convergence for a service-owned daemon reachable only through authenticated control', async () => {
    const relayUrl = await startRelay('acct_b');
    await seedHome({ relayUrl, accountId: 'acct_b', machineId: 'machine-b' });
    const serviceLabel = installManagedServiceUnit();
    const controlToken = 'control-token';
    const httpPort = await startDaemonControl(controlToken);
    writeDaemonState({
      pid: 987_654_321,
      httpPort,
      startedAt: Date.now(),
      startedWithCliVersion: currentCliVersion(),
      startupSource: 'background-service',
      serviceLabel,
      machineId: 'machine-b',
      controlToken,
    });

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.runtimeConvergence).toEqual({
      controlReachable: true,
      serviceOwnsRunningDaemon: true,
      machineIdMatches: true,
      cliVersionMatches: true,
    });
  });

  it('derives serviceOwnsRunningDaemon from daemon ownership, so a manually started daemon is not service-owned', async () => {
    const relayUrl = await startRelay('acct_b');
    await seedHome({ relayUrl, accountId: 'acct_b', machineId: 'machine-b' });
    installManagedServiceUnit();
    const controlToken = 'control-token';
    const httpPort = await startDaemonControl(controlToken);
    writeDaemonState({
      pid: process.pid,
      httpPort,
      startedAt: Date.now(),
      startedWithCliVersion: currentCliVersion(),
      startupSource: 'manual',
      machineId: 'machine-b',
      controlToken,
    });

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.runtimeConvergence).toEqual({
      controlReachable: true,
      serviceOwnsRunningDaemon: false,
      machineIdMatches: true,
      cliVersionMatches: true,
    });
  });

  it('reports nothing converged and unknown validation when no daemon runs and the relay is unreachable', async () => {
    const relay = http.createServer(() => {});
    const { url: relayUrl } = await listen(relay);
    await closeServer(relay);
    await seedHome({ relayUrl, accountId: 'acct_b', machineId: 'machine-b' });

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.auth).toMatchObject({
      authenticated: true,
      credentialState: 'unknown',
      validatedAccountId: null,
    });
    expect(snapshot.runtimeConvergence).toEqual({
      controlReachable: false,
      serviceOwnsRunningDaemon: false,
      machineIdMatches: false,
      cliVersionMatches: false,
    });
  });
});
