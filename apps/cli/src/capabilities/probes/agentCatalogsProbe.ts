import { PreflightSessionCatalogsV1Schema, SessionSkillCatalogListResponseV1Schema, type PreflightSessionCatalogsV1 } from '@happier-dev/protocol';

import { normalizeAvailableCommands } from '@/agent/acp/commands/publishSlashCommands';
import { requireCatalogEntry } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';

import type { PreflightSessionControlsProbeParams } from './preflightSessionControlsProbeAdapterTypes';
import { probeAcpCatalogs } from './probeAcpCatalogs';
import { remainingCatalogProbeMs } from './catalogProbeLifecycle';

export async function probeAgentCatalogs(
  params: PreflightSessionControlsProbeParams & Readonly<{ agentId: CatalogAgentId }>,
): Promise<PreflightSessionCatalogsV1> {
  const entry = requireCatalogEntry(params.agentId);
  const adapter = await entry.getPreflightSessionControlsProbeAdapter?.();
  remainingCatalogProbeMs(params);
  const raw = adapter?.probeCatalogsRaw
    ? await adapter.probeCatalogsRaw(params)
    : await probeAcpCatalogs(params);
  const diagnostic = raw.diagnostic ? { diagnostic: raw.diagnostic } : {};
  return PreflightSessionCatalogsV1Schema.parse({
    commands: { supported: raw.commands !== null, items: normalizeAvailableCommands(raw.commands), ...diagnostic },
    skills: {
      supported: raw.skills !== null,
      items: raw.skills === null ? [] : SessionSkillCatalogListResponseV1Schema.parse({ skills: raw.skills }).skills,
      ...diagnostic,
    },
  });
}
