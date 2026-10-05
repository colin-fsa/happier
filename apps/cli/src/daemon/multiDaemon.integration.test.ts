import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { buildLaunchdPlistXml, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

import { waitForHttpReady, reserveEphemeralPort } from '@/testkit/http/portUtils';
import { waitForProcessExit } from '@/testkit/process/spawn';

import {
  spawnSleepyDetachedProcess,
  spawnStoppableHttpDaemon,
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
  writeDaemonStateFixture,
} from './testkit/fakeDaemonLifecycle.testkit';
import { listDaemonStatusesForAllKnownServers, stopAllDaemonsBestEffort } from './multiDaemon';
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from './service/cli';

/** The pinned background service that serves `serverId` (its own service, not the default-following one). */
function writeValidPinnedDaemonServiceForCurrentRuntime(homeDir: string, serverId: string): void {
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env, targetMode: 'pinned', instanceId: serverId });
  const paths = resolveDaemonServicePaths(runtime);

  mkdirSync(dirname(paths.installedPath), { recursive: true });

  if (runtime.platform === 'darwin') {
    writeFileSync(
      paths.installedPath,
      buildLaunchdPlistXml({
        label: paths.label,
        programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
        env: {
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_ACTIVE_SERVER_ID: serverId,
          HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        },
        stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
        stderrPath: join(homeDir, 'logs', 'daemon-service.default.err.log'),
        workingDirectory: homeDir,
      }),
      'utf-8',
    );
    return;
  }

  if (runtime.platform === 'linux') {
    writeFileSync(
      paths.installedPath,
      renderSystemdServiceUnit({
        description: 'Happier Daemon',
        execStart: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
        env: {
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
          HAPPIER_ACTIVE_SERVER_ID: serverId,
          HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        },
        wantedBy: 'default.target',
      }),
      'utf-8',
    );
    return;
  }

  writeFileSync(
    paths.installedPath,
    renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: homeDir,
      programArgs: ['C:\\hq\\happier.exe', 'daemon', 'start-sync'],
      env: {
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
        HAPPIER_ACTIVE_SERVER_ID: serverId,
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      },
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath: join(homeDir, 'logs', 'daemon-service.default.err.log'),
    }),
    'utf-8',
  );
}

describe('multi-daemon helpers', () => {
  it('reports no running daemons for an empty publication inventory', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'multi-stop-empty-' }, async () => {
      await expect(stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'not_running' });
    });
  });

  it('fails closed on a removed profile startup lock without a state publication', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'multi-stop-removed-starting-' }, async ({ homeDir }) => {
      const child = spawnSleepyDetachedProcess(['/repo/dist/index.mjs', 'daemon', 'start-sync']);
      const lockPath = join(homeDir, 'servers', 'removed', 'daemon.preview.state.json.lock');
      try {
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, String(child.pid));
        await expect(stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'startup_in_progress', pid: child.pid });
        expect(process.kill(child.pid, 0)).toBe(true);
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        await child.kill();
      }
    });
  });

  it('rechecks startup-only successors after stopping the original daemon', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'multi-stop-starting-successor-' }, async ({ homeDir }) => {
      const predecessor = spawnSleepyDetachedProcess();
      const successor = spawnSleepyDetachedProcess(['/repo/dist/index.mjs', 'daemon', 'start-sync']);
      const statePath = await writeDaemonStateFixture(homeDir, 'removed', { pid: predecessor.pid, httpPort: 47891 });
      const lockPath = join(homeDir, 'servers', 'successor', 'daemon.state.json.lock');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        process.kill(predecessor.pid, 'SIGTERM');
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, String(successor.pid));
        return new Response('{}', { status: 200 });
      });
      try {
        await expect(stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'startup_in_progress', pid: successor.pid });
        expect(existsSync(statePath)).toBe(true);
        expect(existsSync(lockPath)).toBe(true);
        expect(process.kill(successor.pid, 0)).toBe(true);
      } finally {
        fetchSpy.mockRestore();
        await predecessor.kill();
        await successor.kill();
      }
    });
  });

  it.each([false, true])('attempts siblings after an incomplete stop (accepted=%s)', async (accepted) => {
    await withConfiguredDaemonTestHome({ prefix: 'multi-stop-sibling-rings-' }, async ({ homeDir }) => {
      const first = spawnSleepyDetachedProcess();
      const second = spawnSleepyDetachedProcess();
      await writeDaemonStateFixture(homeDir, 'removed', { pid: first.pid, httpPort: 47891 });
      const secondPath = join(homeDir, 'servers', 'removed', 'daemon.preview.state.json');
      writeFileSync(secondPath, JSON.stringify({ pid: second.pid, httpPort: 47892, startedAt: Date.now(), startedWithCliVersion: 'test' }));
      let failFirst = true;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const pid = String(url).includes(':47891/') ? first.pid : second.pid;
        if (pid === first.pid && failFirst) return new Response('{}', { status: accepted ? 200 : 500 });
        process.kill(pid, 'SIGTERM');
        return new Response('{}', { status: 200 });
      });
      try {
        await expect(stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: accepted ? 'graceful_stop_unconfirmed' : 'control_client_failure', pid: first.pid });
        expect(await waitForProcessExit(second.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(process.kill(first.pid, 0)).toBe(true);
        failFirst = false;
        await expect(stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'stopped', stoppedCount: 1 });
      } finally {
        fetchSpy.mockRestore();
        await first.kill();
        await second.kill();
      }
    });
  });

  it('stops two live release rings in the same removed profile', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'multi-stop-two-rings-' }, async ({ homeDir }) => {
      const first = spawnSleepyDetachedProcess();
      const second = spawnSleepyDetachedProcess();
      await writeDaemonStateFixture(homeDir, 'removed', { pid: first.pid, httpPort: 47891 });
      writeFileSync(join(homeDir, 'servers', 'removed', 'daemon.preview.state.json'), JSON.stringify({ pid: second.pid, httpPort: 47892, startedAt: Date.now(), startedWithCliVersion: 'test' }));
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        process.kill(String(url).includes(':47891/') ? first.pid : second.pid, 'SIGTERM');
        return new Response('{}', { status: 200 });
      });
      try {
        await expect(stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'stopped', stoppedCount: 2 });
      } finally {
        fetchSpy.mockRestore();
        await first.kill();
        await second.kill();
      }
    });
  });

  it('lists daemon status per saved server profile', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-' }, async ({ homeDir }) => {
      const accountId = 'acct_123';
      await writeDaemonSettingsFixture(homeDir, {
        machineIdByServerId: {
          company: 'machine_123',
        },
        machineIdByServerIdByAccountId: {
          company: {
            [accountId]: 'machine_abc',
          },
        },
      });

      const sleepy = spawnSleepyDetachedProcess();
      try {
        await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: 12345,
        });
        writeValidPinnedDaemonServiceForCurrentRuntime(homeDir, 'company');

        const serverDir = join(homeDir, 'servers', 'company');
        mkdirSync(serverDir, { recursive: true });
        const token = [
          Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
          Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'),
          '',
        ].join('.');
        writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token, secret: null }, null, 2), { encoding: 'utf-8' });

        const results = await listDaemonStatusesForAllKnownServers();
        const company = results.find((r: { serverId: string }) => r.serverId === 'company');
        expect(company).toBeTruthy();
        expect(company!.daemon.running).toBe(true);
        expect(company?.auth).toEqual({
          authenticated: true,
          needsAuth: false,
          machineRegistered: true,
          machineId: 'machine_abc',
          accountId,
        });
        expect(company?.drift?.activeComparableKey).toBeTruthy();
        expect(company?.drift?.matchesActiveRelay).toBe(false);
        expect(company?.service).toMatchObject({
          installed: true,
          running: false,
        });
      } finally {
        await sleepy.kill();
      }
    });
  });

  it('fails closed when the access token cannot be scoped to an account even if a server-scoped machine id exists', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-opaque-token-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir, {
        machineIdByServerId: {
          company: 'machine-server-scoped',
        },
        machineIdByServerIdByAccountId: {
          company: {
            'acct_123': 'machine-account-scoped',
          },
        },
      });

      const sleepy = spawnSleepyDetachedProcess();
      try {
        await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: 12345,
        });

        const serverDir = join(homeDir, 'servers', 'company');
        mkdirSync(serverDir, { recursive: true });
        writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token: 'not-a-jwt', secret: null }, null, 2), {
          encoding: 'utf-8',
        });

        const results = await listDaemonStatusesForAllKnownServers();
        const company = results.find((r: { serverId: string }) => r.serverId === 'company');
        expect(company).toBeTruthy();
        expect(company!.daemon.running).toBe(true);
        expect(company?.auth).toEqual({
          authenticated: true,
          needsAuth: true,
          machineRegistered: false,
          machineId: null,
          accountId: null,
        });
      } finally {
        await sleepy.kill();
      }
    });
  });

  it('includes env-scoped active server in --all status even when not persisted in settings', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-multi-daemon-active-env-',
        env: {
          HAPPIER_ACTIVE_SERVER_ID: 'stack_qa-agent-4__id_default',
          HAPPIER_SERVER_URL: 'http://127.0.0.1:3999',
          HAPPIER_WEBAPP_URL: 'http://happier-qa-agent-4.localhost:8085',
        },
      },
      async ({ homeDir }) => {
        await writeDaemonSettingsFixture(homeDir, {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Happier Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
              createdAt: 0,
              updatedAt: 0,
              lastUsedAt: 0,
            },
          },
        });

        const sleepy = spawnSleepyDetachedProcess();
        try {
          await writeDaemonStateFixture(homeDir, 'stack_qa-agent-4__id_default', {
            pid: sleepy.pid,
            httpPort: 47777,
          });

          const results = await listDaemonStatusesForAllKnownServers();
          const active = results.find((r: { serverId: string }) => r.serverId === 'stack_qa-agent-4__id_default');
          expect(active).toBeTruthy();
          expect(active?.serverUrl).toBe('http://127.0.0.1:3999');
          expect(active?.daemon.running).toBe(true);
        } finally {
          await sleepy.kill();
        }
      },
    );
  });

  it('stops all running daemons best-effort via /stop without taking over publication cleanup', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-stop-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const port = await reserveEphemeralPort();
      const daemon = spawnStoppableHttpDaemon(port);
      expect(await waitForHttpReady(port, { timeoutMs: 2_000 })).toBe(true);

      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: daemon.pid,
        httpPort: port,
      });
      expect(existsSync(statePath)).toBe(true);

      try {
        await stopAllDaemonsBestEffort();

        expect(await waitForProcessExit(daemon.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(existsSync(statePath)).toBe(true);
      } finally {
        await daemon.kill();
      }
    });
  });

  it('does not delete a successor daemon publication that replaces the stopped owner', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-successor-state-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const port = await reserveEphemeralPort();
      const predecessor = spawnSleepyDetachedProcess();
      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: predecessor.pid,
        httpPort: port,
        controlToken: 'predecessor-token',
      });
      const successorRaw = JSON.stringify({
        pid: process.pid,
        httpPort: 47891,
        startedAt: 1_754_000_000_000,
        startedWithCliVersion: '0.0.0-successor',
        controlToken: 'successor-token',
      }) + '\n';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).endsWith('/ping')) throw Object.assign(new Error('Control closed'), { cause: { code: 'ECONNREFUSED' } });
        try {
          process.kill(predecessor.pid, 'SIGTERM');
        } catch {
          // already exited
        }
        writeFileSync(statePath, successorRaw, 'utf-8');
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      });

      try {
        await expect(stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'graceful_stop_unconfirmed', pid: process.pid });

        expect(await waitForProcessExit(predecessor.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(readFileSync(statePath, 'utf-8')).toBe(successorRaw);
      } finally {
        fetchSpy.mockRestore();
        await predecessor.kill();
      }
    });
  });

  it('leaves stale daemon publication cleanup to the lifecycle lock owner', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-stale-state-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const exited = spawnSleepyDetachedProcess();
      expect(await exited.kill()).toBe(true);
      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: exited.pid,
        httpPort: 47892,
      });
      const stateRaw = readFileSync(statePath, 'utf-8');

      await stopAllDaemonsBestEffort();

      expect(readFileSync(statePath, 'utf-8')).toBe(stateRaw);
    });
  });

  it('sends stopSessions: true when requested', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-stop-sessions-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const port = await reserveEphemeralPort();
      const sleepy = spawnSleepyDetachedProcess();
      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: sleepy.pid,
        httpPort: port,
        controlToken: 'test-token',
      });

      const observed: Array<{ url: string; body: unknown; headers: unknown }> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        if (String(url).endsWith('/ping')) throw Object.assign(new Error('Control closed'), { cause: { code: 'ECONNREFUSED' } });
        observed.push({ url: String(url), body: init?.body, headers: init?.headers });
        try {
          process.kill(sleepy.pid, 'SIGTERM');
        } catch {
          // ignore
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      });

      try {
        await stopAllDaemonsBestEffort({ stopSessions: true });

        expect(JSON.parse(String(observed[0]?.body ?? ''))).toEqual({ stopSessions: true });
        expect(String((observed[0]?.headers ?? ({} as any))['x-happier-daemon-token'] ?? '')).toBe('test-token');
        expect(await waitForProcessExit(sleepy.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(existsSync(statePath)).toBe(true);
      } finally {
        fetchSpy.mockRestore();
        await sleepy.kill();
      }
    });
  });

  it('falls back to default timeout when HAPPIER_DAEMON_HTTP_TIMEOUT is invalid', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-multi-daemon-invalid-timeout-',
        env: {
          HAPPIER_DAEMON_HTTP_TIMEOUT: 'not-a-number',
        },
      },
      async ({ homeDir }) => {
        await writeDaemonSettingsFixture(homeDir);

        const port = await reserveEphemeralPort();
        const sleepy = spawnSleepyDetachedProcess();
        const statePath = await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: port,
        });

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          try {
            process.kill(sleepy.pid, 'SIGTERM');
          } catch {
            // already exited
          }
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        });

        try {
          await stopAllDaemonsBestEffort();

            expect(await waitForProcessExit(sleepy.pid, { timeoutMs: 3_000 })).toBe(true);
          expect(existsSync(statePath)).toBe(true);
        } finally {
          fetchSpy.mockRestore();
          await sleepy.kill();
        }
      },
    );
  }, 15_000);
});
