import { createSharedProviderLocalControl } from '@/agent/localControl/createSharedProviderLocalControl';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import { logger } from '@/ui/logger';
import type { SessionProviderCliAttachPrepareRequestV1, SessionProviderCliAttachPrepareResultV1 } from '@happier-dev/protocol';

import { createOpenCodeTuiSupervisor, type OpenCodeTuiSupervisor, type OpenCodeTuiAttachTarget } from './openCodeTuiSupervisor';
import type { OpenCodeLocalControlSupport } from './resolveOpenCodeLocalControlSupport';

type Mode = 'local' | 'remote';

type OpenCodeAttachTarget = OpenCodeTuiAttachTarget;

export function createOpenCodeSharedLocalControl(params: Readonly<{
  support: OpenCodeLocalControlSupport;
  startingMode: Mode;
  terminalRuntime?: TerminalRuntimeFlags | null;
  getSession: () => ApiSessionClient | null;
  getSessionId: () => string | null;
  getDirectory: () => string;
  getServerTarget: () => Promise<Pick<OpenCodeAttachTarget, 'baseUrl' | 'managedServerLaunchFingerprint'> | null> | Pick<OpenCodeAttachTarget, 'baseUrl' | 'managedServerLaunchFingerprint'> | null;
  prepareAttachment?: () => Promise<boolean>;
  supervisor?: OpenCodeTuiSupervisor;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>) {
  const prepareProviderCliAttach = async (
    request: Readonly<SessionProviderCliAttachPrepareRequestV1>,
  ): Promise<SessionProviderCliAttachPrepareResultV1> => {
    if (params.getSessionId() !== request.providerSessionId) {
      return { ok: false, errorCode: 'provider_cli_attach_identity_mismatch' };
    }
    if (params.prepareAttachment && !await params.prepareAttachment()) {
      logger.infoFile('[opencode] native_attachment_controls_not_applied');
      return { ok: false, errorCode: 'provider_cli_attach_not_ready' };
    }
    if (params.getSessionId() !== request.providerSessionId) {
      return { ok: false, errorCode: 'provider_cli_attach_identity_mismatch' };
    }
    if (request.terminalClient && !await localControl.observeTerminalClient(request.terminalClient)) {
      return { ok: false, errorCode: 'provider_cli_attach_admission_failed' };
    }
    return { ok: true, providerSessionId: request.providerSessionId };
  };
  let localControl: ReturnType<typeof createSharedProviderLocalControl<OpenCodeAttachTarget>>;
  const supervisor = params.supervisor ?? createOpenCodeTuiSupervisor({
    terminalPresentation: { runtime: params.terminalRuntime, getSession: params.getSession },
    onExit: async () => {
      await localControl.onTerminalExit();
    },
  });
  localControl = createSharedProviderLocalControl({
    supported: params.support.ok,
    startingMode: params.startingMode,
    getSession: params.getSession,
    resolveTarget: async () => {
      const sessionId = params.getSessionId();
      if (!sessionId || !(await prepareProviderCliAttach({ providerSessionId: sessionId })).ok) return null;
      const serverTarget = await params.getServerTarget();
      if (!serverTarget?.baseUrl || params.getSessionId() !== sessionId) return null;
      return { ...serverTarget, directory: params.getDirectory(), sessionId };
    },
    isSameTarget: (left, right) => left.baseUrl === right.baseUrl && left.sessionId === right.sessionId
      && left.managedServerLaunchFingerprint === right.managedServerLaunchFingerprint,
    supervisor,
    mountRemoteUi: params.mountRemoteUi,
    unmountRemoteUi: params.unmountRemoteUi,
  });
  return { ...localControl, prepareProviderCliAttach };
}
