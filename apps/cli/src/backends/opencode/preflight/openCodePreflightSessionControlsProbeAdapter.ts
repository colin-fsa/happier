import { normalizeOpenCodeAppSkills } from '@happier-dev/protocol';
import { resolveOpenCodeSessionBackendMode } from '@happier-dev/agents';

import type { PreflightSessionControlsProbeAdapter } from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { probeAcpCatalogs } from '@/capabilities/probes/probeAcpCatalogs';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { remainingCatalogProbeMs, withCatalogProbeLifecycle } from '@/capabilities/probes/catalogProbeLifecycle';

import { createOpenCodeServerRuntimeClient } from '../server/client';
import { startManagedOpenCodeServer } from '../server/openCodeManagedServer';
import { resolveOpenCodeManagedServerCredentialChildEnv } from '../server/openCodeManagedServerCredential';
import { openCodePreflightModelsProbeAdapter } from './openCodePreflightModelsProbeAdapter';

export const openCodePreflightSessionControlsProbeAdapter: PreflightSessionControlsProbeAdapter = {
  ...openCodePreflightModelsProbeAdapter,
  probeCatalogsRaw: async (params) => {
    const backendMode = resolveOpenCodeSessionBackendMode({ metadata: null, accountSettings: params.accountSettings ?? null });
    if (backendMode === 'acp') return await probeAcpCatalogs({ ...params, agentId: 'opencode' });
    const processEnv = params.processEnv ?? process.env;
    let server: Awaited<ReturnType<typeof startManagedOpenCodeServer>> | undefined;
    let client: Awaited<ReturnType<typeof createOpenCodeServerRuntimeClient>> | undefined;
    const cleanup = async () => {
      try {
        await client?.dispose();
      } finally {
        await server?.close();
      }
    };
    return await withCatalogProbeLifecycle(params, async (lifecycle) => {
        // This short-lived native server uses the existing process owner and creates no Happier session.
        server = await startManagedOpenCodeServer({ env: processEnv, cwd: params.cwd,
          timeoutMs: remainingCatalogProbeMs(lifecycle), signal: lifecycle.signal, onCleanup: params.onNativeCleanup });
        if (lifecycle.signal.aborted) {
          await server.close();
          lifecycle.signal.throwIfAborted();
        }
        client = await createOpenCodeServerRuntimeClient({
          directory: params.cwd,
          baseUrlOverride: server.baseUrl,
          messageBuffer: new MessageBuffer(),
          env: {
            ...processEnv,
            ...(server.authPassword ? resolveOpenCodeManagedServerCredentialChildEnv({ username: 'opencode', password: server.authPassword }) : {}),
            HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS: String(remainingCatalogProbeMs(lifecycle)),
          },
        });
        params.onNativeCleanup?.(cleanup);
        if (lifecycle.signal.aborted) {
          await client.dispose();
          lifecycle.signal.throwIfAborted();
        }
        remainingCatalogProbeMs(lifecycle);
        const [commands, skills] = await Promise.all([client.appCommands(), client.appSkills()]);
        return { commands, skills: normalizeOpenCodeAppSkills(skills) };
    }, cleanup);
  },
};
