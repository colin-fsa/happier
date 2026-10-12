import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { preparePayloadMock, installPayloadMock, runCommandCaptureMock } = vi.hoisted(() => ({
  preparePayloadMock: vi.fn(),
  installPayloadMock: vi.fn(),
  runCommandCaptureMock: vi.fn(),
}));

// Only the two genuine boundaries are replaced: the release download and the payload install that
// writes outside the test's control. Path resolution and the install record it reads stay real, so
// a fixture that does not look like a real install is classified like one.
vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    prepareFirstPartyComponentPayloadFromGitHubRelease: preparePayloadMock,
    installVersionedPayload: installPayloadMock,
  };
});

/** The on-disk shape `installVersionedPayload` leaves behind: payload, pointer and version record. */
function writeInstalledPayloadFixture(params: Readonly<{
  happyHomeDir: string;
  versionId: string;
  binaryContents: string;
}>): void {
  const installRoot = join(params.happyHomeDir, 'cli');
  const versionPath = join(installRoot, 'versions', params.versionId);
  const currentPath = join(installRoot, 'current');
  for (const dir of [versionPath, currentPath]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'happier'), params.binaryContents, 'utf8');
    chmodSync(join(dir, 'happier'), 0o755);
  }
  writeFileSync(join(installRoot, 'current.version'), `${params.versionId}\n`, 'utf8');
}

vi.mock('./taskRuntime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskRuntime.js')>();
  return {
    ...actual,
    runCommandCapture: runCommandCaptureMock,
  };
});

import { writeHappierCliChoice } from '@happier-dev/cli-common/firstPartyRuntime';

import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';

import {
  describeUnservedCliChoiceFailure,
  ensureSetupCapableLocalHappierCli,
  inspectLocalHappierCliChoice,
  runLocalHappierJsonCommand,
  SETUP_CLI_VERSION_FLOOR,
  updateManagedLocalHappierCli,
} from './happierCli.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('runLocalHappierJsonCommand', () => {
  it('acquires the managed happier cli on demand before running local bootstrap commands', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-install-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const payloadRoot = join(rootDir, 'payload');
    const installedBinaryPath = join(payloadRoot, 'happier');

    try {
      mkdirSync(payloadRoot, { recursive: true });
      writeFileSync(
        installedBinaryPath,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\'\n',
        'utf8',
      );
      chmodSync(installedBinaryPath, 0o755);
      mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
      writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export default "machine-auto-installed";\n', 'utf8');

      preparePayloadMock.mockResolvedValue({
        versionId: '1.2.3',
        payloadRoot,
        cleanup: async () => {},
      });
      installPayloadMock.mockImplementation(async (params: Readonly<{
        processEnv?: NodeJS.ProcessEnv;
        versionId: string;
      }>) => {
        writeInstalledPayloadFixture({
          happyHomeDir: String(params.processEnv?.HAPPIER_HOME_DIR ?? happyHomeDir),
          versionId: params.versionId,
          binaryContents: '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\'\n',
        });
      });
      runCommandCaptureMock.mockResolvedValue({
        status: 0,
        stdout: '{"ok":true,"data":{"authenticated":true,"machineId":"machine-auto-installed"}}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['auth', 'status', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_HOME_DIR: happyHomeDir,
        },
      })).resolves.toMatchObject({
        ok: true,
        data: {
          authenticated: true,
          machineId: 'machine-auto-installed',
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('treats a signal-terminated happier process as a failed command', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-signal-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(cliPath, '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n', 'utf8');
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 1,
        stdout: '',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['auth', 'status', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).rejects.toMatchObject({
        code: 'cli_command_failed',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    { cliCode: 'not_installed', expectedCode: 'cli_command_failed', status: 0 },
    { cliCode: 'service_manager_unavailable', expectedCode: 'service_manager_unavailable', status: 0 },
    { cliCode: 'service_manager_unavailable', expectedCode: 'service_manager_unavailable', status: 1 },
  ])('reports $cliCode from a failed CLI command (exit $status)', async ({ cliCode, expectedCode, status }) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-json-failure-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(
        cliPath,
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: false, error: { code: "not_installed" }, message: "service missing" }) + "\\n");\n',
        'utf8',
      );
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status,
        stdout: `${JSON.stringify({ ok: false, error: cliCode === 'service_manager_unavailable' ? cliCode : { code: cliCode }, message: 'service missing' })}\n`,
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['daemon', 'service', 'start', '--json'],
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).rejects.toMatchObject({
        code: expectedCode,
        message: 'service missing',
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('returns ok:false json envelopes when allowJsonFailure is set even if the CLI exits non-zero', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-json-exit-1-'));
    const cliPath = join(rootDir, 'fake-happier');

    try {
      writeFileSync(
        cliPath,
        '#!/usr/bin/env node\nprocess.exitCode = 1;\nprocess.stdout.write(JSON.stringify({ ok: false, kind: "auth_status", error: { code: "not_authenticated" } }) + "\\n");\n',
        'utf8',
      );
      chmodSync(cliPath, 0o755);
      runCommandCaptureMock.mockResolvedValue({
        status: 1,
        stdout: '{"ok":false,"kind":"auth_status","error":{"code":"not_authenticated"}}\n',
        stderr: '',
      });

      await expect(runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['auth', 'status', '--json'],
        allowJsonFailure: true,
        processEnv: {
          ...process.env,
          HAPPIER_BOOTSTRAP_CLI_PATH: cliPath,
        },
      })).resolves.toMatchObject({
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'not_authenticated',
        },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('the environment a Happier CLI runs with (R12, macOS)', () => {
  it('on macOS runs the CLI with the PATH that found it, so an npm CLI\'s `env node` resolves from a Dock-launched app', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      runCommandCaptureMock.mockResolvedValue({ status: 0, stdout: '{"ok":true}\n', stderr: '' });
      // What launchd gives an app opened from the Dock or Finder.
      await runLocalHappierJsonCommand({
        releaseRing: 'stable',
        args: ['daemon', 'status', '--json'],
        processEnv: { HOME: '/Users/me', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        cli: { command: '/opt/homebrew/bin/happier', provenance: 'override' },
      });

      const env = runCommandCaptureMock.mock.calls[0]?.[0]?.env as NodeJS.ProcessEnv;
      expect(String(env.PATH).split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']));
      expect(String(env.PATH).split(':')[0]).toBe('/usr/bin');
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });
});

describe('ensureSetupCapableLocalHappierCli', () => {
  beforeEach(() => {
    // The CLI subprocess boundary reports no running service in these floor/selection tests.
    runCommandCaptureMock.mockImplementation(async ({ args }: Readonly<{ args: readonly string[] }>) => ({
      status: 0, stderr: '', stdout: JSON.stringify(args.includes('list') ? { entries: [] } : {
        server: { activeServerId: 'cloud', serverUrl: 'https://relay.example.test', localServerUrl: null, publicServerUrl: 'https://relay.example.test', webappUrl: 'https://app.example.test', comparableKey: 'relay.example.test' },
        daemon: { running: false, serviceManaged: false, pid: null, httpPort: null },
        service: { installed: false, running: false },
        auth: { authenticated: false, machineRegistered: false, machineId: null, needsAuth: true, accountId: null },
      }),
    }));
  });
  function withOverrideCli(run: (params: Readonly<{ cliPath: string; processEnv: NodeJS.ProcessEnv }>) => Promise<void>) {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-setup-floor-'));
    const cliPath = join(rootDir, 'happier-override');
    writeFileSync(cliPath, '#!/bin/sh\nprintf "0.2.13\\n"\n', 'utf8');
    chmodSync(cliPath, 0o755);
    return run({
      cliPath,
      processEnv: { ...process.env, HAPPIER_HOME_DIR: join(rootDir, 'home'), HAPPIER_BOOTSTRAP_CLI_PATH: cliPath },
    }).finally(() => rmSync(rootDir, { recursive: true, force: true }));
  }

  it('reports an env-resolved CLI as an override and never reacquires it, even below the floor', async () => {
    await withOverrideCli(async ({ cliPath, processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.12');
      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .rejects.toMatchObject({ code: 'cli_override_below_setup_floor' });
      expect(preparePayloadMock).not.toHaveBeenCalled();

      readVersion.mockResolvedValue(`${SETUP_CLI_VERSION_FLOOR}-dev.4`);
      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .resolves.toEqual({ command: cliPath, provenance: 'override', version: `${SETUP_CLI_VERSION_FLOOR}-dev.4` });
    });
  });

  /**
   * The release path knows the newest version on the ring before it writes anything, so a ring
   * that cannot satisfy the floor must fail there. Installing it first would re-download and
   * re-promote a CLI setup cannot drive, on every attempt, and then fail anyway.
   */
  it('fails without installing when the ring\'s newest CLI is below the floor', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-setup-floor-managed-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    try {
      writeInstalledPayloadFixture({
        happyHomeDir,
        versionId: '0.2.12',
        binaryContents: '#!/bin/sh\nprintf "0.2.12\\n"\n',
      });
      preparePayloadMock.mockResolvedValue({ versionId: '0.2.12', payloadRoot: rootDir, cleanup: async () => {} });
      installPayloadMock.mockResolvedValue(undefined);
      const readVersion = vi.fn(async () => '0.2.12');
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir };

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .rejects.toMatchObject({ code: 'cli_below_setup_floor' });
      expect(preparePayloadMock).toHaveBeenCalledTimes(1);
      expect(installPayloadMock).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  /**
   * One default-following service per `~/.happier`, owned by the default channel (R10 D2): an app
   * of another channel drives this computer through that channel's managed CLI, so it never
   * acquires a second CLI that would compete for the service or read its daemon as foreign.
   */
  it('adopts the default channel\'s managed CLI for an app of another channel, and acquires its own ring otherwise', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-default-channel-adoption-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    try {
      writeInstalledPayloadFixture({
        happyHomeDir,
        versionId: SETUP_CLI_VERSION_FLOOR,
        binaryContents: `#!/bin/sh\nprintf "${SETUP_CLI_VERSION_FLOOR}\\n"\n`,
      });
      writeFileSync(join(happyHomeDir, 'default-cli-release-channel.json'), '{"releaseChannel":"stable"}\n', 'utf8');
      const readVersion = vi.fn(async () => SETUP_CLI_VERSION_FLOOR);
      // A temp repo root keeps the walk from finding this checkout as a repo-local override; an
      // Empty PATH and a temp HOME keep macOS's supplemental search path out of the real user home.
      const processEnv = { ...process.env, HOME: rootDir, HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_BOOTSTRAP_CLI_PATH: '', HAPPIER_STACK_REPO_DIR: rootDir, PATH: '' };

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'preview', processEnv }, { readVersion }))
        .resolves.toEqual({
          command: join(happyHomeDir, 'cli', 'current', 'happier'),
          provenance: 'managed',
          version: SETUP_CLI_VERSION_FLOOR,
        });
      expect(preparePayloadMock).not.toHaveBeenCalled();

      // The default channel's CLI is gone: the app's own ring is acquired as before.
      rmSync(join(happyHomeDir, 'cli'), { recursive: true, force: true });
      preparePayloadMock.mockRejectedValue(new Error('offline'));
      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'preview', processEnv }, { readVersion }))
        .rejects.toMatchObject({ code: 'cli_acquisition_resolvingRelease_failed' });
      expect(preparePayloadMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'preview' }));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  /**
   * R12 × D2 (R13 b): a `happier` the user installed follows the default channel, so the service it
   * runs is the default channel's. "Let Happier manage it" replaces that CLI with the default
   * channel's managed one — never the app's own ring, whose first install would repoint the default
   * and turn the user's service into another ring's service to remove.
   */
  it('"Let Happier manage it" on a computer whose CLI was the user\'s adopts the default channel, not the app\'s ring', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-choice-default-channel-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    try {
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_BOOTSTRAP_CLI_PATH: '', HAPPIER_STACK_REPO_DIR: rootDir, PATH: '' };
      await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });
      preparePayloadMock.mockRejectedValue(new Error('offline'));

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'preview', processEnv }))
        .rejects.toMatchObject({ code: 'cli_acquisition_resolvingRelease_failed' });
      expect(preparePayloadMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'stable' }));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  /**
   * Under D2 the adopted CLI belongs to the default channel, so "update the app" is not what can
   * fix it: the failure names that channel, its newest version, the app's channel and the way out.
   */
  it('names the default channel it adopted when that channel cannot satisfy the floor (RV-9)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-default-channel-floor-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    try {
      writeInstalledPayloadFixture({
        happyHomeDir,
        versionId: '0.2.12',
        binaryContents: '#!/bin/sh\nprintf "0.2.12\\n"\n',
      });
      writeFileSync(join(happyHomeDir, 'default-cli-release-channel.json'), '{"releaseChannel":"stable"}\n', 'utf8');
      preparePayloadMock.mockResolvedValue({ versionId: '0.2.12', payloadRoot: rootDir, cleanup: async () => {} });
      const readVersion = vi.fn(async () => '0.2.12');
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_BOOTSTRAP_CLI_PATH: '', HAPPIER_STACK_REPO_DIR: rootDir };

      const failure = await ensureSetupCapableLocalHappierCli({ releaseRing: 'preview', processEnv }, { readVersion })
        .then(() => null, (error: unknown) => error as { code?: string; message?: string });
      expect(failure?.code).toBe('cli_default_channel_below_setup_floor');
      expect(failure?.message).toContain('stable');
      expect(failure?.message).toContain('0.2.12');
      expect(failure?.message).toContain(SETUP_CLI_VERSION_FLOOR);
      expect(failure?.message).toContain('--channel preview');
      expect(preparePayloadMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'stable' }));
      expect(installPayloadMock).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('updates a managed CLI below the floor when the ring has a newer one', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-setup-floor-reacquire-'));
    const happyHomeDir = join(rootDir, '.happier-home');
    const binaryPath = join(happyHomeDir, 'cli', 'current', 'happier');
    try {
      writeInstalledPayloadFixture({
        happyHomeDir,
        versionId: '0.2.12',
        binaryContents: '#!/bin/sh\nprintf "0.2.12\\n"\n',
      });
      const payloadRoot = join(rootDir, 'payload');
      mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
      writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n');
      writeFileSync(join(payloadRoot, 'happier'), `#!/bin/sh\nprintf "${SETUP_CLI_VERSION_FLOOR}\\n"\n`);
      chmodSync(join(payloadRoot, 'happier'), 0o755);
      preparePayloadMock.mockResolvedValue({ versionId: SETUP_CLI_VERSION_FLOOR, payloadRoot, cleanup: async () => {} });
      const readVersion = async ({ command }: Readonly<{ command: string }>) => {
        const match = /printf "([^\\"]+)/u.exec(readFileSync(command, 'utf8'));
        if (!match?.[1]) throw new Error(`no fixture version in ${command}`);
        return match[1];
      };
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir };

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .resolves.toEqual({ command: binaryPath, provenance: 'managed', version: SETUP_CLI_VERSION_FLOOR });
      expect(readFileSync(join(happyHomeDir, 'cli', 'current.version'), 'utf8').trim()).toBe(SETUP_CLI_VERSION_FLOOR);
      expect(installPayloadMock).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('updateManagedLocalHappierCli', () => {
  /** A staged release payload whose `happier` prints `versionId`, as the real one does. */
  function stagePayload(rootDir: string, versionId: string, reports: string = versionId): string {
    const payloadRoot = join(rootDir, `payload-${versionId}`);
    mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
    writeFileSync(join(payloadRoot, 'happier'), `#!/bin/sh\necho ${reports}\n`, 'utf8');
    chmodSync(join(payloadRoot, 'happier'), 0o755);
    writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
    return payloadRoot;
  }

  /** Reads what the fixture binaries print (the `--version` process boundary). */
  const readFixtureVersion = async ({ command }: Readonly<{ command: string }>) => {
    const match = /echo (\S+)/u.exec(readFileSync(command, 'utf8'));
    if (!match?.[1]) throw new Error(`no version in ${command}`);
    return match[1];
  };

  function setup(prefix: string) {
    const rootDir = mkdtempSync(join(tmpdir(), prefix));
    const happyHomeDir = join(rootDir, '.happier-home');
    writeInstalledPayloadFixture({ happyHomeDir, versionId: '0.2.13', binaryContents: '#!/bin/sh\necho 0.2.13\n' });
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_BOOTSTRAP_CLI_PATH: '', HAPPIER_STACK_REPO_DIR: rootDir };
    return { rootDir, happyHomeDir, processEnv };
  }

  it('updates the managed CLI through the one update transaction and reports both versions', async () => {
    const { rootDir, happyHomeDir, processEnv } = setup('hsetup-cli-update-');
    try {
      preparePayloadMock.mockImplementation(async () => ({ versionId: '0.2.14', payloadRoot: stagePayload(rootDir, '0.2.14'), cleanup: async () => {} }));
      const phases: string[] = [];

      const updated = await updateManagedLocalHappierCli({
        releaseRing: 'stable',
        processEnv,
        onProgress: (progress) => { phases.push(progress.phase); },
        planRestart: async () => null,
      }, { readVersion: readFixtureVersion });

      expect(updated).toEqual({
        previousVersion: '0.2.13',
        cli: { command: join(happyHomeDir, 'cli', 'current', 'happier'), provenance: 'managed', version: '0.2.14' },
        restarted: false,
      });
      expect(readFileSync(join(happyHomeDir, 'cli', 'current.version'), 'utf8').trim()).toBe('0.2.14');
      expect(phases).toEqual(expect.arrayContaining(['checkingCli', 'installing', 'finalizing']));
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('restores the previous CLI and restarts it when the service does not come back on the new one', async () => {
    const { rootDir, happyHomeDir, processEnv } = setup('hsetup-cli-update-rollback-');
    try {
      preparePayloadMock.mockImplementation(async () => ({ versionId: '0.2.14', payloadRoot: stagePayload(rootDir, '0.2.14'), cleanup: async () => {} }));
      const restarts: string[] = [];

      await expect(updateManagedLocalHappierCli({
        releaseRing: 'stable',
        processEnv,
        planRestart: async () => async ({ expectedVersion, phase }) => {
          restarts.push(`${phase}:${expectedVersion}`);
          if (phase === 'activated') throw new Error('the service did not come back');
        },
      }, { readVersion: readFixtureVersion })).rejects.toMatchObject({
        code: 'cli_update_rolled_back',
        message: expect.stringContaining('0.2.13 was restored'),
      });

      expect(restarts).toEqual(['activated:0.2.14', 'restored:0.2.13']);
      expect(readFileSync(join(happyHomeDir, 'cli', 'current.version'), 'utf8').trim()).toBe('0.2.13');
      expect(readFileSync(join(happyHomeDir, 'cli', 'current', 'happier'), 'utf8')).toContain('0.2.13');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('activates nothing when the downloaded binary does not report the target version', async () => {
    const { rootDir, happyHomeDir, processEnv } = setup('hsetup-cli-update-smoke-');
    try {
      preparePayloadMock.mockImplementation(async () => ({ versionId: '0.2.14', payloadRoot: stagePayload(rootDir, '0.2.14', '0.2.1'), cleanup: async () => {} }));
      const planRestart = vi.fn(async () => null);

      await expect(updateManagedLocalHappierCli({ releaseRing: 'stable', processEnv, planRestart }, { readVersion: readFixtureVersion }))
        .rejects.toMatchObject({ code: 'cli_update_smoke_failed' });
      expect(readFileSync(join(happyHomeDir, 'cli', 'current.version'), 'utf8').trim()).toBe('0.2.13');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('refuses by name to replace a CLI this app did not install', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-update-override-'));
    const cliPath = join(rootDir, 'happier-override');
    try {
      writeFileSync(cliPath, '#!/bin/sh\n', 'utf8');
      chmodSync(cliPath, 0o755);
      const processEnv = { ...process.env, HAPPIER_HOME_DIR: join(rootDir, 'home'), HAPPIER_BOOTSTRAP_CLI_PATH: cliPath };

      await expect(updateManagedLocalHappierCli({ releaseRing: 'stable', processEnv, planRestart: async () => null }, { readVersion: async () => '0.2.13' }))
        .rejects.toMatchObject({ code: 'cli_not_managed', message: expect.stringContaining(cliPath) });
      expect(preparePayloadMock).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('the one-CLI question (R12)', () => {
  /** An npm global install of the CLI: `<prefix>/bin/happier` → the package's own entry. */
  function withNpmCli(run: (params: Readonly<{ command: string; processEnv: NodeJS.ProcessEnv }>) => Promise<void>) {
    const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-choice-'));
    const packageRoot = join(rootDir, 'npm-global', 'lib', 'node_modules', '@happier-dev', 'cli');
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli' }), 'utf8');
    writeFileSync(join(packageRoot, 'bin', 'happier.mjs'), '#!/bin/sh\n', 'utf8');
    chmodSync(join(packageRoot, 'bin', 'happier.mjs'), 0o755);
    const npmBin = join(rootDir, 'npm-global', 'bin');
    mkdirSync(npmBin, { recursive: true });
    const command = join(npmBin, 'happier');
    symlinkSync(join(packageRoot, 'bin', 'happier.mjs'), command);
    return run({
      command,
      processEnv: { HOME: rootDir, HAPPIER_HOME_DIR: join(rootDir, 'home'), HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'), PATH: npmBin },
    }).finally(() => rmSync(rootDir, { recursive: true, force: true }));
  }

  it('asks about a CLI this app did not install, naming its version, path and the commands that remove or update it', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.13');

      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion })).resolves.toEqual({
        choice: null,
        question: {
          command,
          version: '0.2.13',
          origin: 'npm',
          removalCommand: 'npm uninstall -g @happier-dev/cli',
          updateCommand: 'npm install -g @happier-dev/cli@latest',
          belowSetupFloor: false,
          missing: false,
          keepBlockedBy: null,
        },
      });
    });
  });

  it('does not ask an installer user whose terminal runs the managed CLI first; Settings\' change says what keeping a copy behind it needs (RV3-1)', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.13');
      const happyHomeDir = String(processEnv.HAPPIER_HOME_DIR);
      // The official installer: a managed install, its shim, and `~/.local/bin/happier` → that shim,
      // ahead of an npm copy on PATH.
      writeInstalledPayloadFixture({ happyHomeDir, versionId: '0.2.13', binaryContents: '#!/bin/sh\n' });
      mkdirSync(join(happyHomeDir, 'bin'), { recursive: true });
      symlinkSync(join(happyHomeDir, 'cli', 'current', 'happier'), join(happyHomeDir, 'bin', 'happier'));
      const localBin = join(happyHomeDir, '..', 'local-bin');
      mkdirSync(localBin, { recursive: true });
      const installerLink = join(localBin, 'happier');
      symlinkSync(join(happyHomeDir, 'bin', 'happier'), installerLink);
      const env = { ...processEnv, PATH: `${localBin}:${processEnv.PATH}` };

      // The terminal runs the managed CLI: nothing to ask, even with the npm copy further down.
      await expect(inspectLocalHappierCliChoice({ processEnv: env }, { readVersion })).resolves.toEqual({ choice: null, question: null });
      // Settings still sees the copy behind it.
      await expect(inspectLocalHappierCliChoice({ processEnv: env, reconsider: true }, { readVersion })).resolves.toMatchObject({
        // Keeping it cannot make the terminal run it while the installer's link answers first.
        question: { command, missing: false, keepBlockedBy: installerLink },
      });

      // With the npm copy first, it is the terminal's CLI and the question is asked, Keep included.
      await expect(inspectLocalHappierCliChoice({ processEnv: { ...processEnv, PATH: `${processEnv.PATH}:${localBin}` } }, { readVersion }))
        .resolves.toMatchObject({ question: { command, keepBlockedBy: null } });
    });
  });

  it('still asks about a kept CLI that disappeared, by the path it was at, before anything stands in for it (R13)', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.13');
      await writeHappierCliChoice({ choice: { mode: 'own', command }, processEnv });
      // A managed copy from before "Keep my own" is still on disk.
      writeInstalledPayloadFixture({ happyHomeDir: String(processEnv.HAPPIER_HOME_DIR), versionId: '0.2.13', binaryContents: '#!/bin/sh\n' });
      rmSync(command, { force: true });

      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion })).resolves.toMatchObject({
        choice: { mode: 'own', command },
        question: { command, version: null, missing: true },
      });
      expect(readVersion).not.toHaveBeenCalled();
      // Nothing stands in for it: not the leftover managed copy, not a fresh download.
      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion }))
        .rejects.toMatchObject({ code: 'cli_choice_required' });
      expect(preparePayloadMock).not.toHaveBeenCalled();
      // The app-open read is routed into that question too.
      const required = new SystemTaskExecutionError('cli_choice_required', 'gone');
      expect(describeUnservedCliChoiceFailure(required, { releaseRing: 'stable', processEnv })).toBe(required);

      // A happier installed since somewhere else is what there is to choose now.
      const otherBin = join(String(processEnv.HAPPIER_HOME_DIR), '..', 'brew', 'bin');
      mkdirSync(otherBin, { recursive: true });
      writeFileSync(join(otherBin, 'happier'), '#!/bin/sh\n', 'utf8');
      chmodSync(join(otherBin, 'happier'), 0o755);
      await expect(inspectLocalHappierCliChoice({ processEnv: { ...processEnv, PATH: `${processEnv.PATH}:${otherBin}` } }, { readVersion }))
        .resolves.toMatchObject({ question: { command: join(otherBin, 'happier'), version: '0.2.13', missing: false } });
    });
  });

  it('asks once: a recorded answer is not asked again unless the person asks to change it, or the own CLI fell below the floor', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.13');

      await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });
      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion })).resolves.toEqual({ choice: { mode: 'managed' }, question: null });
      await expect(inspectLocalHappierCliChoice({ processEnv, reconsider: true }, { readVersion }))
        .resolves.toMatchObject({ question: { command, origin: 'npm' } });

      await writeHappierCliChoice({ choice: { mode: 'own', command }, processEnv });
      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion })).resolves.toEqual({ choice: { mode: 'own', command }, question: null });

      readVersion.mockResolvedValue('0.2.5');
      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion }))
        .resolves.toMatchObject({ question: { command, version: '0.2.5', belowSetupFloor: true } });
    });
  });

  it('asks about a CLI that cannot even say its version, naming just its path, and asks again for a kept one (R12)', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      const readVersion = vi.fn(async (): Promise<string> => {
        throw new SystemTaskExecutionError('cli_version_unavailable', 'no output');
      });

      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion }))
        .resolves.toMatchObject({ question: { command, version: null, belowSetupFloor: true } });

      await writeHappierCliChoice({ choice: { mode: 'own', command }, processEnv });
      await expect(inspectLocalHappierCliChoice({ processEnv }, { readVersion }))
        .resolves.toMatchObject({ question: { command, version: null, belowSetupFloor: true } });
    });
  });

  it('keeps a kept CLI that cannot run at all the person\'s own: the same sentence and update command, never acquired', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      await writeHappierCliChoice({ choice: { mode: 'own', command }, processEnv });
      const readVersion = vi.fn(async (): Promise<string> => {
        throw new SystemTaskExecutionError('cli_version_unavailable', 'no output');
      });

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion })).rejects.toMatchObject({
        code: 'cli_own_below_setup_floor',
        message: expect.stringContaining('npm install -g @happier-dev/cli@latest'),
      });
      expect(preparePayloadMock).not.toHaveBeenCalled();
    });
  });

  it('names a failed read by an unanswered or kept CLI as the question setup still has to ask', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      const failure = new SystemTaskExecutionError('invalid_cli_response', 'Daemon status response is invalid.');

      expect(describeUnservedCliChoiceFailure(failure, { releaseRing: 'stable', processEnv }))
        .toMatchObject({ code: 'cli_choice_required', message: expect.stringContaining(command) });

      await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });
      expect(describeUnservedCliChoiceFailure(failure, { releaseRing: 'stable', processEnv })).toBeNull();

      await writeHappierCliChoice({ choice: { mode: 'own', command }, processEnv });
      expect(describeUnservedCliChoiceFailure(failure, { releaseRing: 'stable', processEnv })).toMatchObject({ code: 'cli_choice_required' });
      expect(describeUnservedCliChoiceFailure(new SystemTaskExecutionError('cancelled', 'x'), { releaseRing: 'stable', processEnv })).toBeNull();
      expect(describeUnservedCliChoiceFailure(failure, { releaseRing: 'stable', processEnv: { ...processEnv, HAPPIER_BOOTSTRAP_CLI_PATH: '/dev/happier' } })).toBeNull();
    });
  });

  it('never asks while a developer override names the CLI, nor when no other CLI exists', async () => {
    await withNpmCli(async ({ processEnv }) => {
      const readVersion = vi.fn(async () => '0.2.13');
      await expect(inspectLocalHappierCliChoice({ processEnv: { ...processEnv, HAPPIER_BOOTSTRAP_CLI_PATH: '/dev/happier' } }, { readVersion }))
        .resolves.toMatchObject({ question: null });
      await expect(inspectLocalHappierCliChoice({ processEnv: { ...processEnv, PATH: '' } }, { readVersion }))
        .resolves.toEqual({ choice: null, question: null });
      expect(readVersion).not.toHaveBeenCalled();
    });
  });

  it('keeps the user\'s own CLI below the floor as theirs to update, naming the exact command, and never acquires', async () => {
    await withNpmCli(async ({ command, processEnv }) => {
      await writeHappierCliChoice({ choice: { mode: 'own', command }, processEnv });
      const readVersion = vi.fn(async () => '0.2.5');

      await expect(ensureSetupCapableLocalHappierCli({ releaseRing: 'stable', processEnv }, { readVersion })).rejects.toMatchObject({
        code: 'cli_own_below_setup_floor',
        message: expect.stringContaining('npm install -g @happier-dev/cli@latest'),
      });
      expect(preparePayloadMock).not.toHaveBeenCalled();
      expect(installPayloadMock).not.toHaveBeenCalled();
    });
  });
});
