import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { getLocalVoiceState, markLocalVoiceDeviceFallback } from '@/voice/local/localVoiceState';
import { isVoiceServiceUnavailableError } from '@/voice/runtime/voiceServiceUnavailable';
import { speakWithDeviceTts, speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';

export async function speakAssistantText(params: {
  text: string;
  settings: any;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) throw Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
  const trimmed = params.text.trim();
  if (!trimmed) return;

  const { config: adapter } = resolveLocalVoiceAdapterSettings(params.settings);

  const tts = VoiceLocalTtsSchema.parse(adapter?.tts ?? {});
  const sessionId = getLocalVoiceState().sessionId;
  const context = {
    text: trimmed,
    settings: params.settings,
    tts,
    networkTimeoutMs: params.networkTimeoutMs,
    signal: params.signal,
    registerPlaybackStopper: (stop: () => void) => {
      if (params.signal?.aborted) { stop(); return () => {}; }
      let stopped = false;
      let clear = () => {};
      const stopOnce = () => {
        if (stopped) return;
        stopped = true;
        clear();
        stop();
      };
      clear = params.registerPlaybackStopper(stopOnce);
      params.signal?.addEventListener('abort', stopOnce, { once: true });
      return () => {
        params.signal?.removeEventListener('abort', stopOnce);
        clear();
      };
    },
    onSpeaking: params.signal ? () => { if (!params.signal?.aborted) params.onSpeaking(); } : params.onSpeaking,
  };
  try {
    const current = getLocalVoiceState();
    if (sessionId && current.sessionId === sessionId && current.deviceFallback?.tts) await speakWithDeviceTts({ ...context, preferLocalVoice: true, language: params.settings?.voice?.assistantLanguage });
    else await speakWithLocalTtsProvider(context);
  } catch (error) {
    if (params.signal?.aborted || tts.provider !== 'openai_compat' || !tts.fallbackToDevice || !isVoiceServiceUnavailableError(error)) throw error;
    if (sessionId) markLocalVoiceDeviceFallback(sessionId, 'tts');
    await speakWithDeviceTts({ ...context, preferLocalVoice: true, language: params.settings?.voice?.assistantLanguage });
  }
}
