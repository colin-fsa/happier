import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import type { Credentials } from '@/persistence';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';

import { probeAcpCatalogs } from './probeAcpCatalogs';
import { createConfiguredAcpProbeBackend } from './createConfiguredAcpProbeBackend';
import { cursorPreflightSessionControlsProbeAdapter } from '@/backends/cursor/preflight/cursorPreflightSessionControlsProbeAdapter';

const sdkUrl = pathToFileURL(createRequire(import.meta.url).resolve('@agentclientprotocol/sdk')).href;
const commands = [{ name: 'review', description: 'Review the project', input: { hint: 'target' } }];
const credentials: Credentials = {
  token: 'fixture',
  encryption: { type: 'dataKey', publicKey: new Uint8Array(32), machineKey: new Uint8Array(32) },
};

function createProbeFixture(dir: string, scenario: 'before' | 'after' | 'empty' | 'absent' | 'exit') {
  const evidencePath = join(dir, 'requests.jsonl');
  const scriptPath = writeAcpTestAgentScript({
    dir,
    fileName: 'commands-agent.mjs',
    source: `
      import { appendFileSync } from 'node:fs';
      import { Readable, Writable } from 'node:stream';
      import * as acp from ${JSON.stringify(sdkUrl)};
      const evidencePath = ${JSON.stringify(evidencePath)};
      const scenario = ${JSON.stringify(scenario)};
      const record = (method, params) => appendFileSync(evidencePath, JSON.stringify({ method, params }) + '\\n');
      record('spawn', { pid: process.pid });
      let client;
      const publish = () => client.notify('session/update', {
        sessionId: 'commands-session',
        update: { sessionUpdate: 'available_commands_update', availableCommands: scenario === 'empty' ? [] : ${JSON.stringify(commands)} },
      });
      const app = acp.agent({ name: 'commands-fixture' })
        .onConnect((context) => { client = context.client; })
        .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] }))
        .onRequest('authenticate', ({ params }) => { record('authenticate', params); return {}; })
        .onRequest('session/new', async ({ params }) => {
          record('session/new', params);
          const permission = await client.request('session/request_permission', {
            sessionId: 'commands-session',
            toolCall: { toolCallId: 'fixture-permission', title: 'Permission requested during setup' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          });
          record('permission-outcome', permission);
          if (scenario === 'before' || scenario === 'empty') await publish();
          if (scenario === 'after') setTimeout(() => void publish(), 350);
          if (scenario === 'exit') setTimeout(() => process.exit(7), 25);
          return { sessionId: 'commands-session' };
        })
        .onRequest('session/prompt', ({ params }) => { record('session/prompt', params); return { stopReason: 'end_turn' }; })
        .onRequest('session/close', ({ params }) => { record('session/close', params); return {}; })
        .onNotification('session/cancel', ({ params }) => { record('session/cancel', params); });
      const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
      await connection.closed;
    `,
  });
  return {
    evidencePath,
    params: {
      agentId: 'customAcp' as const,
      backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'fixture' },
      cwd: dir,
      timeoutMs: 60_000,
      credentials,
      accountSettings: {
        acpCatalogSettingsV1: {
          v: 2,
          backends: [{
            id: 'fixture', name: 'fixture', title: 'Fixture', command: process.execPath,
            args: [scriptPath], env: {}, transportProfile: 'generic', capabilities: {}, createdAt: 1, updatedAt: 1,
          }],
        },
      },
    },
  };
}

describe('probeAcpCatalogs with a real ACP SDK subprocess', () => {
  it('settles both concurrent backend disposals only after its native process closes', async () => {
    await withTempDir('acp-concurrent-dispose-', async (dir) => {
      const fixture = createProbeFixture(dir, 'before');
      const backend = await createConfiguredAcpProbeBackend(fixture.params);
      expect(backend).not.toBeNull();
      await backend!.startSession();
      const events = readFileSync(fixture.evidencePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: { pid?: number } });
      const pid = events.find((event) => event.method === 'spawn')!.params.pid!;
      const first = backend!.dispose();
      try {
        await backend!.dispose();
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await first;
      }
    });
  });

  it('cancels an unsettled command observation and closes the ephemeral session', async () => {
    await withTempDir('acp-catalog-cancel-', async (dir) => {
      const fixture = createProbeFixture(dir, 'absent');
      const controller = new AbortController();
      // Observe the real startup promise: the agent's request log precedes the host learning its session id.
      const sessionStart = vi.spyOn(AcpBackend.prototype, 'startSession');
      const pending = probeAcpCatalogs({ ...fixture.params, signal: controller.signal });
      const rejection = expect(pending).rejects.toThrow(/abort|cancel/i);
      try {
        await vi.waitFor(() => expect(sessionStart.mock.results[0]?.type).toBe('return'));
        const startup = sessionStart.mock.results[0];
        if (startup.type !== 'return') throw new Error('ACP session startup did not return a promise');
        await startup.value;
        controller.abort();
        await rejection;
        expect(readFileSync(fixture.evidencePath, 'utf8')).toContain('session/close');
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        sessionStart.mockRestore();
      }
    });
  }, 90_000);

  it('uses the configured Cursor executable for native command discovery', async () => {
    await withTempDir('cursor-catalog-probe-', async (dir) => {
      const fixture = createProbeFixture(dir, 'before');
      const executable = await writeExecutableShim({
        dir, fileName: 'cursor-fixture.mjs',
        contents: '#!/usr/bin/env node\n' + readFileSync(fixture.params.accountSettings.acpCatalogSettingsV1.backends[0].args[0], 'utf8'),
      });
      const result = await cursorPreflightSessionControlsProbeAdapter.probeCatalogsRaw?.({
        cwd: dir, timeoutMs: 60_000,
        accountSettings: { cursorBinaryPath: executable },
        processEnv: { ...process.env, HAPPIER_CURSOR_PATH: join(dir, 'ambient-missing-cursor') },
      });
      expect(result).toEqual({ commands, skills: null });
    });
  });

  it.each(['before', 'after'] as const)('observes commands emitted %s session/new completes and closes without prompting', async (scenario) => {
    await withTempDir('acp-catalog-probe-', async (dir) => {
      const fixture = createProbeFixture(dir, scenario);
      await expect(probeAcpCatalogs(fixture.params)).resolves.toEqual({ commands, skills: null });
      const evidence = readFileSync(fixture.evidencePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: unknown });
      expect(evidence.find((event) => event.method === 'permission-outcome')?.params).toEqual({ outcome: { outcome: 'cancelled' } });
      expect(evidence.find((event) => event.method === 'session/close')?.params).toEqual({ sessionId: 'commands-session' });
      expect(evidence.some((event) => event.method === 'session/prompt')).toBe(false);
    });
  });

  it('preserves an observed empty command snapshot without claiming a skills channel', async () => {
    await withTempDir('acp-catalog-empty-', async (dir) => {
      const fixture = createProbeFixture(dir, 'empty');
      await expect(probeAcpCatalogs(fixture.params)).resolves.toEqual({ commands: [], skills: null });
    });
  });

  it('reports an absent update as unavailable at the enclosing deadline and closes the session', async () => {
    await withTempDir('acp-catalog-absent-', async (dir) => {
      const fixture = createProbeFixture(dir, 'absent');
      await expect(probeAcpCatalogs({ ...fixture.params, timeoutMs: 10_000 })).rejects.toThrow(/timeout|timed out/i);
      expect(readFileSync(fixture.evidencePath, 'utf8')).toContain('session/close');
    });
  });

  it('reports transport failure instead of an empty successful catalog', async () => {
    await withTempDir('acp-catalog-exit-', async (dir) => {
      const fixture = createProbeFixture(dir, 'exit');
      await expect(probeAcpCatalogs(fixture.params)).rejects.toThrow('Exit code: 7');
    });
  });
});
