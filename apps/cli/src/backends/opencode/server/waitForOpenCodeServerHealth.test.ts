import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';

type StartedServer = Readonly<{
  baseUrl: string;
  close: () => Promise<void>;
}>;

async function startHealthServer(handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>): Promise<StartedServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected AddressInfo from test HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${(address satisfies AddressInfo).port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe('waitForOpenCodeServerHealth', () => {
  const servers = new Set<StartedServer>();

  afterEach(async () => {
    for (const server of servers) {
      await server.close().catch(() => {});
    }
    servers.clear();
  });

  it('succeeds when the health endpoint requires basic auth headers', async () => {
    const expectedAuth = `Basic ${Buffer.from('tester:top-secret', 'utf8').toString('base64')}`;
    const server = await startHealthServer((req, res) => {
      if (req.url !== '/global/health') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: 'fake' }));
    });
    servers.add(server);

    await expect(
      waitForOpenCodeServerHealth({
        baseUrl: server.baseUrl,
        timeoutMs: 2_000,
        pollIntervalMs: 25,
        headers: {
          Authorization: expectedAuth,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('falls back to V1 when the V2 health request stalls', async () => {
    const paths: string[] = [];
    const server = await startHealthServer((req, res) => {
      paths.push(req.url ?? '');
      if (req.url === '/api/health') return;
      if (req.url === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: 'fake' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.add(server);

    await expect(waitForOpenCodeServerHealth({
      baseUrl: server.baseUrl,
      timeoutMs: 1_000,
      pollIntervalMs: 25,
    })).resolves.toBeUndefined();
    expect(paths).toContain('/global/health');
  });

  it('accepts the authenticated OpenCode V2 health contract', async () => {
    const expectedAuth = `Basic ${Buffer.from('tester:top-secret', 'utf8').toString('base64')}`;
    const paths: string[] = [];
    const server = await startHealthServer((req, res) => {
      paths.push(req.url ?? '');
      if (req.url !== '/api/health' || req.headers.authorization !== expectedAuth) {
        res.writeHead(req.headers.authorization === expectedAuth ? 404 : 401);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true }));
    });
    servers.add(server);

    await expect(waitForOpenCodeServerHealth({
      baseUrl: server.baseUrl,
      timeoutMs: 2_000,
      pollIntervalMs: 25,
      headers: { Authorization: expectedAuth },
    })).resolves.toBeUndefined();
    expect(paths).toContain('/api/health');
  });

  it('accepts released V2 readiness through authenticated /api/info when /api/health is absent', async () => {
    const expectedAuth = `Basic ${Buffer.from('opencode:secret').toString('base64')}`;
    const paths: string[] = [];
    const server = await startHealthServer((req, res) => {
      paths.push(req.url ?? '');
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url !== '/api/info') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '2.0.15', pid: 123, urls: [], paths: {} }));
    });
    servers.add(server);

    await expect(waitForOpenCodeServerHealth({
      baseUrl: server.baseUrl,
      timeoutMs: 1_000,
      pollIntervalMs: 25,
      apiGeneration: 'v2',
      headers: { Authorization: expectedAuth },
    })).resolves.toBeUndefined();
    expect(paths).toContain('/api/info');
  });

  it('uses the V2 credential and records the detected generation when auto probes a released V2 server', async () => {
    const legacyAuth = `Basic ${Buffer.from('legacy-proxy-user:secret').toString('base64')}`;
    const v2Auth = `Basic ${Buffer.from('opencode:secret').toString('base64')}`;
    const detected: Array<'auto' | 'v2'> = [];
    const server = await startHealthServer((req, res) => {
      if (req.url !== '/api/info' || req.headers.authorization !== v2Auth) {
        res.writeHead(req.headers.authorization === legacyAuth ? 401 : 404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '2.0.15', pid: 123, urls: [], paths: {} }));
    });
    servers.add(server);

    await expect(waitForOpenCodeServerHealth({
      baseUrl: server.baseUrl,
      timeoutMs: 1_000,
      pollIntervalMs: 25,
      apiGeneration: 'auto',
      headers: { Authorization: legacyAuth },
      v2Headers: { Authorization: v2Auth },
      onReady: (apiGeneration) => detected.push(apiGeneration),
    })).resolves.toBeUndefined();
    expect(detected).toEqual(['v2']);
  });

  it.each([
    ['auto', '/global/health', 'auto'],
    ['v2', '/api/health', 'v2'],
  ] as const)('detects %s readiness on a server with both health surfaces', async (apiGeneration, expectedPath, expectedGeneration) => {
    const paths: string[] = [];
    const detected: Array<'auto' | 'v2'> = [];
    const server = await startHealthServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/global/health'
        ? { healthy: true, version: '1.18.35' }
        : { healthy: true }));
    });
    servers.add(server);

    await expect(waitForOpenCodeServerHealth({
      baseUrl: server.baseUrl,
      timeoutMs: 1_000,
      pollIntervalMs: 25,
      apiGeneration,
      onReady: (generation) => detected.push(generation),
    })).resolves.toBeUndefined();
    expect(detected).toEqual([expectedGeneration]);
    expect(paths[0]).toBe(expectedPath);
  });
});
