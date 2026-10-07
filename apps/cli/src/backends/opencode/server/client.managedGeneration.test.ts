import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';

type StartedServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

async function startServer(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>): Promise<StartedServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    baseUrl: `http://127.0.0.1:${(address satisfies AddressInfo).port}`,
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

describe('createOpenCodeServerRuntimeClient managed generation authority', () => {
  const servers = new Set<StartedServer>();
  const tempDirs = new Set<string>();
  let envScope = createEnvKeyScope([
    'HAPPIER_OPENCODE_SERVER_STATE_PATH',
    'HAPPIER_OPENCODE_CLI_GENERATION',
    'HAPPIER_OPENCODE_SERVER_URL',
    'OPENCODE_PASSWORD',
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_SERVER_USERNAME',
  ] as const);

  afterEach(async () => {
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_OPENCODE_SERVER_STATE_PATH',
      'HAPPIER_OPENCODE_CLI_GENERATION',
      'HAPPIER_OPENCODE_SERVER_URL',
      'OPENCODE_PASSWORD',
      'OPENCODE_SERVER_PASSWORD',
      'OPENCODE_SERVER_USERNAME',
    ] as const);
    for (const server of servers) await server.close().catch(() => {});
    servers.clear();
    for (const dir of tempDirs) removeTempDirSync(dir);
    tempDirs.clear();
  });

  it.each([
    ['auto', 'v1', '/api/health', '/session'],
    ['auto', 'v2', '/api/health', '/api/session'],
    ['v2', 'v2', '/api/health', '/api/session'],
  ] as const)('uses the canonical health probe for managed %s identity backed by a %s server', async (
    apiGeneration,
    serverGeneration,
    firstHealthPath,
    expectedSessionPath,
  ) => {
    const paths: string[] = [];
    const server = await startServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      paths.push(path);
      const body = path === '/global/health' && serverGeneration === 'v1'
        ? { healthy: true, version: '1.18.25' }
        : path === '/api/health' && serverGeneration === 'v2'
          ? { healthy: true }
          : path === '/api/session'
            ? { data: [] }
            : path === '/session'
              ? []
              : { error: 'not found' };
      const available = (path === '/global/health' && serverGeneration === 'v1')
        || (path === '/api/health' && serverGeneration === 'v2')
        || path === '/session'
        || path === '/api/session';
      res.writeHead(available ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(body));
    });
    servers.add(server);

    const dir = createTempDirSync('happier-opencode-generation-');
    tempDirs.add(dir);
    const statePath = join(dir, 'managed-server.json');
    envScope.patch({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: statePath,
      HAPPIER_OPENCODE_CLI_GENERATION: apiGeneration === 'auto' ? 'stable' : 'v2',
      HAPPIER_OPENCODE_SERVER_URL: undefined,
    });
    writeFileSync(statePath, JSON.stringify({
      baseUrl: server.baseUrl,
      pid: process.pid,
      startedAtMs: Date.now(),
      status: 'ready',
      launchEnvFingerprint: resolveOpenCodeManagedServerLaunchFingerprint({
        baseEnv: process.env,
        xdgRootDir: null,
        isolateConfig: false,
      }),
      apiGeneration,
    }));

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
    });
    await expect(client.sessionList()).resolves.toEqual([]);
    await client.dispose();

    expect(paths[0]).toBe(firstHealthPath);
    expect(paths).toContain(expectedSessionPath);
    expect(paths).not.toContain(serverGeneration === 'v1' ? '/api/session' : '/session');
  });

  it('applies the retained managed-server credential before the first V2 session request', async () => {
    const password = 'retained-managed-secret';
    const expectedAuthorization = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
    const authorizations: Array<string | undefined> = [];
    const server = await startServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      authorizations.push(req.headers.authorization);
      const authorized = req.headers.authorization === expectedAuthorization;
      const body = path === '/api/health'
        ? { healthy: true }
        : path === '/api/session'
          ? { data: [] }
          : { error: 'not found' };
      const available = path === '/api/health' || path === '/api/session';
      // The shared managed-server owner authenticates its own reuse/readiness probe. This test
      // isolates the subsequently constructed client's first session request, so health remains a
      // permissive boundary fixture while the session route requires the retained credential.
      const requiresAuth = path === '/api/session';
      res.writeHead(requiresAuth && !authorized ? 401 : available ? 200 : 404, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify(requiresAuth && !authorized ? { error: 'unauthorized' } : body));
    });
    servers.add(server);

    const dir = createTempDirSync('happier-opencode-managed-auth-client-');
    tempDirs.add(dir);
    const statePath = join(dir, 'managed-server.json');
    envScope.patch({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: statePath,
      HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      HAPPIER_OPENCODE_SERVER_URL: undefined,
      OPENCODE_PASSWORD: undefined,
      OPENCODE_SERVER_PASSWORD: undefined,
      OPENCODE_SERVER_USERNAME: undefined,
    });
    writeFileSync(statePath, JSON.stringify({
      baseUrl: server.baseUrl,
      pid: process.pid,
      startedAtMs: Date.now(),
      status: 'ready',
      launchEnvFingerprint: resolveOpenCodeManagedServerLaunchFingerprint({
        baseEnv: process.env,
        xdgRootDir: null,
        isolateConfig: false,
      }),
      apiGeneration: 'v2',
      authPassword: password,
    }));

    const client = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
    });
    await expect(client.sessionList()).resolves.toEqual([]);
    await client.dispose();

    expect(authorizations.at(-1)).toBe(expectedAuthorization);
  });

  it('keeps an activated catalog read on its endpoint and credential during managed replacement', async () => {
    const authorization = (password: string) => `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
    const originalSkills = [{ id: 'original-skill', name: 'original' }];
    const replacementSkills = [{ id: 'replacement-skill', name: 'replacement' }];
    let releaseActivation = () => {};
    const activationHeld = new Promise<void>((resolve) => { releaseActivation = resolve; });
    let activationEntered = () => {};
    const activationStarted = new Promise<void>((resolve) => { activationEntered = resolve; });
    let replacementActivated = false;
    let replacementMessageReads = 0;
    const originalCatalogAuthorizations: Array<string | undefined> = [];
    const replacementCatalogAuthorizations: Array<string | undefined> = [];
    const json = (res: ServerResponse, body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const original = await startServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/api/health') return json(res, { healthy: true });
      if (path === '/api/info') return json(res, { version: '2.0.20', pid: process.pid });
      if (path === '/api/session/fixture/message') {
        // A genuine transport failure makes the existing safe-read retry owner refresh state.
        req.socket.destroy();
        return;
      }
      if (path === '/api/integration') {
        activationEntered();
        void activationHeld.then(() => json(res, { data: [] }));
        return;
      }
      if (path === '/api/skill') {
        originalCatalogAuthorizations.push(req.headers.authorization);
        return json(res, { data: originalSkills }, req.headers.authorization === authorization('original-secret') ? 200 : 401);
      }
      return json(res, { error: 'not found' }, 404);
    });
    servers.add(original);
    const replacement = await startServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/api/health') return json(res, { healthy: true });
      if (path === '/api/info') return json(res, { version: '2.0.20', pid: process.pid });
      if (path === '/api/session/fixture/message') {
        replacementMessageReads += 1;
        return json(res, { data: [] });
      }
      if (path === '/api/integration') {
        replacementActivated = true;
        return json(res, { data: [] });
      }
      if (path === '/api/skill') {
        replacementCatalogAuthorizations.push(req.headers.authorization);
        return json(res, { data: replacementActivated ? replacementSkills : [] },
          req.headers.authorization === authorization('replacement-secret') ? 200 : 401);
      }
      return json(res, { error: 'not found' }, 404);
    });
    servers.add(replacement);
    const dir = createTempDirSync('happier-opencode-catalog-replacement-');
    tempDirs.add(dir);
    const statePath = join(dir, 'managed-server.json');
    envScope.patch({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: statePath,
      HAPPIER_OPENCODE_CLI_GENERATION: 'v2',
      HAPPIER_OPENCODE_SERVER_URL: undefined,
      OPENCODE_PASSWORD: undefined,
      OPENCODE_SERVER_PASSWORD: undefined,
      OPENCODE_SERVER_USERNAME: undefined,
    });
    const writeState = (server: StartedServer, password: string) => writeFileSync(statePath, JSON.stringify({
      baseUrl: server.baseUrl, pid: process.pid, startedAtMs: Date.now(), status: 'ready',
      launchEnvFingerprint: resolveOpenCodeManagedServerLaunchFingerprint({
        baseEnv: process.env, xdgRootDir: null, isolateConfig: false,
      }),
      apiGeneration: 'v2', authPassword: password,
    }));
    writeState(original, 'original-secret');
    const client = await createOpenCodeServerRuntimeClient({ directory: '/repo', messageBuffer: new MessageBuffer() });
    const catalog = client.appSkills();
    try {
      await activationStarted;
      writeState(replacement, 'replacement-secret');
      await expect(client.sessionMessagesList({ sessionId: 'fixture' })).resolves.toEqual([]);
      expect(replacementMessageReads).toBe(1);
      releaseActivation();
      expect(await catalog).toEqual(originalSkills);
      expect(originalCatalogAuthorizations).toEqual([authorization('original-secret')]);
      expect(replacementCatalogAuthorizations).toEqual([]);
      expect(await client.appSkills()).toEqual(replacementSkills);
      expect(replacementCatalogAuthorizations).toEqual([authorization('replacement-secret')]);
    } finally {
      releaseActivation();
      await Promise.allSettled([catalog, client.dispose()]);
    }
  }, 30_000);
});
