import { AudioModule, RecordingPresets } from 'expo-audio';
import { Platform } from 'react-native';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storage';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@/sync/runtime/rpcErrors';
import { createDeviceSttController } from '@/voice/input/DeviceSttController';
import { createSherpaStreamingSttController } from '@/voice/input/SherpaStreamingSttController';
import { MissingGeminiApiKeyError, MissingSttBaseUrlError, transcribeRecordedAudioWithProvider } from '@/voice/input/transcribeRecordedAudioWithProvider';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { findVoiceConversationSessionId } from '@/voice/sessionBinding/voiceConversationSession';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { getOrCreateWebAudioContext } from '@/voice/output/webAudioContext';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { voiceActivityController } from '@/voice/activity/voiceActivityController';
import { resetVoiceAgentPersistenceState } from '@/voice/persistence/resetVoiceAgentPersistenceState';
import { appendVoiceConversationAssistantText } from '@/voice/sessionBinding/voiceConversationTranscript';
import {
  resolveVoiceSessionBindingByControlSessionId,
  resolveVoiceSessionBindingByConversationSessionId,
} from '@/voice/sessionBinding/resolveVoiceSessionBinding';

import type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
import {
  getLocalVoiceState,
  patchLocalVoiceState,
} from './localVoiceState';
import {
  isHandsFreeDeviceSttEnabled,
  isHandsFreeLocalNeuralSttEnabled,
  isVoiceBargeInEnabled,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
  supportsLocalVoiceHandsFree,
} from './localVoiceSettings';
import { createBrowserAudioRecorder } from './browserAudioRecorder';
import { sendVoiceTextTurn as sendVoiceTextTurnImpl } from './sendVoiceTextTurn';

export type { LocalVoiceState, LocalVoiceStatus } from './localVoiceState';
export { getLocalVoiceState, useLocalVoiceStatus, subscribeLocalVoiceState } from './localVoiceState';

type LocalAudioRecorder = {
  uri: string | null;
  prepareToRecordAsync: () => Promise<void>;
  record: () => void;
  stop: () => Promise<void>;
  dispose?: () => void;
};

type AudioRecorderConstructor = new (options: unknown) => LocalAudioRecorder;

function createLocalAudioRecorder(sessionId: string): LocalAudioRecorder {
  if (Platform.OS === 'web') {
    const session = browserRecordingSession;
    const { config } = resolveLocalVoiceAdapterSettings(storage.getState().settings);
    return createBrowserAudioRecorder(session?.handsFree ? {
      endpointing: config.handsFree.endpointing,
      audioContext: getOrCreateWebAudioContext(),
      onSpeechEnded: () => {
        if (browserRecordingSession !== session || session.abortController.signal.aborted) return;
        const pending = trackInFlight(stopAndSendRecordedTurn(sessionId));
        fireAndForget(pending, { tag: 'localVoiceEngine.browserHandsFreeTurn' });
      },
      onError: () => {
        if (browserRecordingSession !== session) return;
        session.abortController.abort();
        recorder?.dispose?.();
        recorder = null;
        patchLocalVoiceState({ status: 'idle', sessionId, error: 'recording_stop_failed' });
      },
    } : undefined);
  }

  const Recorder = (AudioModule as unknown as { AudioRecorder?: AudioRecorderConstructor }).AudioRecorder;
  if (typeof Recorder !== 'function') {
    throw new Error('audio_recorder_unavailable');
  }
  return new Recorder(RecordingPresets.HIGH_QUALITY);
}

type BrowserRecordingSession = Readonly<{
  sessionId: string;
  handsFree: boolean;
  abortController: AbortController;
}>;
let browserRecordingSession: BrowserRecordingSession | null = null;
let recorder: LocalAudioRecorder | null = null;
let inFlight: Promise<void> | null = null;
function trackInFlight(operation: Promise<void>): Promise<void> {
  const pending = operation.finally(() => { if (inFlight === pending) inFlight = null; });
  inFlight = pending;
  return pending;
}
let activeTurnAbortController: AbortController | null = null;
let activeTurnAbortSessionId: string | null = null;

const playbackController = createVoicePlaybackController();
const deviceSttController = createDeviceSttController({
  setState: patchLocalVoiceState,
  getSettings: () => storage.getState().settings as any,
  canAutoStopTurn: () => !inFlight,
  onAutoStopTurn: (sessionId: string) => {
    if (inFlight) return;
    const pending = trackInFlight(stopDeviceSpeechRecognitionAndSend(sessionId));
    fireAndForget(pending, { tag: 'localVoiceEngine.deviceHandsFreeTurn' });
  },
});
const sherpaSttController = createSherpaStreamingSttController({
  setState: patchLocalVoiceState,
  getSettings: () => storage.getState().settings as any,
});

function isUnsupportedVoiceAgentPrewarmError(error: unknown): boolean {
  const carrier: RpcErrorCarrier =
    error && typeof error === 'object'
      ? (error as RpcErrorCarrier)
      : { message: typeof error === 'string' ? error : undefined };
  return isRpcMethodNotAvailableError(carrier) || isRpcMethodNotFoundError(carrier);
}

function isAbortedVoiceTurnError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof Error && error.message === 'turn_aborted';
}

async function runVoiceTurnWithSendFailureHandling(
  sessionId: string,
  settings: any,
  runner: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  try {
    await runAbortableVoiceTurn(sessionId, runner);
  } catch (error) {
    if (isAbortedVoiceTurnError(error)) {
      return;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: 'send_failed' });
    const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
    const shouldSwallowSendFailure = adapterId === 'local_conversation' && config?.conversationMode === 'agent';
    if (!shouldSwallowSendFailure) {
      throw error;
    }
    return;
  }
}

async function startRecording(sessionId: string): Promise<void> {
  const session = browserRecordingSession;
  if (session?.abortController.signal.aborted) return;
  const permission = await requestMicrophonePermission();
  if (session?.abortController.signal.aborted) return;
  if (!permission.granted) {
    showMicrophonePermissionDeniedAlert(permission.canAskAgain);
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: 'recording_start_failed' });
    return;
  }

  const nextRecorder = createLocalAudioRecorder(sessionId);
  recorder = nextRecorder;
  try {
    await nextRecorder.prepareToRecordAsync();
    if (session?.abortController.signal.aborted) {
      nextRecorder.dispose?.();
      if (recorder === nextRecorder) recorder = null;
      return;
    }
    nextRecorder.record();
    recorder = nextRecorder;
    patchLocalVoiceState({ status: 'recording', sessionId, error: null });
  } catch (error) {
    try {
      await nextRecorder.stop?.();
    } catch {
      // best-effort
    } finally {
      nextRecorder.dispose?.();
    }
    if (recorder === nextRecorder) recorder = null;
    if (session?.abortController.signal.aborted) return;
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: 'recording_start_failed' });
    throw error;
  }
}

async function stopAndSendRecordedTurn(sessionId: string): Promise<void> {
  const session = browserRecordingSession;
  const isCancelled = () => session?.abortController.signal.aborted === true;
  const resumeListening = async () => {
    if (session?.handsFree && browserRecordingSession === session && !isCancelled() && !getLocalVoiceState().error) {
      await startRecording(sessionId);
    }
  };
  if (!recorder) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  patchLocalVoiceState({ status: 'transcribing', error: null });
  const currentRecorder = recorder;
  let uri: string | null = null;
  try {
    await currentRecorder.stop();
    uri = currentRecorder.uri;
    if (isCancelled()) { currentRecorder.dispose?.(); return; }
  } catch {
    currentRecorder.dispose?.();
    if (recorder === currentRecorder) recorder = null;
    if (isCancelled()) return;
    patchLocalVoiceState({ status: 'idle', sessionId, error: 'recording_stop_failed' });
    return;
  }
  if (recorder === currentRecorder) recorder = null;

  if (!uri) {
    currentRecorder.dispose?.();
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const settings = storage.getState().settings as any;
  let text: string | null = null;
  try {
    text = await transcribeRecordedAudioWithProvider({ uri, settings, signal: session?.abortController.signal });
    if (isCancelled()) return;
  } catch (error) {
    if (isCancelled()) return;
    if (error instanceof MissingSttBaseUrlError) {
      patchLocalVoiceState({ status: 'idle', sessionId, error: 'missing_stt_base_url' });
      throw error;
    }
    if (error instanceof MissingGeminiApiKeyError) {
      patchLocalVoiceState({ status: 'idle', sessionId, error: 'missing_stt_api_key' });
      throw error;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: 'stt_failed' });
    return;
  } finally {
    currentRecorder.dispose?.();
  }

  if (!text) {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    await resumeListening();
    return;
  }

  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions,
      signal,
    }),
  );
  await resumeListening();
}

async function stopDeviceSpeechRecognitionAndSend(sessionId: string): Promise<void> {
  patchLocalVoiceState({ status: 'transcribing', error: null });

  const text = await deviceSttController.stop(sessionId);
  if (!text) {
    if (deviceSttController.isHandsFreeSession(sessionId) && isHandsFreeDeviceSttEnabled(storage.getState().settings)) {
      await deviceSttController.start(sessionId);
      return;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const settings = storage.getState().settings as any;
  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions,
      signal,
    }),
  );

  if (deviceSttController.isHandsFreeSession(sessionId) && isHandsFreeDeviceSttEnabled(storage.getState().settings)) {
    await deviceSttController.start(sessionId);
  }
}

async function stopSherpaSpeechRecognitionAndSend(sessionId: string): Promise<void> {
  patchLocalVoiceState({ status: 'transcribing', error: null });

  const text = await sherpaSttController.stop(sessionId);
  if (!text) {
    if (sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeLocalNeuralSttEnabled(storage.getState().settings)) {
      await sherpaSttController.start(sessionId);
      return;
    }
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
    return;
  }

  const settings = storage.getState().settings as any;
  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions,
      signal,
    }),
  );

  if (sherpaSttController.isHandsFreeSession(sessionId) && isHandsFreeLocalNeuralSttEnabled(storage.getState().settings)) {
    await sherpaSttController.start(sessionId);
  }
}

export async function stopLocalVoiceAgent(sessionId: string): Promise<void> {
  deviceSttController.clearHandsFreeSession(sessionId);
  sherpaSttController.clearHandsFreeSession(sessionId);
  await voiceAgentSessions.stop(sessionId);
}

export async function resetLocalVoiceAgentPersistence(): Promise<void> {
  await resetVoiceAgentPersistenceState({
    stop: async () => await stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID),
  });
}

export function isLocalVoiceAgentActive(sessionId: string): boolean {
  return voiceAgentSessions.isActive(sessionId);
}

export function appendLocalVoiceAgentContextUpdate(sessionId: string, update: string): void {
  voiceAgentSessions.appendContextUpdate(sessionId, update);
}

export function announceLocalVoiceAgentAssistantText(sessionId: string, text: string): void {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;

  voiceActivityController.appendAssistantText(sessionId, 'local_conversation', trimmed);

  const binding =
    resolveVoiceSessionBindingByControlSessionId({ controlSessionId: sessionId })
    ?? resolveVoiceSessionBindingByConversationSessionId({ conversationSessionId: sessionId })
    ?? null;
  const conversationSessionId = typeof binding?.conversationSessionId === 'string' ? binding.conversationSessionId.trim() : '';
  if (!conversationSessionId) return;

  appendVoiceConversationAssistantText({
    conversationSessionId,
    text: trimmed,
  });
}

export async function sendLocalVoiceAgentTextUpdate(sessionId: string, update: string): Promise<void> {
  const text = update.trim();
  if (!text) return;

  const settings = storage.getState().settings as any;
  await runVoiceTurnWithSendFailureHandling(sessionId, settings, (signal) =>
    sendVoiceTextTurnImpl({
      sessionId,
      settings,
      userText: text,
      playbackController,
      voiceAgentSessions: {
        sendTurn: (nextSessionId, userText, opts) =>
          voiceAgentSessions.sendInterruptingTextUpdate(nextSessionId, userText, opts),
      },
      signal,
    }),
  );
}

async function runAbortableVoiceTurn(sessionId: string, runner: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  if (activeTurnAbortController) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
  }
  activeTurnAbortController = controller;
  activeTurnAbortSessionId = sessionId;
  try {
    await runner(controller.signal);
  } finally {
    if (activeTurnAbortController === controller) {
      activeTurnAbortController = null;
      activeTurnAbortSessionId = null;
    }
  }
}

export async function abortLocalVoiceTurn(sessionId: string): Promise<void> {
  const current = getLocalVoiceState();
  if (!current.sessionId) return;
  if (current.sessionId !== sessionId) return;

  const previousSession = browserRecordingSession;
  if (previousSession) inFlight = null;
  previousSession?.abortController.abort();
  browserRecordingSession = null;
  const cancelledRecorder = previousSession ? recorder : null;
  if (previousSession) recorder = null;
  cancelledRecorder?.dispose?.();
  playbackController.interrupt();
  if (activeTurnAbortController && activeTurnAbortSessionId === sessionId) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
  }

  const { config } = resolveLocalVoiceAdapterSettings(storage.getState().settings);
  if (previousSession?.handsFree && config?.handsFree?.enabled === true) {
    browserRecordingSession = { ...previousSession, abortController: new AbortController() };
    patchLocalVoiceState({ status: 'connecting', sessionId, error: null });
    await trackInFlight(startRecording(sessionId));
  } else {
    patchLocalVoiceState({ status: 'idle', sessionId, error: null });
  }
}

export async function toggleLocalVoiceTurn(sessionId: string): Promise<void> {
  const realtimeStatus = (storage.getState() as any)?.realtimeStatus;
  if (realtimeStatus === 'connected' || realtimeStatus === 'connecting') {
    // Avoid audio-session conflicts: local voice should not start while a realtime call is active.
    return;
  }

  const initialState = getLocalVoiceState();
  const canAttemptBargeIn =
    initialState.status === 'speaking' && initialState.sessionId === sessionId && isVoiceBargeInEnabled(storage.getState().settings);
  const shouldNoopWhileSpeaking =
    initialState.status === 'speaking' && initialState.sessionId === sessionId && !isVoiceBargeInEnabled(storage.getState().settings);

  if (shouldNoopWhileSpeaking) {
    return;
  }

  if (inFlight && !canAttemptBargeIn) {
    await inFlight;
    if (!initialState.error) return;
  }

  const current = getLocalVoiceState();
  const prewarmLocalVoiceAgentOnConnect = async (params: Readonly<{ settings: any; config: any; signal?: AbortSignal }>): Promise<void> => {
    const { config } = params;
    if (config?.conversationMode !== 'agent' || config?.agent?.prewarmOnConnect !== true) return;

    try {
      const networkTimeoutMs = resolveVoiceNetworkTimeoutMs(config?.networkTimeoutMs, 15_000);
      const welcomeMode = config?.agent?.welcome?.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
      const welcomeEnabled = config?.agent?.welcome?.enabled === true;
      const canSpeakWelcome = config?.tts?.autoSpeakReplies !== false;

      if (welcomeEnabled && welcomeMode === 'immediate' && canSpeakWelcome) {
        const assistantText = await voiceAgentSessions.ensureRunningAndMaybeWelcome(sessionId);
        if (params.signal?.aborted) return;
        const text = typeof assistantText === 'string' ? assistantText.trim() : '';
        if (text) {
          voiceActivityController.appendAssistantText(sessionId, 'local_conversation', text);
          await speakAssistantText({
            text,
            settings: params.settings,
            networkTimeoutMs,
            signal: params.signal,
            registerPlaybackStopper: playbackController.registerStopper,
            onSpeaking: () => patchLocalVoiceState({ status: 'speaking' }),
          });
        }
        return;
      }

      await voiceAgentSessions.ensureRunning(sessionId);
    } catch (error) {
      if (isUnsupportedVoiceAgentPrewarmError(error)) return;
      throw error;
    }
  };

  if (current.status === 'speaking') {
    if (current.sessionId !== sessionId || !isVoiceBargeInEnabled(storage.getState().settings)) return;
    browserRecordingSession?.abortController.abort();
    if (activeTurnAbortSessionId === sessionId) activeTurnAbortController?.abort();
    playbackController.interrupt();
    if (inFlight) await inFlight.catch(() => {});
  }

  const isPendingOrFailedStart = (current.status === 'connecting' || current.status === 'error')
    && (current.sessionId === null || current.sessionId === sessionId);
  if (current.status === 'idle' || current.status === 'speaking' || isPendingOrFailedStart) {
    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);

    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    deviceSttController.setHandsFreeSession(useDeviceStt && config?.handsFree?.enabled === true ? sessionId : null);
    sherpaSttController.setHandsFreeSession(useSherpaStt && config?.handsFree?.enabled === true ? sessionId : null);
    const browserSession = Platform.OS === 'web' && !useDeviceStt && !useSherpaStt
      ? { sessionId, handsFree: config?.handsFree?.enabled === true && supportsLocalVoiceHandsFree(settings, Platform.OS), abortController: new AbortController() }
      : null;
    trackInFlight((async () => {
      if (browserSession) {
        browserRecordingSession?.abortController.abort();
        browserRecordingSession = browserSession;
        patchLocalVoiceState({ status: 'connecting', sessionId, error: null });
        await prewarmLocalVoiceAgentOnConnect({ settings, config, signal: browserSession.abortController.signal });
        if (browserSession.abortController.signal.aborted) return;
      } else {
        fireAndForget(prewarmLocalVoiceAgentOnConnect({ settings, config }), { tag: 'localVoiceEngine.prewarmLocalVoiceAgentOnConnect' });
      }
      await (useDeviceStt ? deviceSttController.start(sessionId) : useSherpaStt ? sherpaSttController.start(sessionId) : startRecording(sessionId));
    })().catch((error: unknown) => {
      if (browserSession?.abortController.signal.aborted) return;
      if (!getLocalVoiceState().error) patchLocalVoiceState({ status: 'idle', sessionId, error: 'send_failed' });
      throw error;
    }));
    await inFlight;
    return;
  }

  if (current.status === 'recording') {
    if (current.sessionId !== sessionId) {
      return;
    }

    const settings = storage.getState().settings as any;
    const { config } = resolveLocalVoiceAdapterSettings(settings);
    const sttProvider = resolveLocalSttProvider(settings);
    const useDeviceStt = sttProvider === 'device';
    const useSherpaStt = sttProvider === 'local_neural';
    if (useDeviceStt) {
      deviceSttController.clearHandsFreeSession();
    }

    if (useSherpaStt) {
      sherpaSttController.clearHandsFreeSession();
    }

    if (browserRecordingSession) {
      browserRecordingSession = { ...browserRecordingSession, handsFree: false };
    }
    trackInFlight(useDeviceStt
      ? stopDeviceSpeechRecognitionAndSend(sessionId)
      : useSherpaStt
        ? stopSherpaSpeechRecognitionAndSend(sessionId)
        : stopAndSendRecordedTurn(sessionId));
    await inFlight;
  }
}

export async function stopLocalVoiceSession(): Promise<void> {
  const stoppingBrowserSession = browserRecordingSession;
  if (stoppingBrowserSession) inFlight = null;
  stoppingBrowserSession?.abortController.abort();
  browserRecordingSession = null;
  const current = getLocalVoiceState();
  const activeSessionId = current.sessionId ?? stoppingBrowserSession?.sessionId;
  if (!activeSessionId) return;

  playbackController.interrupt();
  if (activeTurnAbortController && activeTurnAbortSessionId === activeSessionId) {
    try {
      activeTurnAbortController.abort();
    } catch {
      // ignore
    }
    activeTurnAbortController = null;
    activeTurnAbortSessionId = null;
  }

  // Begin agent shutdown before awaiting the old recorder's asynchronous final data.
  const stoppingAgent = voiceAgentSessions.stop(activeSessionId).catch(() => {});
  deviceSttController.clearHandsFreeSession(activeSessionId);
  sherpaSttController.clearHandsFreeSession(activeSessionId);
  patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });

  // Best-effort stop any recording (we intentionally do not send).
  if (recorder) {
    const currentRecorder = recorder;
    recorder = null;
    if (current.status !== 'recording') currentRecorder.dispose?.();
    try {
      await currentRecorder.stop();
    } catch {
      // ignore
    } finally {
      currentRecorder.dispose?.();
    }
  }

  if (typeof activeSessionId === 'string' && activeSessionId.trim().length > 0) {
    try {
      await deviceSttController.stop(activeSessionId);
    } catch {
      // ignore
    }
    deviceSttController.clearHandsFreeSession(activeSessionId);

    try {
      await sherpaSttController.stop(activeSessionId);
    } catch {
      // ignore
    }
    sherpaSttController.clearHandsFreeSession(activeSessionId);

    await stoppingAgent;
  } else {
    deviceSttController.clearHandsFreeSession();
    sherpaSttController.clearHandsFreeSession();
  }

  if (!browserRecordingSession) patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
}
