import { createAttachedTerminalSupervisor, type AttachedTerminalSupervisor, type AttachedTerminalPresentation } from '@/agent/localControl/createAttachedTerminalSupervisor';
import type { SharedManagedOpenCodeServerState } from '@/backends/opencode/server/sharedManagedServer';

import { createOpenCodeAttachArgs } from './createOpenCodeAttachArgs';
import {
  resolveOpenCodeAttachChildEnv,
  resolveOpenCodeAttachTargetAuthHeaders,
} from './openCodeAttachTargetAuth';
import { resolveOpenCodeAttachCliDialect } from './resolveOpenCodeAttachCliDialect';
import { resolveOpenCodeCliLaunchSpec } from '../utils/resolveOpenCodeCliCommand';

function resolveDetachTimeoutMs(): number {
  const raw = Number.parseInt(String(process.env.HAPPIER_OPENCODE_LOCAL_DETACH_TIMEOUT_MS ?? ''), 10);
  const value = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 3_000;
  return Math.max(100, Math.min(60_000, value));
}

export type OpenCodeTuiAttachTarget = Readonly<{
  baseUrl: string;
  directory: string;
  sessionId: string;
  managedServerLaunchFingerprint?: string;
}>;

export type OpenCodeTuiSupervisor = AttachedTerminalSupervisor<OpenCodeTuiAttachTarget>;

export function createOpenCodeTuiSupervisor(params?: Readonly<{
  spawnProcess?: Parameters<typeof createAttachedTerminalSupervisor>[0]['spawnProcess'];
  command?: string;
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  onExit?: () => void | Promise<void>;
  terminalPresentation?: AttachedTerminalPresentation;
  /** Overrides the target probe; omit in production so the actual server decides the dialect. */
  resolveDialectFn?: typeof resolveOpenCodeAttachCliDialect;
  readManagedServerStateFn?: () => Promise<SharedManagedOpenCodeServerState | null>;
}>): OpenCodeTuiSupervisor {
  const env = params?.env ?? process.env;
  const commandOverride = params?.command;
  let command: string;
  let commandArgs: readonly string[];
  let launchApiGeneration: 'auto' | 'v2' | undefined;
  if (commandOverride) {
    command = commandOverride;
    commandArgs = params?.commandArgs ?? [];
  } else {
    const launch = resolveOpenCodeCliLaunchSpec(env);
    command = launch.command;
    commandArgs = params?.commandArgs ?? launch.args;
    launchApiGeneration = launch.apiGeneration;
  }
  return createAttachedTerminalSupervisor({
    spawnProcess: params?.spawnProcess,
    env,
    detachTimeoutMs: resolveDetachTimeoutMs(),
    onExit: params?.onExit,
    terminalPresentation: params?.terminalPresentation,
    resolveInvocation: async ({ baseUrl, directory, sessionId, managedServerLaunchFingerprint }) => {
      // The attached CLI talks to the target server itself: it needs that server's credential (loopback
      // managed targets only) and the argv dialect the target actually speaks.
      const readManagedServerStateFn = params?.readManagedServerStateFn;
      const targetAuth = {
        baseUrl,
        env,
        managedServerLaunchFingerprint,
        ...(readManagedServerStateFn ? { readManagedServerStateFn } : {}),
      };
      const dialect = await (params?.resolveDialectFn ?? resolveOpenCodeAttachCliDialect)({
        baseUrl,
        ...(launchApiGeneration ? { launchApiGeneration } : {}),
        headers: await resolveOpenCodeAttachTargetAuthHeaders(targetAuth),
      });
      return {
        command,
        args: [...commandArgs, ...createOpenCodeAttachArgs({ baseUrl, directory, sessionId, dialect })],
        env: await resolveOpenCodeAttachChildEnv(targetAuth),
      };
    },
  });
}
