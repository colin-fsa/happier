import {
  appendLocalVoiceAgentContextUpdate,
  abortLocalVoiceTurn,
  stopLocalVoiceSession,
  toggleLocalVoiceTurn,
} from '@/voice/local/localVoiceEngine';
import { sendVoiceTextTurn } from '@/voice/local/sendVoiceTextTurn';
import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { getLocalVoiceSessionSnapshot, getLocalVoiceState, patchLocalVoiceState, subscribeLocalVoiceState } from '@/voice/local/localVoiceState';
import type { VoiceAdapterController } from '@/voice/session/types';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

export function createLocalConversationVoiceAdapter(): VoiceAdapterController {
  const id = 'local_conversation';

  const resolveConversationSessionId = (sessionId: string): string => {
    const settings: any = storage.getState().settings;
    const mode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    return mode === 'agent' ? VOICE_AGENT_GLOBAL_SESSION_ID : sessionId;
  };

  const getSnapshot = () => getLocalVoiceSessionSnapshot(id);
  let pendingStart: object | null = null;

  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    const settings: any = storage.getState().settings;
    const mode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    const startSessionId = String(opts.sessionId ?? '').trim();

    const resolvedSessionId = mode === 'agent' ? VOICE_AGENT_GLOBAL_SESSION_ID : opts.sessionId;
    const attempt = {};
    pendingStart = attempt;
    try {
      if (mode === 'agent') {
        if (!getSnapshot().canStop) {
          patchLocalVoiceState({ status: 'connecting', sessionId: resolvedSessionId, error: null });
        }
        const binding = await voiceSessionBindingManager.ensureBound({
          adapterId: id,
          controlSessionId: resolvedSessionId,
          requestedTargetSessionId: startSessionId || null,
        });
        if (pendingStart !== attempt) return;
        if (!binding?.conversationSessionId || binding.controlSessionId !== resolvedSessionId) {
          throw Object.assign(new Error('voice_session_binding_required'), {
            code: 'VOICE_SESSION_BINDING_REQUIRED',
          });
        }
      }
      const snap = getSnapshot();
      if (snap.sessionId && snap.sessionId !== resolvedSessionId && snap.status !== 'disconnected') {
        await stopLocalVoiceSession();
      }
      if (pendingStart !== attempt) return;
      await toggleLocalVoiceTurn(resolvedSessionId);
    } catch (error) {
      if (pendingStart !== attempt) return;
      const local = getLocalVoiceState();
      patchLocalVoiceState({
        status: local.status === 'connecting' || local.status === 'idle' || local.status === 'error' ? 'error' : local.status,
        sessionId: local.status === 'connecting' && local.sessionId === resolvedSessionId ? null : local.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (pendingStart === attempt) pendingStart = null;
    }
  };

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    const snap = getSnapshot();
    if (snap.status !== 'disconnected') return;
    await toggle({ sessionId: opts.sessionId });
  };

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    pendingStart = null;
    await stopLocalVoiceSession();
  };

  const interrupt = async (opts: Readonly<{ sessionId: string }>) => {
    await abortLocalVoiceTurn(resolveConversationSessionId(opts.sessionId));
  };

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    appendLocalVoiceAgentContextUpdate(resolveConversationSessionId(opts.sessionId), opts.update);
  };

  const sendTextTurn: NonNullable<VoiceAdapterController['sendTextTurn']> = async (opts) => {
    const settings: any = storage.getState().settings;
    const config = settings?.voice?.adapters?.local_conversation ?? {};
    if ((config?.conversationMode ?? 'direct_session') !== 'agent') {
      throw new Error('voice_session_native_send_only');
    }

    await sendVoiceTextTurn({
      sessionId: opts.controlSessionId,
      settings,
      userText: opts.text,
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
      durableDispatch: {
        localId: opts.localId,
        handoffMode: opts.handoffMode,
      },
    });
  };

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    sendContextUpdate,
    sendTextTurn,
    getSnapshot,
    subscribe: (listener) => subscribeLocalVoiceState(listener),
  };
}
