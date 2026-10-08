import type { AgentId } from '@happier-dev/agents';

import { buildMissingProviderCliCommandErrorMessage } from './requireProviderCliCommand';
import { resolveProviderCliCommand } from './providerCliResolution';

export async function validateProviderCliSpawn(params: Readonly<{ agentId: AgentId; processEnv?: NodeJS.ProcessEnv }>): Promise<
  | { ok: true }
  | { ok: false; errorMessage: string }
> {
  const resolved = resolveProviderCliCommand(params.agentId, { processEnv: params.processEnv });
  if (resolved) return { ok: true };

  return {
    ok: false,
    errorMessage: buildMissingProviderCliCommandErrorMessage(params.agentId, { processEnv: params.processEnv }),
  };
}
