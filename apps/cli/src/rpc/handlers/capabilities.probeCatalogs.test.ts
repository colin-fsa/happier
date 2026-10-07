import { describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerCapabilitiesHandlers } from './capabilities';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';

describe('capabilities.invoke pre-session catalogs', () => {
  it.each([false, true])('cancels a native catalog waiter and preserves a shared healthy waiter: %s', async (shared) => {
    await withTempDir('catalog-cancellation-', async (cwd) => {
      const credentialKeys = ['privateKeyFile', 'legacyPrivateKeyFile'] as const;
      const credentialDescriptors = credentialKeys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
      credentialKeys.forEach((key) => Object.defineProperty(configuration, key, { value: join(cwd, key), configurable: true }));
      const controller = new AbortController();
      const startupPath = join(cwd, 'native-startups');
      const { manager } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-cancellation', registerHandlers: registerCapabilitiesHandlers });
      const request = {
        id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer',
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
            HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            HAPPIER_TEST_CATALOG_DELAY_MS: '1000',
            HAPPIER_TEST_CATALOG_SHUTDOWN_DELAY_MS: '250',
          },
        },
      };
      let pending: Promise<unknown> | undefined;
      let other: Promise<unknown> | undefined;
      try {
        pending = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request, { signal: controller.signal });
        if (shared) other = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request);
        await vi.waitFor(() => expect(existsSync(startupPath)).toBe(true));
        const startedPids = (await readFile(startupPath, 'utf8')).trim().split('\n').map(Number);
        controller.abort();
        // A new request arriving during the old launch's shutdown needs a fresh launch.
        if (!shared) other = manager.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, request);
        await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
        if (shared) expect(() => process.kill(startedPids[0], 0)).not.toThrow();
        else expect(() => process.kill(startedPids[0], 0)).toThrow();
        if (other) await expect(other).resolves.toMatchObject({ ok: true, result: { skills: { supported: true } } });
        const pids = (await readFile(startupPath, 'utf8')).trim().split('\n').map(Number);
        expect(pids).toHaveLength(shared ? 1 : 2);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        await Promise.allSettled([pending, other]);
        credentialKeys.forEach((key, index) => Object.defineProperty(configuration, key, credentialDescriptors[index]));
      }
    });
  }, 30_000);

  it('bounds account-settings preparation by the catalog request budget', async () => {
    await withTempDir('catalog-settings-budget-', async (cwd) => {
      const overrides = {
        happyHomeDir: cwd, activeServerDir: cwd,
        privateKeyFile: join(cwd, 'access.key'), legacyPrivateKeyFile: join(cwd, 'legacy.key'),
        apiServerUrl: 'http://catalog-settings-boundary.test',
        clientEncryptionRequirement: 'follow_account',
      };
      const descriptors = Object.fromEntries(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(configuration, key)!]));
      Object.defineProperties(configuration, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, configurable: true }])));
      await writeFile(configuration.privateKeyFile, JSON.stringify({ token: 'catalog-fixture', secret: Buffer.alloc(32, 7).toString('base64') }));
      resetInMemoryAccountSettingsContextForTests();
      const originalAdapter = axios.defaults.adapter;
      const startupPath = join(cwd, 'native-startups');
      const cacheLockPath = `${resolveAccountSettingsCachePath({ token: 'catalog-fixture' })}.lock`;
      let settingsWriteCompleted!: () => void;
      const settingsWrite = new Promise<void>((resolve) => { settingsWriteCompleted = resolve; });
      const originalUnlink = fsPromises.unlink;
      // The cache lock's release is the final asynchronous preparation effect.
      // Wait for real filesystem completion before checking for a late native launch.
      const unlink = vi.spyOn(fsPromises, 'unlink').mockImplementation(async (path) => {
        await originalUnlink(path);
        if (path === cacheLockPath) settingsWriteCompleted();
      });
      syncBuiltinESMExports();
      let releaseHttp!: () => void;
      const httpHeld = new Promise<void>((resolve) => { releaseHttp = resolve; });
      let httpEntered = false;
      // Hold only the real HTTP adapter; settings/cache/profile/RPC owners remain real.
      const adapter: AxiosAdapter = async (config) => {
        if (config.url !== 'http://catalog-settings-boundary.test/v2/account/settings') throw new Error('Unexpected fixture HTTP request');
        httpEntered = true;
        await httpHeld;
        return { config, status: 200, statusText: 'OK', headers: {}, data: {
          content: { t: 'plain', v: { schemaVersion: 6, codexBackendMode: 'appServer' } }, version: 1,
        } };
      };
      axios.defaults.adapter = adapter;
      const { call } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-settings-budget', registerHandlers: registerCapabilitiesHandlers });
      let response: unknown;
      let pending: Promise<unknown> | undefined;
      try {
        await call(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
        const request = {
          id: 'cli.codex', method: 'probeCatalogs', params: {
            cwd, timeoutMs: 500, runtimeKindOverride: 'appServer',
            environmentVariables: {
              HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
              HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            },
          },
        };
        pending = call(RPC_METHODS.CAPABILITIES_INVOKE, request).then((value) => { response = value; return value; });
        await vi.waitFor(() => expect(httpEntered).toBe(true));
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
        expect(response).toMatchObject({ ok: false, error: { code: 'preflight-catalog-unavailable' } });
        releaseHttp();
        await pending;
        await settingsWrite;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(existsSync(startupPath)).toBe(false);
        await expect(call(RPC_METHODS.CAPABILITIES_INVOKE, request)).resolves.toMatchObject({ ok: true });
        expect((await readFile(startupPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      } finally {
        releaseHttp();
        await pending;
        if (httpEntered) await settingsWrite;
        axios.defaults.adapter = originalAdapter;
        unlink.mockRestore();
        syncBuiltinESMExports();
        resetInMemoryAccountSettingsContextForTests();
        Object.defineProperties(configuration, descriptors);
      }
    });
  }, 30_000);

  it('rejects a malformed selected-account scope before launching with ambient authentication', async () => {
    await withTempDir('catalog-invalid-account-', async (cwd) => {
      const credentialKeys = ['privateKeyFile', 'legacyPrivateKeyFile'] as const;
      const credentialDescriptors = credentialKeys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
      credentialKeys.forEach((key) => Object.defineProperty(configuration, key, { value: join(cwd, key), configurable: true }));
      try {
        const startupPath = join(cwd, 'native-startups');
        const { call } = createEncryptedRpcTestClient({ scopePrefix: 'catalog-invalid-account', registerHandlers: registerCapabilitiesHandlers });
        const result = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: 'cli.codex', method: 'probeCatalogs', params: {
            cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer',
            connectedServices: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile' } } },
            environmentVariables: {
              HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
              HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            },
          },
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
        expect(existsSync(startupPath)).toBe(false);
      } finally {
        credentialKeys.forEach((key, index) => Object.defineProperty(configuration, key, credentialDescriptors[index]));
      }
    });
  }, 30_000);

  it('does not probe Gemini with ambient auth when its selected connected account is unavailable', async () => {
    await withTempDir('gemini-preflight-catalogs-', async (cwd) => {
      const { call } = createEncryptedRpcTestClient({ scopePrefix: 'gemini-catalog-test', registerHandlers: registerCapabilitiesHandlers });
      const response = await call(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'cli.gemini', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000,
          environmentVariables: { HAPPIER_GEMINI_PATH: join(cwd, 'missing-native-cli') },
          connectedServices: { v: 1, bindingsByServiceId: {
            'gemini': { source: 'connected', selection: 'group', groupId: 'fixture', profileId: 'fixture' },
          } },
        },
      });
      expect(response).toMatchObject({ ok: false, error: { code: 'connected-service-preflight-failed' } });
    });
  }, 180_000);

  it('discovers cwd-scoped Codex skills without creating a provider thread or Happier session', async () => {
    await withTempDir('preflight-catalogs-', async (cwd) => {
      const { call } = createEncryptedRpcTestClient({
        scopePrefix: 'machine-catalog-test',
        encryptionKey: new Uint8Array(32).fill(7),
        logger: () => undefined,
        registerHandlers: registerCapabilitiesHandlers,
      });
      const startupPath = join(cwd, 'native-startups');
      const environmentPath = join(cwd, 'native-environment.json');
      const request = {
        id: 'cli.codex', method: 'probeCatalogs', params: {
          cwd, timeoutMs: 5_000, runtimeKindOverride: 'appServer', profileId: 'gui-materialized-fixture',
          environmentVariables: {
            HAPPIER_CODEX_APP_SERVER_BIN: fileURLToPath(new URL('../../backends/codex/preflight/__fixtures__/fakeCodexAppServer.mjs', import.meta.url)),
            HAPPIER_TEST_CATALOG_START_FILE: startupPath,
            HAPPIER_TEST_CATALOG_ENV_FILE: environmentPath,
            HAPPIER_HOME_DIR: join(cwd, 'caller-controlled-daemon-home'),
          },
        },
      };
      const results = await Promise.all(Array.from({ length: 3 }, () => call(RPC_METHODS.CAPABILITIES_INVOKE, request)));
      const result = results[0];
      expect(result).toMatchObject({ ok: true, result: {
        commands: { supported: false, items: [] },
        skills: { supported: true, items: [{ name: 'review', path: `${cwd}/SKILL.md` }] },
      } });
      expect(results[1]).toEqual(result);
      expect(results[2]).toEqual(result);
      expect((await readFile(startupPath, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(await readFile(environmentPath, 'utf8'))).toMatchObject({ HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR });
      const fresh = await call(RPC_METHODS.CAPABILITIES_INVOKE, request);
      expect(fresh).toEqual(result);
      expect((await readFile(startupPath, 'utf8')).trim().split('\n')).toHaveLength(2);
    });
  }, 180_000);
});
