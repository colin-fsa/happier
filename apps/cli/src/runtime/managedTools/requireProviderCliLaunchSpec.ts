import type { AgentId } from '@happier-dev/agents';
import {
  providerCliPathRequiresJavaScriptRuntime,
  resolveJavaScriptRuntimeCommand,
  resolveProviderCliCommand,
  type ProviderCliCommandResolution,
} from '@happier-dev/cli-common/providers';

import { isBun } from '@/utils/runtime';

import { ProviderCliNotFoundError } from './requireProviderCliCommand';

export type ProviderCliLaunchSpec = Readonly<{
  source: ProviderCliCommandResolution['source'];
  resolvedPath: string;
  command: string;
  args: readonly string[];
}>;

export function buildProviderCliLaunchSpec(
  resolved: ProviderCliCommandResolution,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? process.env;
  if (!providerCliPathRequiresJavaScriptRuntime(resolved.command)) {
    return {
      source: resolved.source,
      resolvedPath: resolved.command,
      command: resolved.command,
      args: [],
    };
  }

  const runtimeCommand = resolveJavaScriptRuntimeCommand({
    isBunRuntime: isBun(),
    processEnv,
    currentExecPath: process.execPath,
  });
  if (!runtimeCommand) return null;

  return {
    source: resolved.source,
    resolvedPath: resolved.command,
    command: runtimeCommand,
    args: [resolved.command],
  };
}

export function resolveProviderCliLaunchSpec(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec | null {
  const processEnv = opts.processEnv ?? process.env;
  const resolved = resolveProviderCliCommand(agentId, {
    processEnv,
    isBunRuntime: isBun(),
    currentExecPath: process.execPath,
  });
  if (!resolved) return null;
  return buildProviderCliLaunchSpec(resolved, { processEnv });
}

export function requireProviderCliLaunchSpec(
  agentId: AgentId,
  opts: Readonly<{ processEnv?: NodeJS.ProcessEnv }> = {},
): ProviderCliLaunchSpec {
  const resolved = resolveProviderCliLaunchSpec(agentId, opts);
  if (resolved) return resolved;
  throw new ProviderCliNotFoundError(agentId, opts);
}
