import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { computeTurnEndpointDelayMs, normalizeTurnEndpointPolicy } from '@/voice/input/TurnEndpointDetector';
import { resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { Platform } from 'react-native';

type DeviceSttStatePatch = {
  status?: 'connecting' | 'idle' | 'recording' | 'transcribing' | 'sending' | 'speaking' | 'error';
  sessionId?: string | null;
  error?: string | null;
};

type DeviceSttHandle = {
  sessionId: string;
  transcript: string;
  pendingAutoStop: boolean;
  stopping: boolean;
  startedAt: number;
  autoStopTimer: ReturnType<typeof setTimeout> | null;
  module: any;
  resolveEnd: () => void;
  resolveReady: () => void;
  endPromise: Promise<void>;
  subscriptions: { remove(): void }[];
};

export type DeviceSttController = Readonly<{
  clearHandsFreeSession: (sessionId?: string) => void;
  isHandsFreeSession: (sessionId: string) => boolean;
  start: (sessionId: string, options?: Readonly<{ preferOnDevice?: boolean }>) => Promise<void>;
  stop: (sessionId: string) => Promise<string>;
  setHandsFreeSession: (sessionId: string | null) => void;
}>;

export function createDeviceSttController(deps: {
  setState: (patch: DeviceSttStatePatch) => void;
  getSettings: () => any;
  canAutoStopTurn: (sessionId: string) => boolean;
  onAutoStopTurn: (sessionId: string) => void;
}): DeviceSttController {
  let handle: DeviceSttHandle | null = null;
  let handsFreeSessionId: string | null = null;
  let pendingStart: { sessionId: string } | null = null;

  const isDomRuntime = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined';

  const isHandsFreeCaptureEnabled = (): boolean => {
    const { config } = resolveLocalVoiceAdapterSettings(deps.getSettings());
    return handsFreeSessionId !== null && config?.handsFree?.enabled === true;
  };

  const clearHandleTimer = () => {
    if (!handle?.autoStopTimer) return;
    clearTimeout(handle.autoStopTimer);
    handle.autoStopTimer = null;
  };

  const scheduleHandsFreeStop = (sessionId: string, expectedHandle: DeviceSttHandle) => {
    if (expectedHandle.autoStopTimer) {
      clearTimeout(expectedHandle.autoStopTimer);
      expectedHandle.autoStopTimer = null;
    }

    const { config: adapter } = resolveLocalVoiceAdapterSettings(deps.getSettings());
    const policy = normalizeTurnEndpointPolicy({
      silenceMs: adapter?.handsFree?.endpointing?.silenceMs ?? 450,
      minSpeechMs: adapter?.handsFree?.endpointing?.minSpeechMs ?? 120,
    });
    const elapsedMs = Date.now() - expectedHandle.startedAt;
    const waitMs = computeTurnEndpointDelayMs(policy, elapsedMs);

    const triggerStop = () => {
      expectedHandle.autoStopTimer = null;
      if (!handle || handle !== expectedHandle || handle.sessionId !== sessionId) return;
      if (!isHandsFreeCaptureEnabled()) return;
      if (handsFreeSessionId !== sessionId) return;
      if (!deps.canAutoStopTurn(sessionId)) return;
      deps.onAutoStopTurn(sessionId);
    };

    if (waitMs <= 0) {
      queueMicrotask(triggerStop);
      return;
    }

    expectedHandle.autoStopTimer = setTimeout(triggerStop, waitMs);
  };

  const cleanupListeners = () => {
    const subscriptions = handle?.subscriptions ?? [];
    try {
      subscriptions.forEach((subscription) => subscription.remove());
    } catch {
      // ignore
    }
  };

  const clearHandsFreeSession = (sessionId?: string) => {
    if (sessionId && handsFreeSessionId && handsFreeSessionId !== sessionId) {
      return;
    }
    handsFreeSessionId = null;
  };

  const start = async (sessionId: string, options?: Readonly<{ preferOnDevice?: boolean }>) => {
    const startup = { sessionId };
    pendingStart = startup;
    const previous = handle;
    if (previous) {
      clearHandleTimer();
      cleanupListeners();
      previous.resolveEnd();
      previous.resolveReady();
      handle = null;
      if (!previous.stopping) previous.module.abort?.();
    }
    deps.setState({ status: 'connecting', sessionId, error: null });
    const microphonePermission = await requestMicrophonePermission();
    if (pendingStart !== startup) return;
    if (!microphonePermission.granted) {
      pendingStart = null;
      deps.setState({ status: 'error', sessionId, error: 'device_stt_permission_denied' });
      showMicrophonePermissionDeniedAlert(microphonePermission.canAskAgain);
      return;
    }

    const { ExpoSpeechRecognitionModule, ExpoWebSpeechRecognition } = await import('expo-speech-recognition');
    if (pendingStart !== startup) return;

    if (typeof ExpoSpeechRecognitionModule?.isRecognitionAvailable === 'function' && !ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      pendingStart = null;
      deps.setState({ status: 'error', sessionId, error: 'device_stt_unavailable' });
      return;
    }

    // `expo-speech-recognition` logs noisy "not supported on web" warnings for this call.
    // Prefer DOM detection over Platform.OS so web builds remain resilient even if Platform.OS is surprising.
    if (Platform.OS !== 'web' && !isDomRuntime()) {
      try {
        const permissionsResponse = await ExpoSpeechRecognitionModule.requestPermissionsAsync?.();
        if (pendingStart !== startup) return;
        if (permissionsResponse && permissionsResponse.granted === false) {
          pendingStart = null;
          deps.setState({ status: 'error', sessionId, error: 'device_stt_permission_denied' });
          return;
        }
      } catch (error) {
        if (pendingStart !== startup) return;
        pendingStart = null;
        deps.setState({ status: 'error', sessionId, error: 'device_stt_permission_failed' });
        throw error;
      }
    }

    const settings = deps.getSettings();
    const language = typeof settings?.voice?.assistantLanguage === 'string' && settings.voice.assistantLanguage.trim()
      ? settings.voice.assistantLanguage.trim()
      : undefined;

    let requiresOnDeviceRecognition = false;
    if (options?.preferOnDevice && Platform.OS === 'web') {
      // The SDK exports the native browser constructor; newer Web Speech APIs
      // expose this optional capability outside the SDK's current type surface.
      const recognizer: unknown = ExpoWebSpeechRecognition;
      if (recognizer && (typeof recognizer === 'function' || typeof recognizer === 'object') && 'available' in recognizer && typeof recognizer.available === 'function') {
        try {
          const availability: unknown = await recognizer.available({ langs: [language ?? 'en-US'], processLocally: true });
          requiresOnDeviceRecognition = availability === 'available';
        } catch (error) {
          if (pendingStart !== startup) return;
          pendingStart = null;
          deps.setState({ status: 'error', sessionId, error: 'device_stt_local_capability_failed' });
          throw error;
        }
      }
    }

    if (pendingStart !== startup) return;
    pendingStart = null;
    clearHandleTimer();
    cleanupListeners();

    let resolveEnd: null | (() => void) = null;
    const endPromise = new Promise<void>((resolve) => {
      resolveEnd = resolve;
    });

    let resolveReady = () => {};
    const readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });

    const nextHandle: DeviceSttHandle = {
      sessionId,
      transcript: '',
      pendingAutoStop: false,
      stopping: false,
      startedAt: Date.now(),
      autoStopTimer: null,
      module: ExpoSpeechRecognitionModule,
      resolveEnd: () => resolveEnd?.(),
      resolveReady,
      endPromise,
      subscriptions: [],
    };

    handle = nextHandle;


    const startRecognition = () => {
      ExpoSpeechRecognitionModule.start({
        ...(language ? { lang: language } : {}),
        interimResults: true,
        maxAlternatives: 1,
        continuous: true,
        ...(requiresOnDeviceRecognition ? { requiresOnDeviceRecognition: true } : {}),
      } as any);
    };
    try {
      // SDK 3.1 attaches new web listeners to its previous recognizer until start()
      // replaces it. Subscribe after replacement so old end/error events cannot
      // terminate this capture. Native SDKs require listeners before start().
      if (Platform.OS === 'web') startRecognition();
      nextHandle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('start', () => {
          if (handle !== nextHandle || nextHandle.stopping) return;
          nextHandle.startedAt = Date.now();
          deps.setState({ status: 'recording', sessionId, error: null });
          nextHandle.resolveReady();
        })
      );

      nextHandle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
          if (handle !== nextHandle) return;
          const results = Array.isArray(event?.results) ? event.results : [];
          const transcript = typeof results?.[0]?.transcript === 'string' ? results[0].transcript.trim() : '';
          if (!transcript) return;

          nextHandle.transcript = transcript;
          clearHandleTimer();
          nextHandle.pendingAutoStop = false;
          if (event?.isFinal && isHandsFreeCaptureEnabled()) {
            nextHandle.pendingAutoStop = true;
            scheduleHandsFreeStop(sessionId, nextHandle);
          }

        })
      );

      nextHandle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('end', () => {
          nextHandle.resolveEnd();
          nextHandle.resolveReady();
          if (handle !== nextHandle || nextHandle.stopping) return;
          if (nextHandle.pendingAutoStop) {
            deps.setState({ status: 'transcribing', sessionId, error: null });
            if (deps.canAutoStopTurn(sessionId)) {
              clearHandleTimer();
              deps.onAutoStopTurn(sessionId);
            }
            return;
          }
          cleanupListeners();
          handle = null;
          clearHandsFreeSession(sessionId);
          deps.setState({ status: 'error', sessionId, error: 'device_stt_ended' });
        })
      );

      nextHandle.subscriptions.push(
        ExpoSpeechRecognitionModule.addListener('error', (event: unknown) => {
          nextHandle.resolveEnd();
          nextHandle.resolveReady();
          if (handle !== nextHandle) return;
          clearHandleTimer();
          cleanupListeners();
          handle = null;
          clearHandsFreeSession(sessionId);
          const code = event && typeof event === 'object' && 'error' in event && typeof event.error === 'string' ? event.error : 'failed';
          deps.setState({ status: 'error', sessionId, error: `device_stt_${code}` });
        })
      );

      if (Platform.OS !== 'web') startRecognition();
    } catch (error) {
      cleanupListeners();
      nextHandle.resolveEnd();
      handle = null;
      deps.setState({ status: 'idle', sessionId: null, error: 'device_stt_start_failed' });
      throw error;
    }

    await readyPromise;
  };

  const stop = async (sessionId: string): Promise<string> => {
    if (pendingStart?.sessionId === sessionId) pendingStart = null;
    const stoppingHandle = handle;
    if (!stoppingHandle || stoppingHandle.sessionId !== sessionId) return '';
    clearHandleTimer();
    stoppingHandle.stopping = true;
    stoppingHandle.resolveReady();
    try {
      stoppingHandle.module?.stop?.();
    } catch {
      stoppingHandle.resolveEnd();
    }
    let endTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stoppingHandle.endPromise, new Promise<void>((resolve) => { endTimeout = setTimeout(resolve, 5_000); })]);
    } finally {
      if (endTimeout !== undefined) clearTimeout(endTimeout);
    }
    const text = stoppingHandle.transcript.trim();
    if (handle === stoppingHandle) handle = null;
    if (stoppingHandle.autoStopTimer) clearTimeout(stoppingHandle.autoStopTimer);
    stoppingHandle.subscriptions.forEach((subscription) => subscription.remove());

    return text;
  };

  return {
    clearHandsFreeSession,
    isHandsFreeSession: (sessionId: string) => handsFreeSessionId === sessionId,
    setHandsFreeSession: (sessionId: string | null) => {
      handsFreeSessionId = sessionId;
    },
    start,
    stop,
  };
}
