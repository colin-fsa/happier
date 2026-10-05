import { expectTerminalNativeInvocation, terminalLauncherBoundary } from '@/testkit/process/terminalLauncher';
import { describe, expect, it, vi } from 'vitest';

import { runCodexProviderAttach } from './runCodexProviderAttach';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionProviderCliAttachPrepareRequestV1 } from '@happier-dev/protocol';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

describe('runCodexProviderAttach', () => {
  it('cleans its zero-turn native child when the older prepare receiver refuses terminal custody', async () => {
    await withTempDir('codex-old-controller-', async directory => {
      const marker = join(directory, 'native.json');
      let launcherPid: number | undefined;
      const result = await runCodexProviderAttach({ sessionId: 'happy-session-1',
        metadata: { path: directory, codexSessionId: 'thread-1', codexBackendMode: 'appServer' },
        command: process.execPath, commandArgs: ['-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000)`, '--'],
        readEndpointFn: async () => ({ version: 1, sessionId: 'happy-session-1', endpoint: 'unix:///private/codex.sock', updatedAt: 1 }),
        terminalClient: { sessionName: 'work', socketPath: '/private/herdr.sock', paneId: 'w1:p1', terminalId: 'restored-terminal' },
        // The genuine runner RPC boundary rejects the newly optional field. Its
        // pre-extension strict parser cannot authorize a terminal association.
        prepareProviderCliAttach: async request => {
          launcherPid = request.terminalClient?.launcher.pid;
          await vi.waitFor(async () => expect(JSON.parse(await readFile(marker, 'utf8')).parent).toBe(launcherPid));
          return { ok: false, errorCode: 'invalid_request' };
        },
      });
      expect(result).toBe(1);
      const native = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; parent: number };
      expect(native.parent).toBe(launcherPid);
      await vi.waitFor(() => {
        expect(() => process.kill(native.pid, 0)).toThrow();
        expect(() => process.kill(native.parent, 0)).toThrow();
      });
    });
  });
  it('reports the actual admitted native launcher and its completion to the existing prepare RPC', async () => {
    await withTempDir('codex-restored-client-', async directory => {
      const marker = join(directory, 'native.json');
      const observations: SessionProviderCliAttachPrepareRequestV1[] = [];
      const result = await runCodexProviderAttach({ sessionId: 'happy-session-1',
        metadata: { path: directory, codexSessionId: 'thread-1', codexBackendMode: 'appServer' },
        command: process.execPath, commandArgs: ['-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,parent:process.ppid}));setTimeout(()=>{},300)`, '--'],
        readEndpointFn: async () => ({ version: 1, sessionId: 'happy-session-1', endpoint: 'unix:///private/codex.sock', updatedAt: 1 }),
        terminalClient: { sessionName: 'work', socketPath: '/private/herdr.sock', paneId: 'w1:p1', terminalId: 'restored-terminal' },
        prepareProviderCliAttach: async request => {
          observations.push(request);
          if (request.terminalClient?.attached) {
            await vi.waitFor(async () => expect(JSON.parse(await readFile(marker, 'utf8')).parent).toBe(request.terminalClient?.launcher.pid));
            expect(request.terminalClient.launcher.processInstanceFingerprint).toBe(readProcessInstanceFingerprintSync(request.terminalClient.launcher.pid));
          }
          return { ok: true, providerSessionId: request.providerSessionId };
        },
      });
      expect(result).toBe(0);
      expect(observations.filter(request => request.terminalClient).map(request => ({ id: request.providerSessionId,
        attached: request.terminalClient!.attached }))).toEqual([
        { id: 'thread-1', attached: true }, { id: 'thread-1', attached: false },
      ]);
    });
  });
  it('launches the native Codex TUI against the runner-owned shared endpoint and thread', async () => {
    const spawnProcess = vi.fn(() => terminalLauncherBoundary({
      once: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'exit') setImmediate(() => handler(0, null));
      },
    }));

    await expect(runCodexProviderAttach({
      sessionId: 'happy-session-1',
      metadata: { path: '/tmp/repo', codexSessionId: 'thread-1', codexBackendMode: 'appServer' },
      happyHomeDir: '/tmp/happier-home',
      command: 'codex',
      commandArgs: [],
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      readEndpointFn: async () => ({
        version: 1,
        sessionId: 'happy-session-1',
        endpoint: 'unix:///tmp/happier-codex/private/app-server.sock',
        updatedAt: 1,
      }),
    })).resolves.toBe(0);

    await expectTerminalNativeInvocation(spawnProcess.mock.calls,
      'codex',
      ['--remote', 'unix:///tmp/happier-codex/private/app-server.sock', '--cd', '/tmp/repo', 'resume', 'thread-1'],
      expect.objectContaining({ stdio: 'inherit', shell: false }),
    );
  });

  it('fails closed when the local endpoint descriptor is absent', async () => {
    const spawnProcess = vi.fn();
    await expect(runCodexProviderAttach({
      sessionId: 'happy-session-1',
      metadata: { path: '/tmp/repo', codexSessionId: 'thread-1', codexBackendMode: 'appServer' },
      happyHomeDir: '/tmp/happier-home',
      spawnProcess: spawnProcess as unknown as typeof import('node:child_process').spawn,
      readEndpointFn: async () => null,
    })).resolves.toBe(1);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
