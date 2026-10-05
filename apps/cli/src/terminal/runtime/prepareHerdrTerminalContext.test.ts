import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { createTerminalAttachmentId, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalAttachmentMetadataFromHostHandle } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { prepareHerdrTerminalContext } from './prepareHerdrTerminalContext';

afterEach(() => vi.unstubAllEnvs());

// The executable shebang substitutes only the external Herdr executable. Socket
// protocol, attachment parsing and endpoint admission are real; no provider runs.
describe.skipIf(process.platform === 'win32')('prepareHerdrTerminalContext', () => {
  it.each(['fresh', 'retained', 'unreadable', 'unsupported'] as const)(
    'admits the launch context without replacing retained authority (%s)', async contract => {
      await withConfiguredDaemonTestHome({ prefix: 'herdr-context-' }, async ({ homeDir }) => {
        await withHerdrApi(async selected => await withHerdrApi(async ambient => {
          const inventoryRead = join(homeDir, 'inventory-read');
          const binary = await writeExecutableShim({ dir: homeDir, fileName: 'herdr', contents:
            `#!${process.execPath}\nconst args = process.argv.slice(2).join(' ');\nif(args === '--version') console.log('herdr 0.9.3');\nelse if(args === 'session list --json') { require('node:fs').writeFileSync(${JSON.stringify(inventoryRead)}, 'read'); console.log(${JSON.stringify(JSON.stringify({ sessions: [{ name: 'ambient', socket_path: ambient.socketPath, running: true }] }))}); }\nelse process.exit(1);\n`,
          });
          vi.stubEnv('HERDR_BIN_PATH', binary);
          if (contract === 'unreadable') {
            const directory = join(homeDir, 'terminal', 'sessions');
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'same-session.json'), '{malformed');
          } else if (contract !== 'fresh') {
            const handle: TerminalHostHandle = {
              kind: 'herdr', sessionName: 'selected', socketPath: selected.socketPath,
              paneId: 'managed', terminalId: 'terminal_1', attachmentId: createTerminalAttachmentId(),
              attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared',
                locality: 'same_machine', maxClients: null, requiresLocalAttachmentInfo: true, liveProbe: 'required' },
            };
            const terminal = buildTerminalAttachmentMetadataFromHostHandle(handle);
            if (!terminal) throw new Error('Missing exact fixture terminal');
            await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'same-session',
              attachmentId: handle.attachmentId, handle, terminal });
          }
          const preparing = prepareHerdrTerminalContext({ sessionName: 'ambient',
            ...(contract !== 'fresh' ? { existingSessionId: 'same-session' } : {}) });
          if (contract === 'fresh') {
            await expect(preparing).resolves.toEqual({ herdrSessionName: 'ambient', herdrSocketPath: ambient.socketPath });
            expect(ambient.requests.map(request => request.method)).toEqual(['session.snapshot']);
            expect(selected.requests).toEqual([]);
          } else {
            if (contract === 'retained') await expect(preparing).resolves.toEqual({
              herdrSessionName: 'selected', herdrSocketPath: selected.socketPath,
            });
            else await expect(preparing).rejects.toMatchObject({ code: 'terminal_host_startup_failed',
              reason: contract === 'unreadable' ? 'recovery_probe_inconclusive' : 'server_version_unsupported' });
            expect(ambient.requests).toEqual([]);
            await expect(access(inventoryRead)).rejects.toMatchObject({ code: 'ENOENT' });
          }
        }), { serverVersion: contract === 'unsupported' ? '0.9.1' : '0.9.3' });
      });
    },
  );
});
