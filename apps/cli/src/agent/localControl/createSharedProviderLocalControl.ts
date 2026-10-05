import { createAgentLocalControlState } from '@/agent/localControl/createAgentLocalControlState';
import { createLocalRemoteModeController } from '@/agent/localControl/createLocalRemoteModeController';
import { resolveSwitchRequestTarget } from '@/agent/localControl/switchRequestTarget';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { SessionProviderCliAttachPrepareRequestV1 } from '@happier-dev/protocol';

import type { AttachedTerminalSupervisor } from './createAttachedTerminalSupervisor';

type Mode = 'local' | 'remote';

export function createSharedProviderLocalControl<TTarget>(params: Readonly<{
  supported: boolean;
  startingMode: Mode;
  getSession: () => ApiSessionClient | null;
  resolveTarget: () => Promise<TTarget | null> | TTarget | null;
  isSameTarget: (left: TTarget, right: TTarget) => boolean;
  supervisor: AttachedTerminalSupervisor<TTarget>;
  mountRemoteUi?: () => void;
  unmountRemoteUi?: () => Promise<void>;
}>): Readonly<{
  resolveKeepAliveMode: () => Mode;
  shouldRenderTerminalDisplay: () => boolean;
  onAfterStart: (options?: Readonly<{ canAttach: boolean }>) => Promise<void>;
  onSessionSwap: (session: ApiSessionClient) => Promise<void>;
  onTerminalExit: () => Promise<void>;
  switchToLocal: () => Promise<boolean>;
  observeTerminalClient: (observation: NonNullable<SessionProviderCliAttachPrepareRequestV1['terminalClient']>) => Promise<boolean>;
  dispose: () => Promise<void>;
}> {
  let currentMode: Mode = params.supported && params.startingMode === 'local' ? 'local' : 'remote';
  let attachedTarget: TTarget | null = null;
  let attaching: Readonly<{ purpose: 'attach' | 'observation'; session: ApiSessionClient;
    target: TTarget; completion: Promise<boolean> }> | null = null;

  const buildController = (session: ApiSessionClient) => createLocalRemoteModeController({
    session,
    getThinking: () => false,
    resolveLocalSwitchAvailability: async () => params.supported
      ? { ok: true }
      : { ok: false, reason: 'Local attachment is unavailable' },
    requestSwitchToLocalIfSupported: attachLocal,
    mountRemoteUi: params.mountRemoteUi ?? (() => undefined),
    unmountRemoteUi: params.unmountRemoteUi ?? (async () => undefined),
    setRemoteUiAllowsSwitchToLocal: () => undefined,
    buildAgentStateForMode: (currentState, nextMode) => ({
      ...currentState,
      controlledByUser: false,
      localControl: createAgentLocalControlState({
        attached: nextMode === 'local',
        topology: 'shared',
        canAttach: params.supported,
        canDetach: nextMode === 'local',
        remoteWritable: true,
      }),
    }),
  });

  const registerLocalSwitchHandler = (session: ApiSessionClient): void => {
    session.rpcHandlerManager.registerHandler('switch', async (requestParams: unknown) => {
      if (resolveSwitchRequestTarget(requestParams) === 'local') return true;
      return await detachLocal();
    });
  };

  const publishCurrentMode = async (session: ApiSessionClient): Promise<void> => {
    const controller = buildController(session);
    await controller.publishModeState(currentMode);
    if (currentMode === 'local') registerLocalSwitchHandler(session);
    else controller.registerRemoteSwitchHandler();
  };

  async function attachLocal(): Promise<boolean> {
    if (!params.supported) return false;
    const session = params.getSession();
    const target = await params.resolveTarget();
    if (!session || !target) return false;
    const pending = attaching;
    if (pending) {
      if (pending.purpose === 'attach' && pending.session === session && params.isSameTarget(pending.target, target)) return await pending.completion;
      await pending.completion;
      // Re-resolve preparation/identity after the preceding client has been admitted.
      return await attachLocal();
    }
    const completion = performAttachLocal(session, target).finally(() => {
      if (attaching?.completion === completion) attaching = null;
    });
    attaching = { purpose: 'attach', session, target, completion };
    return await completion;
  }

  async function performAttachLocal(session: ApiSessionClient, target: TTarget): Promise<boolean> {
    if (params.supervisor.isAttached() && attachedTarget && !params.isSameTarget(attachedTarget, target)) {
      await params.supervisor.detach();
      attachedTarget = null;
    }
    const attached = await params.supervisor.attach(target);
    if (!attached) return false;
    attachedTarget = target;
    currentMode = 'local';
    await buildController(session).publishModeState('local');
    registerLocalSwitchHandler(session);
    return true;
  }

  async function detachLocal(): Promise<boolean> {
    // A known physical presenter must be retired before its receipt waiter can settle.
    if (attaching) await params.supervisor.detach();
    await attaching?.completion;
    const session = params.getSession();
    if (!session) return false;
    await params.supervisor.detach();
    attachedTarget = null;
    currentMode = 'remote';
    await publishCurrentMode(session);
    return true;
  }

  async function observeTerminalClient(observation: NonNullable<SessionProviderCliAttachPrepareRequestV1['terminalClient']>): Promise<boolean> {
    // An actual foreground client proves its own terminal; controller TTY
    // availability governs creating a presentation, not admitting this client.
    if (!params.supervisor.observeTerminalClient) return false;
    const session = params.getSession();
    const target = await params.resolveTarget();
    if (!session || !target) return false;
    if (attaching) {
      await attaching.completion;
      return await observeTerminalClient(observation);
    }
    const isStillCurrent = async () => {
      const currentTarget = await params.resolveTarget();
      return params.getSession() === session && currentTarget !== null && params.isSameTarget(target, currentTarget);
    };
    const completion = (async () => {
      if (!await params.supervisor.observeTerminalClient!(target, observation, isStillCurrent)) return false;
      if (!await isStillCurrent()) return false;
      attachedTarget = observation.attached ? target : null;
      currentMode = observation.attached ? 'local' : 'remote';
      await publishCurrentMode(session);
      return true;
    })().finally(() => {
      if (attaching?.completion === completion) attaching = null;
    });
    attaching = { purpose: 'observation', session, target, completion };
    return await completion;
  }

  return {
    resolveKeepAliveMode: () => currentMode,
    shouldRenderTerminalDisplay: () => currentMode === 'remote',
    onAfterStart: async (options) => {
      const session = params.getSession();
      if (!session) return;
      if (currentMode === 'local' && options?.canAttach !== false && await attachLocal()) return;
      currentMode = 'remote';
      await publishCurrentMode(session);
    },
    onSessionSwap: async (session) => {
      if (currentMode === 'local' && await attachLocal()) return;
      currentMode = 'remote';
      await publishCurrentMode(session);
    },
    onTerminalExit: async () => {
      attachedTarget = null;
      currentMode = 'remote';
      const session = params.getSession();
      if (session) await publishCurrentMode(session);
    },
    switchToLocal: attachLocal,
    observeTerminalClient,
    dispose: async () => {
      if (attaching) await params.supervisor.dispose();
      await attaching?.completion;
      attachedTarget = null;
      await params.supervisor.dispose();
    },
  };
}
