import {
  abortLocalVoiceTurn,
  stopLocalVoiceSession,
  toggleLocalVoiceTurn,
} from '@/voice/local/localVoiceEngine';
import { getLocalVoiceSessionSnapshot, subscribeLocalVoiceState } from '@/voice/local/localVoiceState';
import type { VoiceAdapterController } from '@/voice/session/types';

export function createLocalDirectVoiceAdapter(): VoiceAdapterController {
  const id = 'local_direct';

  const getSnapshot = () => getLocalVoiceSessionSnapshot(id);
  let pendingStart: object | null = null;

  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    const attempt = {};
    pendingStart = attempt;
    try {
      const snap = getSnapshot();
      if (snap.sessionId && snap.sessionId !== opts.sessionId && snap.status !== 'disconnected') {
        await stopLocalVoiceSession();
      }
      if (pendingStart !== attempt) return;
      await toggleLocalVoiceTurn(opts.sessionId);
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
    await abortLocalVoiceTurn(opts.sessionId);
  };

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    sendContextUpdate: () => {},
    getSnapshot,
    subscribe: (listener) => subscribeLocalVoiceState(listener),
  };
}
