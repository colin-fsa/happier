import { describe, expect, it } from 'vitest';

import {
  emitSpeechRecEvent,
  getStorage,
  registerLocalVoiceEngineHarnessHooks,
  submitMessage,
  speechRecStart,
  speechRecStop,
} from './localVoiceEngine.testHelpers';

describe('local voice engine stop', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('stops an in-progress recording turn without sending', async () => {
    const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');

    await stopLocalVoiceSession();
    expect(getLocalVoiceState().status).toBe('idle');
    expect(submitMessage).not.toHaveBeenCalled();
    expect((globalThis.fetch as any).mock.calls.length).toBe(0);
  });

  it('stops device STT recording without sending', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          adapters: {
            ...storage.getState().settings.voice.adapters,
            local_direct: {
              ...storage.getState().settings.voice.adapters.local_direct,
              stt: {
                ...storage.getState().settings.voice.adapters.local_direct.stt,
                useDeviceStt: true,
                baseUrl: null,
              },
              tts: {
                ...storage.getState().settings.voice.adapters.local_direct.tts,
                autoSpeakReplies: false,
              },
            },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(speechRecStart).toHaveBeenCalledTimes(1);

    const stopPromise = stopLocalVoiceSession();
    expect(speechRecStop).toHaveBeenCalledTimes(1);
    emitSpeechRecEvent('end', {});
    await stopPromise;

    expect(submitMessage).not.toHaveBeenCalled();
  });
});

