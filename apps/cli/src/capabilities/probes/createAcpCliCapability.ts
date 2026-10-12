import type { TransportHandler } from '@/agent/transport';
import type { CatalogAgentId } from '@/backends/types';
import { resolveAcpProbeTimeoutMs } from '@/capabilities/utils/acpProbeTimeout';
import { buildAcpCapabilitySnapshot } from '@/capabilities/probes/acpCapabilitySnapshot';
import { buildCliCapabilityData } from '@/capabilities/probes/cliBase';
import { probeAcpAgentCapabilities } from '@/capabilities/probes/acpProbe';
import type { Capability } from '@/capabilities/service';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';

export function createAcpCliCapability(params: {
  agentId: CatalogAgentId;
  title: string;
  acpArgs: string[];
  transport: TransportHandler;
  resolveAcpProbeLaunch?: () => Promise<Readonly<{ command: string; args: readonly string[] }>>
    | Readonly<{ command: string; args: readonly string[] }>;
  resolveAcpProbeArgs?: (params: Readonly<{
    resolvedPath: string;
    defaultArgs: readonly string[];
  }>) => Promise<string[]> | string[];
  resolveAcpProbeEnv?: (params: Readonly<{
    defaultEnv: NodeJS.ProcessEnv;
  }>) => NodeJS.ProcessEnv;
}): Capability {
  return {
    descriptor: { id: `cli.${params.agentId}`, kind: 'cli', title: params.title },
    detect: async ({ request, context }) => {
      const entry = context.cliSnapshot?.clis?.[params.agentId];
      const base = buildCliCapabilityData({ request, entry });

      const includeAcpCapabilities = Boolean((request.params ?? {}).includeAcpCapabilities);
      if (!includeAcpCapabilities || base.available !== true || !base.resolvedPath) {
        return base;
      }

      const resolvedAcpProbeArgs = params.resolveAcpProbeArgs
        ? await params.resolveAcpProbeArgs({
            resolvedPath: base.resolvedPath,
            defaultArgs: params.acpArgs,
          })
        : params.acpArgs;
      const acpProbeArgs = resolvedAcpProbeArgs.length > 0 ? resolvedAcpProbeArgs : params.acpArgs;
      const launchSpec = params.resolveAcpProbeLaunch ? null : (() => {
        try {
          const resolved = requireProviderCliLaunchSpec(params.agentId, { processEnv: process.env });
          return resolved.resolvedPath === base.resolvedPath ? resolved : null;
        } catch {
          return null;
        }
      })();

      let probeLaunch: Readonly<{ command: string; args: readonly string[] }>;
      try {
        probeLaunch = params.resolveAcpProbeLaunch
          ? await params.resolveAcpProbeLaunch()
          : {
              command: launchSpec?.command ?? base.resolvedPath,
              args: [...(launchSpec?.args ?? []), ...acpProbeArgs],
            };
      } catch (error) {
        return {
          ...base,
          acp: buildAcpCapabilitySnapshot({
            ok: false,
            checkedAt: Date.now(),
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
        };
      }

      const defaultEnv: NodeJS.ProcessEnv = {
        // Keep output clean to avoid ACP stdout pollution.
        NODE_ENV: 'production',
        DEBUG: '',
      };
      const probeEnv = params.resolveAcpProbeEnv
        ? params.resolveAcpProbeEnv({ defaultEnv })
        : defaultEnv;

      const probe = await probeAcpAgentCapabilities({
        command: probeLaunch.command,
        args: probeLaunch.args,
        cwd: process.cwd(),
        env: probeEnv,
        transport: params.transport,
        timeoutMs: resolveAcpProbeTimeoutMs(params.agentId, params.transport.getInitTimeout()),
      });

      const acp = buildAcpCapabilitySnapshot(probe);
      return { ...base, acp };
    },
  };
}
