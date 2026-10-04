import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { resolveDaemonServiceInstallationSnapshotFromEnv } from '@/daemon/service/cli';
import { clearDaemonStateForTests } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

/**
 * The status projection must carry the background service's *target mode*, because
 * "a service is installed and owns the running daemon" is not the same fact as "that
 * service follows the default relay". A reader that conflates them can repoint a pinned
 * service without asking. `null` means the projection could not prove a mode.
 */

const ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
] as const;

function writeInstalledUnit(declaredTargetMode: string | null): string {
  const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
  mkdirSync(dirname(snapshot.installedPath), { recursive: true });
  writeFileSync(snapshot.installedPath, [
    '[Service]',
    'ExecStart=/opt/happier/happier daemon start-sync',
    'Environment=HAPPIER_DAEMON_STARTUP_SOURCE=background-service',
    `Environment=HAPPIER_HOME_DIR=${process.env.HAPPIER_HOME_DIR}`,
    ...(declaredTargetMode === null
      ? []
      : [`Environment=HAPPIER_DAEMON_SERVICE_TARGET_MODE=${declaredTargetMode}`]),
    '',
  ].join('\n'));
  return snapshot.installedPath;
}

describe('readDaemonStatusSnapshot service.targetMode', () => {
  let envScope = createEnvKeyScope([...ENV_KEYS]);
  let tmpHomeDir: string | null = null;

  beforeEach(async () => {
    tmpHomeDir = await createTempDir('happier-status-service-target-mode-');
    envScope.patch({
      HAPPIER_HOME_DIR: tmpHomeDir,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: tmpHomeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: tmpHomeDir,
    });
    reloadConfiguration();
  });

  afterEach(async () => {
    await clearDaemonStateForTests();
    envScope.restore();
    envScope = createEnvKeyScope([...ENV_KEYS]);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('reports default-following for the installed default-following service', async () => {
    writeInstalledUnit('default-following');

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service).toEqual({ installed: true, running: false, targetMode: 'default-following', autostart: null });
  });

  it('reports pinned for an installed service pinned to one relay profile', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'company',
    });
    reloadConfiguration();
    const installedPath = writeInstalledUnit('pinned');
    expect(installedPath.endsWith('happier-daemon.company.service')).toBe(true);

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service).toEqual({ installed: true, running: false, targetMode: 'pinned', autostart: null });
  });

  /**
   * A stable-ring service pinned to the profile literally named `default` lands on the same
   * file name the default-following installation uses, so the file name cannot decide the mode.
   * The definition declares it, and the declaration wins — otherwise "service installed" reads
   * as "default-following" for a service the app must never move on its own.
   */
  it('reports pinned when the definition declares pinned on the default-segment path', async () => {
    envScope.patch({
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'default',
    });
    reloadConfiguration();
    const installedPath = writeInstalledUnit('pinned');
    expect(installedPath.endsWith('happier-daemon.default.service')).toBe(true);

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service.targetMode).toBe('pinned');
  });

  it('reports null rather than a default when no service definition is installed', async () => {
    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const snapshot = await readDaemonStatusSnapshot();

    expect(snapshot.service).toEqual({ installed: false, running: false, targetMode: null, autostart: null });
  });

  it('reports null when the file at the installed path is not a readable service definition', async () => {
    const snapshot = resolveDaemonServiceInstallationSnapshotFromEnv();
    mkdirSync(dirname(snapshot.installedPath), { recursive: true });
    writeFileSync(snapshot.installedPath, 'not a happier service unit\n');

    const { readDaemonStatusSnapshot } = await import('./statusSnapshot');
    const result = await readDaemonStatusSnapshot();

    expect(result.service).toEqual({ installed: false, running: false, targetMode: null, autostart: null });
  });
});
