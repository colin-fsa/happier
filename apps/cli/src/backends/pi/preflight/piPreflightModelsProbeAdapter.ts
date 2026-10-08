import { spawn } from 'node:child_process';

import type { PreflightSessionCatalogsRaw, PreflightSessionControlsProbeAdapter, PreflightSessionControlsProbeParams } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { createPiModelCatalogEntry, type PiModelCatalogEntry } from '@/backends/pi/models/piModelCatalog';
import { materializePiModelDiscoveryExtension, parsePiModelDiscoveryLine } from '@/backends/pi/models/piModelDiscoveryExtension';
import { resolvePiBrokerExtensionArgs } from '@/backends/pi/brokerExtension';
import { attachPiRpcJsonlLineReader } from '@/backends/pi/rpc/attachPiRpcJsonlLineReader';
import { PiRpcBackend } from '@/backends/pi/rpc/PiRpcBackend';
import { logger } from '@/ui/logger';

type PiModelsProbeResult = PiModelCatalogEntry[] | {
  availableModels: PiModelCatalogEntry[];
  source: 'static';
  refreshError: true;
} | null;

async function probePiCatalogs(params: PreflightSessionControlsProbeParams): Promise<PreflightSessionCatalogsRaw> {
  const processEnv = params.processEnv ?? process.env;
  const launch = requireProviderCliLaunchSpec('pi', { processEnv });
  const backend = new PiRpcBackend({
    cwd: params.cwd,
    command: launch.command,
    args: [...launch.args, '--mode', 'rpc', '--no-session', ...resolvePiBrokerExtensionArgs(processEnv)],
    env: Object.fromEntries(Object.entries({ ...processEnv, CI: '1' })
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  });
  params.onNativeCleanup?.(() => backend.dispose());
  try {
    const commands = await backend.discoverCommands({ timeoutMs: params.timeoutMs, deadlineAt: params.deadlineAt, signal: params.signal });
    // Native slash skills belong to get_commands. Pi exposes no distinct typed skill-mention channel.
    if (commands === null) {
      throw new Error('Pi did not return a valid native command catalog');
    }
    return { commands, skills: null };
  } catch (error) {
    logger.infoFile('[pi] Native command catalog probe failed');
    throw error;
  } finally {
    await backend.dispose();
  }
}

async function probePiModels(params: PreflightSessionControlsProbeParams): Promise<PiModelsProbeResult> {
  const processEnv = params.processEnv ?? process.env;
  const launch = requireProviderCliLaunchSpec('pi', { processEnv });
  const extension = await materializePiModelDiscoveryExtension({ bypassCache: params.bypassCache });
  try {
    const invocation = resolveWindowsCommandInvocation({
      command: launch.command,
      // Print mode binds extensions and exits with no prompt. Unlike RPC startup it
      // does not race our awaited refresh with a second background catalog refresh.
      args: [
        ...launch.args, '--mode', 'json', '--no-session', '--no-tools',
        ...resolvePiBrokerExtensionArgs(processEnv), '--extension', extension.path,
      ],
      resolveCommandOnPath: true,
    });
    return await new Promise((resolve) => {
      let result: PiModelsProbeResult = null;
      let failure = 'missing-observation';
      let timedOut = false;
      let settled = false;
      const child = spawn(invocation.command, invocation.args, {
        cwd: params.cwd,
        env: { ...processEnv, CI: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      const reader = attachPiRpcJsonlLineReader(child.stderr!, (line) => {
        const observation = parsePiModelDiscoveryLine(line);
        if (!observation) return;
        const isLocalFallback = 'error' in observation && observation.error === 'refresh-unsupported'
          && Array.isArray(observation.models);
        if ('error' in observation && !isLocalFallback) {
          result = null;
          failure = observation.error;
          return;
        }
        const rawModels = observation.models!;
        const models = rawModels.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const model = value as Record<string, unknown>;
          const entry = createPiModelCatalogEntry({
            provider: model.provider, modelId: model.id, name: model.name,
            supportsThinking: model.reasoning === true,
          });
          return entry ? [entry] : [];
        });
        result = rawModels.length > 0 && models.length === 0 ? null
          : isLocalFallback ? { availableModels: models, source: 'static', refreshError: true } : models;
        failure = isLocalFallback ? 'refresh-unsupported' : 'invalid-catalog';
      });
      const timer = setTimeout(() => {
        timedOut = true;
        failure = 'timeout';
        void killProcessTree(child).catch(() => { failure = 'process-cleanup-failed'; }).finally(() => finish(null));
      }, params.timeoutMs);
      const finish = (value: PiModelsProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reader.close();
        if (value === null || !Array.isArray(value)) logger.info('[pi] Model catalog probe did not obtain a fresh observation', { reason: failure });
        resolve(value);
      };
      child.once('error', () => { failure = 'process-error'; finish(null); });
      child.once('close', (code) => { finish(!timedOut && code === 0 ? result : null); });
    });
  } finally {
    await extension.cleanup();
  }
}

export const piPreflightModelsProbeAdapter: PreflightSessionControlsProbeAdapter = {
  connectedServiceAuth: 'materialized-env',
  failureCacheStrategy: 'cooldown',
  probeModelsRaw: probePiModels,
  probeCatalogsRaw: probePiCatalogs,
};
