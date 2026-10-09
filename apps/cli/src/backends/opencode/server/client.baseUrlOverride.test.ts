import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntimeClient } from './client';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenCodeServerRuntimeClient (baseUrlOverride)', () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.HAPPIER_OPENCODE_SERVER_URL;
  const originalCanonicalPassword = process.env.OPENCODE_PASSWORD;
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const originalUsername = process.env.OPENCODE_SERVER_USERNAME;
  const originalStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
  const tempDirs = new Set<string>();

  beforeEach(() => {
    process.env.HAPPIER_OPENCODE_SERVER_URL = 'http://env.test';
    delete process.env.OPENCODE_PASSWORD;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalUrl === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_URL = originalUrl;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_URL;
    }
    if (typeof originalPassword === 'string') {
      process.env.OPENCODE_SERVER_PASSWORD = originalPassword;
    } else {
      delete process.env.OPENCODE_SERVER_PASSWORD;
    }
    if (typeof originalCanonicalPassword === 'string') {
      process.env.OPENCODE_PASSWORD = originalCanonicalPassword;
    } else {
      delete process.env.OPENCODE_PASSWORD;
    }
    if (typeof originalUsername === 'string') {
      process.env.OPENCODE_SERVER_USERNAME = originalUsername;
    } else {
      delete process.env.OPENCODE_SERVER_USERNAME;
    }
    if (typeof originalStatePath === 'string') {
      process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = originalStatePath;
    } else {
      delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
    }
    for (const dir of tempDirs) removeTempDirSync(dir);
    tempDirs.clear();
  });

  it('uses baseUrlOverride instead of env url', async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? '');
      urls.push(url);
      return jsonResponse({ healthy: true, version: '1.2.15' });
    }) as any;

    await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
      baseUrlOverride: 'http://override.test',
    });

    expect(urls[0]).toContain('http://override.test');
    expect(urls[0]).toContain('/global/health');
  });

  it('still sends configured auth headers to explicit baseUrlOverride requests', async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    process.env.OPENCODE_SERVER_USERNAME = 'tester';
    process.env.OPENCODE_SERVER_PASSWORD = 'top-secret';

    globalThis.fetch = vi.fn(async (_input, init) => {
      headers.push((init?.headers as Record<string, string> | undefined) ?? undefined);
      return jsonResponse({ healthy: true, version: '1.2.15' });
    }) as any;

    await createOpenCodeServerRuntimeClient({
      directory: '',
      messageBuffer: new MessageBuffer(),
      baseUrlOverride: 'http://override.test',
    });

    expect(headers[0]?.Authorization).toBe(`Basic ${Buffer.from('tester:top-secret', 'utf8').toString('base64')}`);
  });

  it('uses retained auth only for an exact matching managed loopback override', async () => {
    const dir = createTempDirSync('happier-opencode-client-override-auth-');
    tempDirs.add(dir);
    const statePath = join(dir, 'managed-server.json');
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = statePath;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_USERNAME;
    const managedBaseUrl = 'http://127.0.0.1:41234';
    const password = 'exact-managed-secret';
    writeFileSync(statePath, JSON.stringify({
      baseUrl: managedBaseUrl,
      pid: process.pid,
      startedAtMs: Date.now(),
      status: 'ready',
      apiGeneration: 'v2',
      authPassword: password,
    }));

    const requests: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      requests.push({ url, authorization: headers.Authorization });
      return jsonResponse(url.includes('/api/session') ? { data: [] } : { healthy: true });
    }) as any;

    const managedClient = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
      baseUrlOverride: `${managedBaseUrl}/`,
    });
    await expect(managedClient.sessionList()).resolves.toEqual([]);
    await managedClient.dispose();

    const externalClient = await createOpenCodeServerRuntimeClient({
      directory: '/repo',
      messageBuffer: new MessageBuffer(),
      baseUrlOverride: 'https://external.example.test',
    });
    await externalClient.dispose();

    const expected = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
    expect(requests.filter(({ url }) => url.startsWith(managedBaseUrl)).every(({ authorization }) => authorization === expected)).toBe(true);
    expect(requests.filter(({ url }) => url.startsWith('https://external.example.test')).every(({ authorization }) => authorization === undefined)).toBe(true);
  });
});
