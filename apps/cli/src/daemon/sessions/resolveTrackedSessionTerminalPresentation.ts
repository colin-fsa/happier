import { requireCatalogEntry } from '@/backends/catalog';
import { resolveDaemonTerminalPresentation, type DaemonTerminalPresentation } from '../spawnHooks';
import type { TrackedSession } from '../types';
import { resolveTrackedSessionCatalogAgentId } from './resolveTrackedSessionCatalogAgentId';

/** Reuse the accepted provider selection, never today's account defaults or daemon environment. */
export async function resolveTrackedSessionTerminalPresentation(tracked: TrackedSession): Promise<DaemonTerminalPresentation | null> {
  const options = tracked.spawnOptions;
  const host = options?.terminal?.mode;
  if (!options || (host !== 'herdr' && host !== 'zellij' && host !== 'tmux')) return null;
  const agentId = resolveTrackedSessionCatalogAgentId(tracked);
  const hooks = await requireCatalogEntry(agentId).getDaemonSpawnHooks?.();
  return resolveDaemonTerminalPresentation({
    hooks, host, agentId, configuredAcpBackend: options.backendTarget?.kind === 'configuredAcpBackend',
    accountSettings: null,
    runtimeSelection: { experimentalCodexAcp: options.experimentalCodexAcp,
      codexBackendMode: options.codexBackendMode, agentRuntimeDescriptorV1: options.agentRuntimeDescriptorV1,
      directory: options.directory, environmentVariables: options.environmentVariables },
    processEnv: options.environmentVariables ?? {},
  });
}
