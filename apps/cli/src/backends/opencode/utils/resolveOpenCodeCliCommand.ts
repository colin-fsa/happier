export { type ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { basename } from 'node:path';

import { normalizeOpenCodeCliGeneration } from '@happier-dev/agents';
import { resolveProviderCliCommandCandidates } from '@happier-dev/cli-common/providers';

import { buildProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import type { ProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { ProviderCliNotFoundError } from '@/runtime/managedTools/requireProviderCliCommand';

function isOpenCodeV2Command(command: string): boolean {
  return /^opencode2(?:\.(?:cmd|exe))?$/i.test(basename(command));
}

export type OpenCodeCliLaunchSpec = ProviderCliLaunchSpec & Readonly<{
  /**
   * Explicit selection is authoritative because released OpenCode 2 uses the
   * same `opencode` executable name as OpenCode 1. Auto can only distinguish
   * the retained preview command before the server is running; the server
   * client still performs the canonical wire-dialect probe after startup.
   */
  apiGeneration: 'auto' | 'v2';
}>;

export function resolveOpenCodeCliLaunchSpec(
  processEnv: NodeJS.ProcessEnv = process.env,
): OpenCodeCliLaunchSpec {
  const generation = normalizeOpenCodeCliGeneration(processEnv.HAPPIER_OPENCODE_CLI_GENERATION);
  const candidates = resolveProviderCliCommandCandidates('opencode', {
    processEnv,
    currentExecPath: process.execPath,
  });
  const resolved = generation === 'v2'
    ? candidates.find(({ command }) => isOpenCodeV2Command(command)) ?? candidates[0]
    : generation === 'stable'
      ? candidates.find(({ command }) => !isOpenCodeV2Command(command))
      : candidates.find(({ command }) => !isOpenCodeV2Command(command)) ?? candidates[0];
  if (!resolved) {
    const explicitPath = typeof processEnv.HAPPIER_OPENCODE_PATH === 'string'
      ? processEnv.HAPPIER_OPENCODE_PATH.trim()
      : '';
    if (explicitPath && candidates.length > 0 && generation === 'stable') {
      throw new ReferenceError(
        `The explicit OpenCode path selects ${isOpenCodeV2Command(explicitPath) ? 'V2' : 'stable'}, but the OpenCode generation setting requires stable.`,
      );
    }
    if (candidates.length === 0) {
      throw new ProviderCliNotFoundError('opencode', { processEnv });
    }
    throw new ReferenceError(
      generation === 'v2'
        ? 'OpenCode V2 is selected, but no runnable opencode or opencode2 executable was found.'
        : generation === 'stable'
          ? 'Stable OpenCode is selected, but no runnable opencode executable was found.'
          : 'OpenCode is not installed or its executable could not be resolved.',
    );
  }

  const launchSpec = buildProviderCliLaunchSpec(resolved, { processEnv });
  if (!launchSpec) {
    throw new ReferenceError(`OpenCode was found at ${resolved.command}, but no compatible JavaScript runtime is available.`);
  }
  return {
    ...launchSpec,
    apiGeneration: generation === 'v2' || isOpenCodeV2Command(resolved.command)
      ? 'v2'
      : 'auto',
  };
}
