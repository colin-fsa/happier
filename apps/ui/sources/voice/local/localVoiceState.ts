import { create } from 'zustand';
import type { VoiceAdapterId, VoiceSessionMode, VoiceSessionSnapshot } from '@/voice/session/types';

export type LocalVoiceStatus = 'connecting' | 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';

export type LocalVoiceState = {
  status: LocalVoiceStatus;
  sessionId: string | null;
  error: string | null;
};

const useLocalVoiceStore = create<LocalVoiceState>(() => ({
  status: 'idle',
  sessionId: null,
  error: null,
}));

export function getLocalVoiceState(): LocalVoiceState {
  return useLocalVoiceStore.getState();
}

const SESSION_MODES = {
  idle: 'idle',
  connecting: 'idle',
  recording: 'listening',
  transcribing: 'transcribing',
  sending: 'thinking',
  speaking: 'speaking',
  error: 'idle',
} satisfies Record<LocalVoiceStatus, VoiceSessionMode>;

export function getLocalVoiceSessionSnapshot(adapterId: VoiceAdapterId): VoiceSessionSnapshot {
  const local = getLocalVoiceState();
  const status = local.error
    ? 'error'
    : local.status === 'connecting'
    ? 'connecting'
    : local.status === 'error'
      ? 'error'
      : local.status === 'idle' && !local.sessionId ? 'disconnected' : 'connected';
  return {
    adapterId,
    sessionId: local.sessionId,
    status,
    mode: SESSION_MODES[local.status],
    canStop: local.sessionId !== null && status !== 'disconnected',
    ...(local.error ? { errorCode: local.error, errorMessage: local.error } : {}),
  };
}

export const useLocalVoiceStatus = () => useLocalVoiceStore((state) => state.status);

export function subscribeLocalVoiceState(listener: () => void): () => void {
  return useLocalVoiceStore.subscribe(() => listener());
}

export function patchLocalVoiceState(patch: Partial<LocalVoiceState>): void {
  useLocalVoiceStore.setState((state) => {
    const next = { ...state, ...patch };
    if (state.status === next.status && state.sessionId === next.sessionId && state.error === next.error) {
      return state;
    }
    return next;
  });
}

export function setIdleStateUnlessRecording(sessionId: string): void {
  const current = getLocalVoiceState();
  if (current.status === 'recording' && current.sessionId === sessionId) {
    return;
  }
  // A completed voice turn returns to an idle (ready) state, but we keep the active sessionId
  // until the user explicitly hangs up.
  // Preserve any existing error so the UI can surface it until the user retries.
  patchLocalVoiceState({ status: 'idle', sessionId });
}

