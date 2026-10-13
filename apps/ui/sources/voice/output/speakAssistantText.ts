import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';

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

  const voice = params.settings?.voice ?? null;
  const providerId = voice?.providerId;
  const adapter =
    providerId === 'local_direct'
      ? voice?.adapters?.local_direct
      : voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct;

  const tts = VoiceLocalTtsSchema.parse(adapter?.tts ?? {});
  await speakWithLocalTtsProvider({
    text: trimmed,
    settings: params.settings,
    tts,
    networkTimeoutMs: params.networkTimeoutMs,
    signal: params.signal,
    registerPlaybackStopper: (stop) => {
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
  });
}
