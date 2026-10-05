export type BrowserAudioRecorder = Readonly<{
  uri: string | null;
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
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

export function createBrowserAudioRecorder(): BrowserAudioRecorder {
  let uri: string | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let chunks: Blob[] = [];

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
      } catch (error) {
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
    },

    async stop() {
      const currentRecorder = mediaRecorder;
      const currentStream = mediaStream;
      if (!currentRecorder) {
        throw new Error('web_audio_recorder_not_prepared');
      }

      try {
        const blob = await new Promise<Blob>((resolve, reject) => {
          const cleanup = () => {
            currentRecorder.removeEventListener('stop', onStop);
            currentRecorder.removeEventListener('error', onError);
          };
          const onStop = () => {
            cleanup();
            resolve(
              new Blob(chunks, {
                type: currentRecorder.mimeType || chunks[0]?.type || 'audio/webm',
              }),
            );
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

        uri = URL.createObjectURL(blob);
      } finally {
        currentStream?.getTracks().forEach((track) => track.stop());
        mediaRecorder = null;
        mediaStream = null;
      }
    },
  };
}
