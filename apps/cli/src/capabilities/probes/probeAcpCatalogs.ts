import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import type { AgentBackend, AgentMessageHandler } from '@/agent/core';
import { requireCatalogEntry } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';

import { createConfiguredAcpProbeBackend } from './createConfiguredAcpProbeBackend';
import type { PreflightSessionCatalogsRaw, PreflightSessionControlsProbeParams } from './preflightSessionControlsProbeAdapterTypes';
import { validateCatalogAcpProbeSpawn } from './validateCatalogAcpProbeSpawn';
import { remainingCatalogProbeMs, withCatalogProbeLifecycle } from './catalogProbeLifecycle';

export async function probeAcpCatalogs(
  params: PreflightSessionControlsProbeParams & Readonly<{ agentId: CatalogAgentId }>,
): Promise<PreflightSessionCatalogsRaw> {
  let backend: AgentBackend | null = null;
  const unsupported: PreflightSessionCatalogsRaw = { commands: null, skills: null };
  let handler: AgentMessageHandler | undefined;
  const cleanup = async () => {
    if (backend) {
      if (handler) backend.offMessage?.(handler);
      await backend.dispose();
    }
  };
  return await withCatalogProbeLifecycle(params, async (lifecycle) => {
    const admitBackend = async (created: AgentBackend) => {
      backend = created;
      params.onNativeCleanup?.(cleanup);
      if (lifecycle.signal.aborted) {
        await created.dispose();
        lifecycle.signal.throwIfAborted();
      }
      remainingCatalogProbeMs(lifecycle);
    };
    remainingCatalogProbeMs(lifecycle);
    backend = await createConfiguredAcpProbeBackend(params);
    if (backend) await admitBackend(backend);
    remainingCatalogProbeMs(lifecycle);
    if (!backend) {
      if (params.backendTarget?.kind === 'configuredAcpBackend') {
        throw new Error('Configured ACP backend is unavailable');
      }
      if (!requireCatalogEntry(params.agentId).getAcpBackendFactory) return unsupported;
      const validation = await validateCatalogAcpProbeSpawn(params.agentId, { processEnv: params.processEnv, cwd: params.cwd });
      remainingCatalogProbeMs(lifecycle);
      if (!validation.ok) {
        throw new Error(validation.errorMessage);
      }
      const permissionHandler: AcpPermissionHandler = {
        handleToolCall: async () => ({ decision: 'abort' }),
      };
      const created = await createCatalogAcpBackend(params.agentId, {
        cwd: params.cwd,
        env: params.processEnv ?? process.env,
        mcpServers: {},
        permissionHandler,
        permissionMode: 'default',
        readinessOnly: true,
      });
      await admitBackend(created.backend);
    }

    const commandsUpdate = new Promise<unknown[]>((resolve, reject) => {
      handler = (message) => {
        if (message.type === 'status' && message.status === 'error') {
          reject(new Error(message.detail ?? 'ACP transport failed'));
        }
        if (message.type !== 'event' || message.name !== 'available_commands_update') return;
        const payload = message.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
        const commands = (payload as Record<string, unknown>).availableCommands;
        if (Array.isArray(commands)) resolve(commands);
      };
      backend!.onMessage(handler);
    });
    // Subscribe before session/new: agents may advertise commands while the request is in flight.
    // A resolved session alone is not an observation, and no prompt is sent to obtain the catalog.
    const [, commands] = await Promise.all([backend!.startSession(), commandsUpdate]);
    return { commands, skills: null };
  }, cleanup);
}
