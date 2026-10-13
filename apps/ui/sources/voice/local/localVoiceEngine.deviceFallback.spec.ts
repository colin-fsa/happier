import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitSpeechRecEvent, expoSpeechSpeak, getStorage, registerLocalVoiceEngineHarnessHooks, speechRecRequestPermissionsAsync, speechRecStart, speechRecStop, setPlatformOs } from './localVoiceEngine.testHelpers';

async function configureFallback(enabled = true) {
    const storage = await getStorage();
    const settings = storage.getState().settings;
    const cfg = settings.voice.adapters.local_conversation;
    storage.__setState({ settings: { ...settings, voice: { ...settings.voice, providerId: 'local_conversation', adapters: { ...settings.voice.adapters,
        local_conversation: { ...cfg, conversationMode: 'agent', agent: { ...cfg.agent, backend: 'openai_compat', prewarmOnConnect: false, welcome: { ...cfg.agent.welcome, enabled: false }, openaiCompat: { ...cfg.agent.openaiCompat, chatBaseUrl: 'https://agent.test/v1' } }, stt: { ...cfg.stt, provider: 'openai_compat', fallbackToDevice: enabled, openaiCompat: { ...cfg.stt.openaiCompat, baseUrl: 'https://mac.test/v1' } },
            tts: { ...cfg.tts, provider: 'openai_compat', fallbackToDevice: enabled, autoSpeakReplies: false, openaiCompat: { ...cfg.tts.openaiCompat, baseUrl: 'https://mac.test/v1' } },
            handsFree: { enabled: true, endpointing: { silenceMs: 0, minSpeechMs: 0 } },
        },
    } } } });
    return storage;
}

describe('local voice device outage fallback', () => {
    registerLocalVoiceEngineHarnessHooks();
    afterEach(() => { vi.unstubAllGlobals(); });

    it.each([503, 'network'] as const)('asks for a fresh utterance after %s, keeps device recognition for this call, and returns to Mac STT on the next call', async (outage) => {
        const storage = await configureFallback();
        const chats: string[] = [];
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            if (String(input).endsWith('/chat/completions')) {
                chats.push(String(init?.body));
                return Response.json({ choices: [{ message: { content: 'Agent fallback reply' } }] });
            }
            if (outage === 'network') throw new TypeError('Failed to fetch');
            return new Response('', { status: outage });
        });
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        await engine.toggleLocalVoiceTurn('s1');
        expect(engine.getLocalVoiceState()).toMatchObject({ status: 'recording', error: null, deviceFallback: { stt: true } });
        expect(speechRecStart).toHaveBeenCalledTimes(1);
        expect(chats).toHaveLength(0);
        expect(storage.getState().settings.voice.adapters.local_conversation.stt.provider).toBe('openai_compat');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'repeated after outage' }] });
        emitSpeechRecEvent('end');
        await vi.waitFor(() => expect(speechRecStop).toHaveBeenCalledTimes(1));
        emitSpeechRecEvent('end');
        await vi.waitFor(() => expect(chats).toHaveLength(1));
        expect(chats[0]).toContain('repeated after outage');
        await vi.waitFor(() => expect(speechRecStart).toHaveBeenCalledTimes(2));
        const stopping = engine.stopLocalVoiceSession();
        emitSpeechRecEvent('end');
        await stopping;
        expect(engine.getLocalVoiceState().deviceFallback).toBeUndefined();
        await engine.toggleLocalVoiceTurn('s1');
        expect(speechRecStart).toHaveBeenCalledTimes(2);
        await engine.stopLocalVoiceSession();
    });

    it.each([400, 401, 403, 404, 422, 429])('does not replace HTTP STT on status %s', async (status) => {
        await configureFallback();
        vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        await engine.toggleLocalVoiceTurn('s1');
        expect(engine.getLocalVoiceState().error).toBe('stt_failed');
        expect(speechRecStart).not.toHaveBeenCalled();
    });

    it('surfaces HTTP 200 error payloads instead of treating them as silence or an outage', async () => {
        await configureFallback();
        vi.mocked(fetch).mockResolvedValue(Response.json({ error: { message: 'Unsupported output format: m4a', type: 'ValueError' } }));
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        await engine.toggleLocalVoiceTurn('s1');
        expect(engine.getLocalVoiceState().error).toBe('stt_failed');
        expect(speechRecStart).not.toHaveBeenCalled();
    });

    it('publishes denied microphone permission instead of staying connecting', async () => {
        const { requestMicrophonePermission } = await import('@/utils/platform/microphonePermissions');
        vi.mocked(requestMicrophonePermission).mockResolvedValueOnce({ granted: false, canAskAgain: true });
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const states: unknown[] = [];
        const controller = createDeviceSttController({ setState: (state) => states.push(state), getSettings: () => ({}), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        await controller.start('s1');
        expect(states.at(-1)).toMatchObject({ status: 'error', error: 'device_stt_permission_denied' });
        expect(speechRecStart).not.toHaveBeenCalled();
    });

    it('requests on-device recognition only after the browser reports the language available', async () => {
        setPlatformOs('web');
        const available = vi.fn(async () => 'available');
        vi.stubGlobal('SpeechRecognition', class { static available = available; });
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const controller = createDeviceSttController({ setState: () => {}, getSettings: () => ({ voice: { assistantLanguage: 'en-US' } }), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        await controller.start('s1', { preferOnDevice: true });
        expect(available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
        expect(speechRecStart).toHaveBeenCalledWith(expect.objectContaining({ requiresOnDeviceRecognition: true }));
        const stopping = controller.stop('s1'); emitSpeechRecEvent('end'); await stopping;
    });

    it('cancels fallback startup while browser language availability is pending', async () => {
        setPlatformOs('web');
        let resolveAvailability!: (value: string) => void;
        const available = vi.fn(() => new Promise<string>((resolve) => { resolveAvailability = resolve; }));
        vi.stubGlobal('SpeechRecognition', class { static available = available; });
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const controller = createDeviceSttController({ setState: () => {}, getSettings: () => ({}), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        const starting = controller.start('s1', { preferOnDevice: true });
        await vi.waitFor(() => expect(available).toHaveBeenCalled());
        await controller.stop('s1');
        resolveAvailability('available');
        await starting;
        expect(speechRecStart).not.toHaveBeenCalled();
    });

    it('selects a matching local browser voice for device TTS fallback', async () => {
        const storage = await configureFallback();
        setPlatformOs('web');
        vi.stubGlobal('speechSynthesis', { getVoices: () => [
            { voiceURI: 'remote-en', lang: 'en-US', localService: false },
            { voiceURI: 'local-fr', lang: 'fr-FR', localService: true },
            { voiceURI: 'local-en', lang: 'en-US', localService: true },
        ] });
        vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
        expoSpeechSpeak.mockImplementation((_text, options) => options?.onDone?.());
        const { speakAssistantText } = await import('@/voice/output/speakAssistantText');
        await speakAssistantText({ text: 'Local fallback reply', settings: storage.getState().settings, networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });
        expect(expoSpeechSpeak).toHaveBeenCalledWith('Local fallback reply', expect.objectContaining({ voice: 'local-en' }));
    });

    it('does not stop recognition while speech continues before the configured silence deadline', async () => {
        const storage = await configureFallback();
        const settings = storage.getState().settings;
        const cfg = settings.voice.adapters.local_conversation;
        storage.__setState({ settings: { ...settings, voice: { ...settings.voice, adapters: { ...settings.voice.adapters, local_conversation: { ...cfg, stt: { ...cfg.stt, provider: 'device' }, handsFree: { enabled: true, endpointing: { silenceMs: 5000, minSpeechMs: 0 } } } } } } });
        const chats: string[] = [];
        vi.mocked(fetch).mockImplementation(async (_input, init) => {
            chats.push(String(init?.body));
            return Response.json({ choices: [{ message: { content: 'Agent response' } }] });
        });
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        vi.useFakeTimers();
        try {
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first phrase' }] });
            await vi.advanceTimersByTimeAsync(4000);
            emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: 'first phrase continued' }] });
            await vi.advanceTimersByTimeAsync(1500);
            expect(speechRecStop).not.toHaveBeenCalled();
            expect(engine.getLocalVoiceState().status).toBe('recording');
            emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first phrase continued and finished' }] });
            await vi.advanceTimersByTimeAsync(4999);
            expect(speechRecStop).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(speechRecStop).toHaveBeenCalledTimes(1);
            emitSpeechRecEvent('end');
            await vi.waitFor(() => expect(chats).toHaveLength(1));
            expect(chats[0]).toContain('first phrase continued and finished');
            await vi.waitFor(() => expect(speechRecStart).toHaveBeenCalledTimes(2));
        } finally {
            const stopping = engine.stopLocalVoiceSession(); emitSpeechRecEvent('end'); await stopping;
            vi.useRealTimers();
        }
    });

    it('keeps fallback opt-in', async () => {
        await configureFallback(false);
        vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        await engine.toggleLocalVoiceTurn('s1');
        expect(engine.getLocalVoiceState().error).toBe('stt_failed');
        expect(speechRecStart).not.toHaveBeenCalled();
    });

    it('speaks the same HTTP reply with device TTS and retains a call notice', async () => {
        const storage = await configureFallback();
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
        expoSpeechSpeak.mockImplementation((_text, options) => options?.onDone?.());
        const { speakAssistantText } = await import('@/voice/output/speakAssistantText');
        await speakAssistantText({ text: 'Preserved reply', settings: storage.getState().settings, networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });
        expect(expoSpeechSpeak).toHaveBeenCalledWith('Preserved reply', expect.anything());
        expect(engine.getLocalVoiceState()).toMatchObject({ deviceFallback: { tts: true } });
        expect(storage.getState().settings.voice.adapters.local_conversation.tts.provider).toBe('openai_compat');
        await speakAssistantText({ text: 'Second preserved reply', settings: storage.getState().settings, networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenLastCalledWith('Second preserved reply', expect.anything());
        await engine.stopLocalVoiceSession();
        await engine.toggleLocalVoiceTurn('s1');
        await speakAssistantText({ text: 'New call reply', settings: storage.getState().settings, networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not use device TTS when the caller cancels an HTTP request with fallback enabled', async () => {
        const storage = await configureFallback();
        vi.mocked(fetch).mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        }));
        expoSpeechSpeak.mockImplementation((_text, options) => options?.onDone?.());
        const { speakAssistantText } = await import('@/voice/output/speakAssistantText');
        const controller = new AbortController();
        const pending = speakAssistantText({ text: 'Cancelled reply', settings: storage.getState().settings, networkTimeoutMs: 15000, signal: controller.signal, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} });
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
        controller.abort();
        await rejection;
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
    });

    it.each([401, 404, 429])('surfaces HTTP TTS status %s without speech substitution', async (status) => {
        const storage = await configureFallback();
        vi.mocked(fetch).mockResolvedValue(new Response('', { status }));
        expoSpeechSpeak.mockImplementation((_text, options) => options?.onDone?.());
        const { speakAssistantText } = await import('@/voice/output/speakAssistantText');
        await expect(speakAssistantText({ text: 'Original reply', settings: storage.getState().settings, networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {} })).rejects.toThrow(`tts_failed:${status}`);
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
    });

    it('defaults fallback off and retains explicit consent across current settings parsing', async () => {
        const { VoiceLocalSttSchema } = await import('@/sync/domains/settings/voiceLocalSttSettings');
        const { VoiceLocalTtsSchema } = await import('@/sync/domains/settings/voiceLocalTtsSettings');
        for (const schema of [VoiceLocalSttSchema, VoiceLocalTtsSchema]) {
            expect(schema.parse({}).fallbackToDevice).toBe(false);
            expect(schema.parse({ fallbackToDevice: true }).fallbackToDevice).toBe(true);
            expect(schema.parse({ useDeviceStt: false, useDeviceTts: false, baseUrl: 'https://mac.test' }).fallbackToDevice).toBe(false);
        }
    });

    it('waits for the SDK start event and publishes asynchronous startup errors', async () => {
        speechRecStart.mockImplementation(() => {});
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const states: unknown[] = [];
        const controller = createDeviceSttController({ setState: (state) => states.push(state), getSettings: () => ({}), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        const starting = controller.start('s1');
        await vi.waitFor(() => expect(speechRecStart).toHaveBeenCalled());
        expect(states.at(-1)).toMatchObject({ status: 'connecting' });
        emitSpeechRecEvent('error', { error: 'not-allowed' });
        await starting;
        expect(states.at(-1)).toMatchObject({ status: 'error', error: 'device_stt_not-allowed' });
    });

    it('does not send an old device transcript into a reconnected call with the same session id', async () => {
        const storage = await configureFallback();
        const settings = storage.getState().settings;
        const cfg = settings.voice.adapters.local_conversation;
        storage.__setState({ settings: { ...settings, voice: { ...settings.voice, adapters: { ...settings.voice.adapters, local_conversation: { ...cfg, stt: { ...cfg.stt, provider: 'device' }, handsFree: { ...cfg.handsFree, enabled: false } } } } } });
        const engine = await import('./localVoiceEngine');
        await engine.toggleLocalVoiceTurn('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'obsolete turn' }] });
        const oldTurn = engine.toggleLocalVoiceTurn('s1');
        const stopping = engine.stopLocalVoiceSession();
        await engine.toggleLocalVoiceTurn('s1');
        await Promise.all([oldTurn, stopping]);
        expect(engine.getLocalVoiceState().status).toBe('recording');
        expect(fetch).not.toHaveBeenCalled();
        const ending = engine.stopLocalVoiceSession();
        emitSpeechRecEvent('end');
        await ending;
    });

    it('cancels a device recognizer start awaiting native permission', async () => {
        let grant!: (permission: { granted: boolean }) => void;
        speechRecRequestPermissionsAsync.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const states: unknown[] = [];
        const controller = createDeviceSttController({ setState: (state) => states.push(state), getSettings: () => ({}), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        const starting = controller.start('s1');
        await vi.waitFor(() => expect(grant).toBeTypeOf('function'));
        await controller.stop('s1');
        grant({ granted: true });
        await starting;
        expect(speechRecStart).not.toHaveBeenCalled();
        expect(states).not.toContainEqual(expect.objectContaining({ status: 'recording' }));
    });

    it('publishes SDK recognition errors instead of leaving the microphone shown as recording', async () => {
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const states: unknown[] = [];
        const controller = createDeviceSttController({ setState: (state) => states.push(state), getSettings: () => ({}), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        await controller.start('s1');
        emitSpeechRecEvent('error', { error: 'not-allowed', message: 'permission denied' });
        expect(states.at(-1)).toMatchObject({ status: 'error', error: 'device_stt_not-allowed' });
    });

    it('does not let an older asynchronous device stop consume a replacement recognizer', async () => {
        const { createDeviceSttController } = await import('@/voice/input/DeviceSttController');
        const controller = createDeviceSttController({ setState: () => {}, getSettings: () => ({}), canAutoStopTurn: () => true, onAutoStopTurn: () => {} });
        await controller.start('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'old' }] });
        const oldStop = controller.stop('s1');
        await controller.start('s1');
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'new' }] });
        expect(await oldStop).toBe('old');
        const newStop = controller.stop('s1');
        emitSpeechRecEvent('end');
        expect(await newStop).toBe('new');
    });
});
