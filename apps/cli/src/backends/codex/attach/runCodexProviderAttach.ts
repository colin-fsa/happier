import { spawn } from 'node:child_process';

import {
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
} from '@happier-dev/agents';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { runOwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import type { ProviderAttachOps } from '@/backends/types';
import { logger } from '@/ui/logger';

import { configuration } from '@/configuration';
import type { CodexSharedControlEndpoint } from '../localControl/codexSharedControlEndpoint';
import { readCodexSharedControlEndpoint } from '../localControl/codexSharedControlEndpoint';
import { createCodexSharedAttachArgs } from '../localControl/createCodexSharedAttachArgs';
import { resolveCodexCliInvocation } from '../utils/resolveCodexCliInvocation';

export async function runCodexProviderAttach(params: Readonly<{
  sessionId: string;
  metadata: Record<string, unknown>;
  prepareProviderCliAttach?: Parameters<ProviderAttachOps['runAttach']>[0]['prepareProviderCliAttach'];
  terminalClient?: Parameters<ProviderAttachOps['runAttach']>[0]['terminalClient'];
  happyHomeDir?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  commandArgs?: readonly string[];
  spawnProcess?: typeof spawn;
  readEndpointFn?: (params: { happyHomeDir: string; sessionId: string }) => Promise<CodexSharedControlEndpoint | null>;
}>): Promise<number> {
  if (resolvePersistedCodexRuntimeIdentity(params.metadata)?.backendMode !== 'appServer') return 1;
  const directory = typeof params.metadata.path === 'string' ? params.metadata.path.trim() : '';
  const vendorSessionId = resolvePersistedCodexVendorSessionId(params.metadata);
  if (!directory || !vendorSessionId) return 1;

  const endpoint = await (params.readEndpointFn ?? readCodexSharedControlEndpoint)({
    happyHomeDir: params.happyHomeDir ?? configuration.happyHomeDir,
    sessionId: params.sessionId,
  });
  if (!endpoint) return 1;
  if (params.terminalClient && !params.prepareProviderCliAttach) return 1;

  const env = params.env ?? process.env;
  const resolved = params.command
    ? { command: params.command, args: [...(params.commandArgs ?? [])] }
    : await resolveCodexCliInvocation({
        args: [],
        cwd: directory,
        processEnv: env,
        overrideEnvVarKeys: ['HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
        targetLabel: 'Codex CLI',
      });
  const prepared = await prepareOwnedTerminalSpawn({
    command: resolved.command,
    args: [
      ...resolved.args,
      ...createCodexSharedAttachArgs({ endpoint: endpoint.endpoint, directory, sessionId: vendorSessionId }),
    ],
    env,
    cwd: process.cwd(),
  });
  try {
    const observe = params.terminalClient ? async (attached: boolean, launcher: Parameters<NonNullable<Parameters<typeof runOwnedTerminalProcess>[0]['onStarted']>>[0]) => {
      const result = await params.prepareProviderCliAttach!({ providerSessionId: vendorSessionId,
        terminalClient: { attached, herdr: params.terminalClient!, launcher } });
      if (!result.ok || result.providerSessionId !== vendorSessionId) throw new Error('provider_cli_attach_admission_failed');
    } : null;
    const result = await runOwnedTerminalProcess({ spawn: prepared, cwd: process.cwd(), spawnProcess: params.spawnProcess,
      ...(observe ? { onStarted: launcher => observe(true, launcher), onExited: launcher => observe(false, launcher) } : {}) });
    return result.code ?? 1;
  } catch {
    logger.infoFile('[terminal] Native terminal attach failed (terminal_native_attach_failed)');
    return 1;
  }
}
