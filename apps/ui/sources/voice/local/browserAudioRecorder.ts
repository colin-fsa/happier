import { computeTurnEndpointDelayMs, normalizeTurnEndpointPolicy, type TurnEndpointPolicy } from '../input/TurnEndpointDetector';

export type BrowserAudioRecorder = Readonly<{
  uri: string | null;
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  dispose: () => void;
}>;

const PREFERRED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

function resolveSupportedRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  for (const mimeType of PREFERRED_RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return null;
}

export function createBrowserAudioRecorder(options?: Readonly<{
  endpointing: TurnEndpointPolicy;
  audioContext: AudioContext | null;
  onSpeechEnded: () => void;
  onError?: (error: Error) => void;
}>): BrowserAudioRecorder {
  let uri: string | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let disposed = false;
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let frame: number | null = null;
  const stopMonitoring = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    source?.disconnect();
    analyser?.disconnect();
    source = null;
    analyser = null;
    // The playback owner primes and owns the shared context; capture owns only its nodes.
    audioContext = null;
  };

  return {
    get uri() {
      return uri;
    },

    async prepareToRecordAsync() {
      if (
        typeof navigator === 'undefined'
        || !navigator.mediaDevices
        || typeof navigator.mediaDevices.getUserMedia !== 'function'
        || typeof MediaRecorder === 'undefined'
      ) {
        throw new Error('web_audio_recording_unavailable');
      }

      const nextStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed) {
        nextStream.getTracks().forEach((track) => track.stop());
        throw new Error('web_audio_recording_cancelled');
      }
      try {
        const mimeType = resolveSupportedRecordingMimeType();
        const nextRecorder = mimeType
          ? new MediaRecorder(nextStream, { mimeType })
          : new MediaRecorder(nextStream);

        chunks = [];
        nextRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        });

        mediaStream = nextStream;
        mediaRecorder = nextRecorder;
        nextRecorder.addEventListener('error', () => {
          stopMonitoring();
          options?.onError?.(new Error('web_audio_recording_failed'));
        });
        if (options) {
          audioContext = options.audioContext;
          if (!audioContext) throw new Error('web_audio_recording_unavailable');
          source = audioContext.createMediaStreamSource(nextStream);
          analyser = audioContext.createAnalyser();
          source.connect(analyser);
          await audioContext.resume();
          if (disposed) throw new Error('web_audio_recording_cancelled');
        }
      } catch (error) {
        stopMonitoring();
        nextStream.getTracks().forEach((track) => track.stop());
        throw error;
      }
    },

    record() {
      if (!mediaRecorder) {
        throw new Error('web_audio_recorder_not_prepared');
      }
      chunks = [];
      mediaRecorder.start();
      if (options && analyser) {
        const policy = normalizeTurnEndpointPolicy(options.endpointing);
        const samples = new Float32Array(analyser.fftSize);
        let speechStartedAt: number | null = null;
        let lastSpeechAt = 0;
        // -50 dBFS is the browser speech activity sensitivity used by Hark.
        // This detects activity, not words; the configured STT remains authoritative.
        // Record before detection so the beginning of quiet/gradual speech is retained.
        const speechRms = 10 ** (-50 / 20);
        const monitor = (now: number) => {
          frame = null;
          if (!analyser || disposed) return;
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const active = Math.sqrt(sum / samples.length) >= speechRms;
          if (active) {
            speechStartedAt ??= now;
            lastSpeechAt = now;
          } else if (speechStartedAt !== null
            && now - lastSpeechAt >= computeTurnEndpointDelayMs(policy, lastSpeechAt - speechStartedAt)) {
            options.onSpeechEnded();
            return;
          }
          frame = requestAnimationFrame(monitor);
        };
        frame = requestAnimationFrame(monitor);
      }
    },

    async stop() {
      stopMonitoring();
      const currentRecorder = mediaRecorder;
      const currentStream = mediaStream;
      if (!currentRecorder) {
        throw new Error('web_audio_recorder_not_prepared');
      }

      try {
        const createBlob = () => new Blob(chunks, {
          type: currentRecorder.mimeType || chunks[0]?.type || 'audio/webm',
        });
        const blob = await new Promise<Blob>((resolve, reject) => {
          // A failed start or an ended microphone may already be inactive.
          // MediaRecorder.stop() then emits no event.
          if (currentRecorder.state === 'inactive') {
            resolve(createBlob());
            return;
          }
          const cleanup = () => {
            currentRecorder.removeEventListener('stop', onStop);
            currentRecorder.removeEventListener('error', onError);
          };
          const onStop = () => {
            cleanup();
            resolve(createBlob());
          };
          const onError = (event: Event) => {
            cleanup();
            const recorderError = (event as Event & { error?: unknown }).error;
            reject(recorderError instanceof Error ? recorderError : new Error('web_audio_recording_failed'));
          };

          currentRecorder.addEventListener('stop', onStop, { once: true });
          currentRecorder.addEventListener('error', onError, { once: true });
          currentRecorder.stop();
        });

        if (blob.size > 0) uri = URL.createObjectURL(blob);
      } finally {
        currentStream?.getTracks().forEach((track) => track.stop());
        mediaRecorder = null;
        mediaStream = null;
      }
    },

    dispose() {
      disposed = true;
      stopMonitoring();
      if (uri) URL.revokeObjectURL(uri);
      uri = null;
      chunks = [];
      mediaStream?.getTracks().forEach((track) => track.stop());
      mediaRecorder = null;
      mediaStream = null;
    },
  };
}
