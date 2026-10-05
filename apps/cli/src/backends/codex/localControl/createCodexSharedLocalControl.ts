import { createSharedProviderLocalControl } from '@/agent/localControl/createSharedProviderLocalControl';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { SessionProviderCliAttachPrepareRequestV1, SessionProviderCliAttachPrepareResultV1 } from '@happier-dev/protocol';

import {
  createCodexSharedTuiSupervisor,
  type CodexSharedTuiSupervisor,
} from './createCodexSharedTuiSupervisor';
import type { CodexSharedAttachTarget } from './createCodexSharedAttachArgs';

export function createCodexSharedLocalControl(params: Readonly<{
  startingMode: 'local' | 'remote';
  getSession: () => ApiSessionClient | null;
  getSessionId: () => Promise<string | null> | string | null;
  directory: string;
  endpoint: string;
  processEnv?: NodeJS.ProcessEnv;
  terminalRuntime?: TerminalRuntimeFlags | null;
  supervisor?: CodexSharedTuiSupervisor;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>) {
  let localControl: ReturnType<typeof createSharedProviderLocalControl<CodexSharedAttachTarget>>;
  const supervisor = params.supervisor ?? createCodexSharedTuiSupervisor({
    processEnv: params.processEnv,
    terminalPresentation: { runtime: params.terminalRuntime, getSession: params.getSession },
    onExit: async () => await localControl.onTerminalExit(),
  });
  localControl = createSharedProviderLocalControl({
    supported: true,
    startingMode: params.startingMode,
    getSession: params.getSession,
    resolveTarget: async () => {
      const sessionId = await params.getSessionId();
      return sessionId
        ? { endpoint: params.endpoint, directory: params.directory, sessionId }
        : null;
    },
    isSameTarget: (left, right) => left.endpoint === right.endpoint && left.sessionId === right.sessionId,
    supervisor,
    mountRemoteUi: params.mountRemoteUi,
    unmountRemoteUi: params.unmountRemoteUi,
  });
  const prepareProviderCliAttach = async (request: SessionProviderCliAttachPrepareRequestV1): Promise<SessionProviderCliAttachPrepareResultV1> => {
    if (await params.getSessionId() !== request.providerSessionId) return { ok: false, errorCode: 'provider_cli_attach_identity_mismatch' };
    if (request.terminalClient && !await localControl.observeTerminalClient(request.terminalClient)) {
      return { ok: false, errorCode: 'provider_cli_attach_admission_failed' };
    }
    if (await params.getSessionId() !== request.providerSessionId) return { ok: false, errorCode: 'provider_cli_attach_identity_mismatch' };
    return { ok: true, providerSessionId: request.providerSessionId };
  };
  let unregisterPreparation: (() => void) | null = null;
  const register = (session: ApiSessionClient | null) => {
    unregisterPreparation?.();
    unregisterPreparation = session?.registerSessionRuntimeControls?.({ prepareProviderCliAttach }) ?? null;
  };
  return { ...localControl, prepareProviderCliAttach,
    onAfterStart: async (options?: Parameters<typeof localControl.onAfterStart>[0]) => {
      register(params.getSession());
      await localControl.onAfterStart(options);
    },
    onSessionSwap: async (session: ApiSessionClient) => {
      register(session);
      await localControl.onSessionSwap(session);
    },
    dispose: async () => { unregisterPreparation?.(); unregisterPreparation = null; await localControl.dispose(); },
  };
}
