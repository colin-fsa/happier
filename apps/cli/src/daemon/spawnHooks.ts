import {
  hasBuiltInAcpConfig,
  type AgentId,
  type CodexBackendMode,
} from '@happier-dev/agents';
import type { AgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { AccountSettings } from '@happier-dev/protocol';

import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/codexBackendMode';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

export function buildTrackedSpawnOptions(params: Readonly<{
  options: SpawnSessionOptions;
  environmentVariables?: SpawnSessionOptions['environmentVariables'];
  materializationDiagnostics?: SpawnSessionOptions['materializationDiagnostics'];
  terminalPresentation?: DaemonTerminalPresentation;
  actualTerminal?: SpawnSessionOptions['terminal'];
}>): SpawnSessionOptions {
  const {
    existingSessionAttachPayload: _existingSessionAttachPayload,
    initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
    executionAuthorization: _executionAuthorization,
    initialGoal: _initialGoal,
    ...trackedOptions
  } = params.options;
  return {
    ...trackedOptions,
    // Persist the accepted physical topology, not a host request rejected by the runtime.
    ...(params.actualTerminal
      ? { terminal: params.actualTerminal }
      : params.terminalPresentation?.kind === 'none' ? { terminal: { mode: 'plain' as const } } : {}),
    ...(params.environmentVariables ? { environmentVariables: params.environmentVariables } : {}),
    ...(params.materializationDiagnostics ? { materializationDiagnostics: params.materializationDiagnostics } : {}),
  };
}

export type DaemonSpawnRuntimeSelection = Readonly<{
  experimentalCodexAcp?: boolean;
  codexBackendMode?: CodexBackendMode;
  agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
  directory?: string;
  environmentVariables?: NodeJS.ProcessEnv;
  /** Preflight queries may observe prerequisites without installing or updating them. */
  readinessOnly?: boolean;
}>;

export function resolveDaemonSpawnRuntimeCodexBackendMode(selection: DaemonSpawnRuntimeSelection): CodexBackendMode | undefined {
  return resolveCanonicalCodexBackendMode(selection);
}

export type DaemonSpawnValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; errorMessage: string; reasonCode?: string }>;

export type DaemonTerminalPresentation = Readonly<{
  /** provider hosts a session-bearing process; provider_attach hosts only an optional native client. */
  kind: 'runner' | 'provider' | 'provider_attach' | 'none';
  startingMode?: 'local' | 'remote';
  childEnv?: Readonly<Record<string, string>>;
}>;

export function resolveDefaultDaemonTerminalPresentation(params: Readonly<{
  host: 'tmux' | 'zellij' | 'herdr';
  agentId: AgentId;
  configuredAcpBackend: boolean;
}>): DaemonTerminalPresentation {
  if (params.configuredAcpBackend || hasBuiltInAcpConfig(params.agentId)) {
    return { kind: 'none' };
  }
  return {
    kind: 'runner',
    startingMode: params.host === 'tmux' ? 'remote' : 'local',
  };
}

export type DaemonSpawnHooks = Readonly<{
  validateSpawn?: (params: DaemonSpawnRuntimeSelection) => Promise<DaemonSpawnValidationResult>;
  buildExtraEnvForChild?: (params: DaemonSpawnRuntimeSelection) => Record<string, string>;
  resolveTerminalPresentation?: (params: Readonly<{
    host: 'tmux' | 'zellij' | 'herdr';
    accountSettings: AccountSettings | null;
    runtimeSelection: DaemonSpawnRuntimeSelection;
    processEnv: NodeJS.ProcessEnv;
  }>) => DaemonTerminalPresentation;
}>;

export function resolveDaemonTerminalPresentation(params: Readonly<{
  hooks: DaemonSpawnHooks | null | undefined;
  host: 'tmux' | 'zellij' | 'herdr';
  agentId: AgentId;
  configuredAcpBackend: boolean;
  accountSettings: AccountSettings | null;
  runtimeSelection: DaemonSpawnRuntimeSelection;
  processEnv: NodeJS.ProcessEnv;
  existingSessionId?: string;
}>): DaemonTerminalPresentation {
  const selected = params.hooks?.resolveTerminalPresentation?.(params)
    ?? resolveDefaultDaemonTerminalPresentation(params);
  // Recover the existing shared controller without silently recreating an optional client.
  // Explicit Attach remains the same live runner's local-mode operation.
  return selected.kind === 'provider_attach' && params.existingSessionId?.trim()
    ? { ...selected, startingMode: 'remote' }
    : selected;
}
