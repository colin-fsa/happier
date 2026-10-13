import { describe, expect, it, vi } from 'vitest';

import {
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    submitMessage,
    setNextRecorderPrepareError,
    setPlatformOs,
    createdAudioPlayers,
    expoSpeechSpeak,
} from './localVoiceEngine.testHarness';

describe('local voice engine recording lifecycle', () => {
    registerLocalVoiceEngineHarnessHooks();

    it.each(['success', 'transcription failure', 'cancel', 'failed startup retry'] as const)('releases browser recording resources after %s', async (outcome) => {
        setPlatformOs('web');

        const trackStop = vi.fn();
        const getUserMedia = vi.fn(async () => ({
            getTracks: () => [{ stop: trackStop }],
        }));
        const mediaRecorderInstances: FakeMediaRecorder[] = [];
        let failNextStart = outcome === 'failed startup retry';

        class FakeMediaRecorder {
            static isTypeSupported = vi.fn((mimeType: string) => mimeType === 'audio/webm;codecs=opus');

            readonly mimeType: string;
            state: 'inactive' | 'recording' = 'inactive';
            private readonly listeners = new Map<string, Set<(event: any) => void>>();

            constructor(_stream: unknown, options?: { mimeType?: string }) {
                this.mimeType = options?.mimeType ?? 'audio/webm';
                mediaRecorderInstances.push(this);
            }

            addEventListener(eventName: string, listener: (event: any) => void) {
                const listeners = this.listeners.get(eventName) ?? new Set();
                listeners.add(listener);
                this.listeners.set(eventName, listeners);
            }

            removeEventListener(eventName: string, listener: (event: any) => void) {
                this.listeners.get(eventName)?.delete(listener);
            }

            start() {
                if (failNextStart) {
                    failNextStart = false;
                    throw new Error('unsupported track');
                }
                this.state = 'recording';
            }

            stop() {
                if (this.state === 'inactive') return;
                this.state = 'inactive';
                const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType });
                for (const listener of this.listeners.get('dataavailable') ?? []) {
                    listener({ data: blob });
                }
                for (const listener of this.listeners.get('stop') ?? []) {
                    listener({ type: 'stop' });
                }
            }
        }

        vi.stubGlobal('navigator', {
            ...(globalThis as any).navigator,
            mediaDevices: { getUserMedia },
        });
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

        let transcriptionInit: RequestInit | undefined;
        (globalThis.fetch as any).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === 'blob:happier-test') {
                return new Response(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' }), {
                    status: 200,
                    headers: { 'Content-Type': 'audio/webm;codecs=opus' },
                });
            }
            if (url === 'http://localhost:8000/v1/audio/transcriptions') {
                if (outcome === 'transcription failure') throw new Error('STT offline');
                transcriptionInit = init;
                return new Response(JSON.stringify({ text: 'hello from the browser mic' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`unexpected fetch: ${url}`);
        });

        submitMessage.mockResolvedValue(undefined);

        try {
            const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = await import('./localVoiceEngine');

            if (outcome === 'failed startup retry') {
                await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('unsupported track');
                expect(trackStop).toHaveBeenCalledTimes(1);
                expect(getLocalVoiceState().error).toBe('recording_start_failed');
                expect(URL.createObjectURL).not.toHaveBeenCalled();
            }
            await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();
            expect(getLocalVoiceState().status).toBe('recording');
            expect(mediaRecorderInstances).toHaveLength(outcome === 'failed startup retry' ? 2 : 1);
            expect(mediaRecorderInstances.at(-1)?.state).toBe('recording');

            if (outcome === 'cancel' || outcome === 'failed startup retry') {
                await stopLocalVoiceSession();
                expect(trackStop).toHaveBeenCalledTimes(outcome === 'failed startup retry' ? 2 : 1);
                expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:happier-test');
                expect(globalThis.fetch).not.toHaveBeenCalled();
                expect(getLocalVoiceState().status).toBe('idle');
                return;
            }

            await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();
            expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:happier-test');
            if (outcome === 'transcription failure') {
                expect(trackStop).toHaveBeenCalledTimes(1);
                expect(submitMessage).not.toHaveBeenCalled();
                expect(getLocalVoiceState().status).toBe('idle');
                expect(getLocalVoiceState().error).toBe('stt_failed');
                return;
            }

            expect(getUserMedia).toHaveBeenCalledTimes(1);
            expect(trackStop).toHaveBeenCalledTimes(1);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                'http://localhost:8000/v1/audio/transcriptions',
                expect.objectContaining({
                    method: 'POST',
                    body: expect.any(FormData),
                }),
            );

            const form = transcriptionInit?.body as FormData;
            expect(form.get('model')).toBe('whisper-1');
            const file = form.get('file') as Blob & { name?: string };
            expect(file).toBeTruthy();
            expect(file.type).toContain('audio/webm');
            expect(file.name).toBe('recording.webm');
            expect(file.size).toBeGreaterThan(0);
            expect(submitMessage).toHaveBeenCalled();
            expect(getLocalVoiceState().status).toBe('idle');
            expect(getLocalVoiceState().error).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('cleans up and reports an error when recording initialization fails', async () => {
        setNextRecorderPrepareError(new Error('prepare failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('prepare failed');
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('recording_start_failed');
    });

    it('throws when STT base URL is missing', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_conversation: {
                            ...storage.getState().settings.voice.adapters.local_conversation,
                            stt: {
                                ...storage.getState().settings.voice.adapters.local_conversation.stt,
                                baseUrl: '',
                            },
                        },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('missing_stt_base_url');

        expect(globalThis.fetch).toHaveBeenCalledTimes(0);
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('missing_stt_base_url');
    });

    it('resets to idle when STT request throws (network error)', async () => {
        (globalThis.fetch as any).mockRejectedValueOnce(new Error('network down'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_failed');
    });

    it('times out STT request and resets to idle', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    adapters: {
                        ...storage.getState().settings.voice.adapters,
                        local_conversation: {
                            ...storage.getState().settings.voice.adapters.local_conversation,
                            networkTimeoutMs: 50,
                        },
                    },
                },
            },
        });

        (globalThis.fetch as any).mockImplementationOnce((_url: string, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                if (!signal) return;
                signal.addEventListener(
                    'abort',
                    () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
                    { once: true },
                );
            });
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');

        const stopPromise = toggleLocalVoiceTurn('s1');
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expect(stopPromise).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_failed');
    });
});


describe('browser HTTP hands-free conversation', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('propagates HTTP synthesis failure from the configured provider', async () => {
        setPlatformOs('web');
        vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
        const { speakAssistantText } = await import('@/voice/output/speakAssistantText');
        await expect(speakAssistantText({
            text: 'hello', networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {},
            settings: { voice: { providerId: 'local_conversation', adapters: { local_conversation: { tts: {
                provider: 'openai_compat', openaiCompat: { baseUrl: 'https://speech.test/v1' },
            } } } } },
        })).rejects.toThrow('tts_failed:503');
        expect(createdAudioPlayers).toHaveLength(0);
    });

    it('surfaces an unavailable configured neural provider without substituting device speech', async () => {
        setPlatformOs('web');
        vi.stubGlobal('WebAssembly', undefined);
        expoSpeechSpeak.mockImplementationOnce((_text: string, options: { onDone?: () => void }) => options.onDone?.());
        try {
            const { speakAssistantText } = await import('@/voice/output/speakAssistantText');
            await expect(speakAssistantText({
                text: 'hello', networkTimeoutMs: 15000, registerPlaybackStopper: () => () => {}, onSpeaking: () => {},
                settings: { voice: { providerId: 'local_conversation', adapters: { local_conversation: { tts: { provider: 'local_neural' } } } } },
            })).rejects.toThrow('kokoro_runtime_unsupported');
            expect(expoSpeechSpeak).not.toHaveBeenCalled();
        } finally { vi.unstubAllGlobals(); }
    });


    it.each(['three turns', 'Google Cloud three turns', 'missing TTS base URL', 'STT failure', 'TTS failure', 'cancel STT', 'interrupt STT', 'cancel TTS', 'duplicate activation', 'failed greeting', 'cancel greeting', 'pending microphone', 'permission denied', 'delayed stop reconnect'] as const)('handles %s through browser capture, HTTP providers and the real agent lifecycle', async (outcome) => {
        setPlatformOs('web');
        let amplitude = 0;
        let nextFrame: FrameRequestCallback | undefined;
        let recording = false;
        const delayedStop: { complete: (() => void) | null } = { complete: null };
        let delayStop = outcome === 'delayed stop reconnect';
        let waitForMicrophone = outcome === 'pending microphone';
        const microphone: { grant: ((stream: { getTracks: () => { stop: () => void }[] }) => void) | null } = { grant: null };
        const stopTrack = vi.fn();
        const closeContext = vi.fn(async () => {});
        class CaptureContext {
            state = 'running';
            resume = async () => {};
            createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
            createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(amplitude), disconnect: vi.fn() }; }
            close = closeContext;
            destination = {};
            async decodeAudioData(_bytes: ArrayBuffer) { return {}; }
            createBufferSource() {
                const player = {
                    buffer: {}, onended: (() => {}) as (() => void) | null,
                    connect() {}, disconnect() {},
                    start() { createdAudioPlayers.push(player); },
                    stop() { player.onended?.(); },
                    __emit(_event: string) { player.onended?.(); },
                };
                return player;
            }
        }
        class CaptureRecorder extends EventTarget {
            static isTypeSupported = () => true;
            mimeType = 'audio/webm;codecs=opus';
            state = 'inactive';
            constructor(_stream: unknown, _options?: unknown) { super(); }
            start() { this.state = 'recording'; recording = true; }
            stop() {
                this.state = 'inactive'; recording = false;
                const complete = () => {
                    const event = new Event('dataavailable');
                    Object.defineProperty(event, 'data', { value: new Blob(['spoken utterance'], { type: this.mimeType }) });
                    this.dispatchEvent(event);
                    this.dispatchEvent(new Event('stop'));
                };
                if (delayStop) { delayStop = false; delayedStop.complete = complete; }
                else queueMicrotask(complete);
            }
        }
        vi.stubGlobal('AudioContext', CaptureContext);
        vi.stubGlobal('MediaRecorder', CaptureRecorder);
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => waitForMicrophone ? new Promise((resolve) => { microphone.grant = resolve; }) : Promise.resolve({ getTracks: () => [{ stop: stopTrack }] }) } });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
        vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = undefined; });
        const storage = await getStorage();
        const settings = storage.getState().settings;
        const cfg = settings.voice.adapters.local_conversation;
        storage.__setState({ settings: { ...settings, voice: { ...settings.voice, adapters: { ...settings.voice.adapters,
            local_conversation: { ...cfg, conversationMode: 'agent', handsFree: { enabled: true, endpointing: { silenceMs: 450, minSpeechMs: 120 } },
                tts: { ...cfg.tts, autoSpeakReplies: true, openaiCompat: { ...cfg.tts.openaiCompat, baseUrl: 'http://localhost:8001' },
                    ...(outcome === 'Google Cloud three turns' ? { provider: 'google_cloud', googleCloud: { apiKey: { _isSecretValue: true, value: 'test-google-key' } } } : {}),
                },
                agent: { ...cfg.agent, backend: 'openai_compat', prewarmOnConnect: true, welcome: { enabled: true, mode: 'immediate' },
                    openaiCompat: { ...cfg.agent.openaiCompat, chatBaseUrl: 'http://localhost:8002' } },
            },
        } } } });
        let failStt = outcome === 'STT failure';
        let failTts = outcome === 'TTS failure';
        let cancelStt = outcome === 'cancel STT' || outcome === 'interrupt STT';
        let cancelTts = outcome === 'cancel TTS';
        let cancelGreeting = outcome === 'cancel greeting';
        const transcripts: string[] = [];
        const chats: string[] = [];
        const speech: string[] = [];
        vi.mocked(fetch).mockImplementation(async (input, init) => {
            const url = String(input);
            if (url.startsWith('blob:')) return new Response(new Blob(['spoken utterance'], { type: 'audio/webm' }));
            if (url.includes('/audio/transcriptions')) {
                transcripts.push('hello');
                if (failStt) return new Response('', { status: 503 });
                if (cancelStt) return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); });
                return new Response(JSON.stringify({ text: `spoken turn ${transcripts.length}` }));
            }
            if (url.includes('/chat/completions')) {
                chats.push(String(init?.body));
                return new Response(JSON.stringify({ choices: [{ message: { content: 'Agent response' } }] }));
            }
            if (url.includes('/audio/speech')) {
                speech.push(String(init?.body));
                if (cancelGreeting || (cancelTts && speech.length > 1)) return await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); });
                if ((failTts && speech.length > 1) || outcome === 'failed greeting') throw new Error('TTS unavailable');
                return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
            }
            if (url.startsWith('https://texttospeech.googleapis.com/v1/text:synthesize')) {
                speech.push(String(init?.body));
                return Response.json({ audioContent: 'AQID' });
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const until = async (condition: () => boolean) => {
            for (let n = 0; n < 4000 && !condition(); n++) await Promise.resolve();
            expect(condition()).toBe(true);
        };
        const frame = (time: number, level: number) => { amplitude = level; const callback = nextFrame; nextFrame = undefined; callback?.(time); };
        if (outcome === 'permission denied') {
            const { requestMicrophonePermission } = await import('@/utils/platform/microphonePermissions');
            vi.mocked(requestMicrophonePermission).mockResolvedValueOnce({ granted: false, canAskAgain: true });
        }
        const engine = await import('./localVoiceEngine');
        const starts: Promise<void>[] = [];
        const startVoice = () => {
            const pending = engine.toggleLocalVoiceTurn('s1');
            starts.push(pending);
            return pending;
        };
        try {
            const connecting = startVoice();
            expect(engine.getLocalVoiceState().status).toBe('connecting');
            if (outcome === 'cancel greeting') {
                await until(() => speech.length === 1);
                await engine.stopLocalVoiceSession();
                await connecting;
                expect(engine.getLocalVoiceState().sessionId).toBeNull();
                expect(recording).toBe(false);
                cancelGreeting = false;
                const reconnect = startVoice();
                await until(() => createdAudioPlayers.length === 1);
                createdAudioPlayers[0].__emit('ended');
                await reconnect;
                expect(recording).toBe(true);
                return;
            }
            if (outcome === 'failed greeting') {
                await expect(connecting).rejects.toThrow('TTS unavailable');
                expect(recording).toBe(false);
                expect(engine.getLocalVoiceState().error).toBe('send_failed');
                return;
            }
            const duplicate = outcome === 'duplicate activation' ? startVoice() : Promise.resolve();
            await until(() => createdAudioPlayers.length === 1);
            expect(recording).toBe(false);
            createdAudioPlayers[0].__emit('ended');
            if (outcome === 'pending microphone') {
                await until(() => microphone.grant !== null);
                await engine.stopLocalVoiceSession();
                microphone.grant?.({ getTracks: () => [{ stop: stopTrack }] });
                await connecting;
                expect(recording).toBe(false);
                expect(stopTrack).toHaveBeenCalledOnce();
                expect(engine.getLocalVoiceState().sessionId).toBeNull();
                waitForMicrophone = false;
                const reconnect = startVoice();
                await until(() => createdAudioPlayers.length === 2);
                createdAudioPlayers.at(-1).__emit('ended');
                await reconnect;
                expect(recording).toBe(true);
                return;
            }
            await connecting;
            await duplicate;
            if (outcome === 'permission denied') {
                expect(recording).toBe(false);
                expect(engine.getLocalVoiceState().status).toBe('idle');
                expect(engine.getLocalVoiceState().error).toBe('recording_start_failed');
                await startVoice();
                expect(recording).toBe(true);
                return;
            }
            expect(recording).toBe(true);
            if (outcome === 'missing TTS base URL') {
                const current = storage.getState().settings;
                const local = current.voice.adapters.local_conversation;
                storage.__setState({ settings: { ...current, voice: { ...current.voice, adapters: { ...current.voice.adapters,
                    local_conversation: { ...local, tts: { ...local.tts, openaiCompat: { ...local.tts.openaiCompat, baseUrl: '' } } },
                } } } });
            }
            if (outcome === 'delayed stop reconnect') {
                const stopping = engine.stopLocalVoiceSession();
                await until(() => delayedStop.complete !== null);
                const reconnect = startVoice();
                await until(() => createdAudioPlayers.length === 2);
                createdAudioPlayers.at(-1).__emit('ended');
                await reconnect;
                expect(recording).toBe(true);
                delayedStop.complete?.();
                await stopping;
                expect(recording).toBe(true);
                expect(engine.getLocalVoiceState().status).toBe('recording');
                expect(engine.getLocalVoiceState().sessionId).toBe('s1');
                return;
            }
            for (let turn = 0; turn < 3; turn++) {
                frame(0, 0.1); frame(150, 0.1); frame(200, 0); frame(600, 0);
                if (outcome === 'missing TTS base URL') {
                    await until(() => engine.getLocalVoiceState().error !== null);
                    expect(recording).toBe(false);
                    expect(engine.getLocalVoiceState().error).toBe('send_failed');
                    expect(speech).toHaveLength(1);
                    return;
                }
                if (outcome === 'interrupt STT') {
                    await until(() => transcripts.length === 1);
                    await engine.abortLocalVoiceTurn('s1');
                    expect(recording).toBe(true);
                    expect(engine.getLocalVoiceState().sessionId).toBe('s1');
                    cancelStt = false;
                    frame(2000, 0.1); frame(2150, 0.1); frame(2200, 0); frame(2600, 0);
                    await until(() => createdAudioPlayers.length === 2);
                    expect(chats.at(-1)).toContain('spoken turn 2');
                    createdAudioPlayers.at(-1).__emit('ended');
                    await until(() => recording);
                    return;
                }
                if (outcome === 'cancel STT' || outcome === 'cancel TTS') {
                    await until(() => outcome === 'cancel STT' ? transcripts.length === 1 : speech.length === 2);
                    await engine.stopLocalVoiceSession();
                    await until(() => engine.getLocalVoiceState().sessionId === null);
                    expect(recording).toBe(false);
                    expect(chats).toHaveLength(outcome === 'cancel STT' ? 0 : 1);
                    cancelStt = false; cancelTts = false;
                    const beforeReconnect = createdAudioPlayers.length;
                    const reconnect = startVoice();
                    await until(() => createdAudioPlayers.length === beforeReconnect + 1);
                    createdAudioPlayers.at(-1).__emit('ended');
                    await reconnect;
                    expect(recording).toBe(true);
                    return;
                }
                if (failStt || failTts) {
                    await until(() => engine.getLocalVoiceState().error !== null);
                    expect(recording).toBe(false);
                    expect(engine.getLocalVoiceState().error).toBe(failStt ? 'stt_failed' : 'send_failed');
                    failStt = false; failTts = false;
                    await startVoice();
                    expect(recording).toBe(true);
                    return;
                }
                await until(() => createdAudioPlayers.length === turn + 2);
                expect(recording).toBe(false);
                expect(chats.at(-1)).toContain(`spoken turn ${turn + 1}`);
                createdAudioPlayers.at(-1).__emit('ended');
                await until(() => recording);
            }
            expect(transcripts).toHaveLength(3);
            expect(chats).toHaveLength(3); // OpenAI-compatible welcome is a local greeting, not an HTTP chat turn
            expect(speech).toHaveLength(4);
            await engine.stopLocalVoiceSession();
            expect(recording).toBe(false);
            expect(nextFrame).toBeUndefined();
            expect(engine.getLocalVoiceState().sessionId).toBeNull();
        } finally {
            delayStop = false;
            delayedStop.complete?.();
            waitForMicrophone = false;
            microphone.grant?.({ getTracks: () => [{ stop: stopTrack }] });
            await engine.stopLocalVoiceSession();
            await Promise.allSettled(starts);
            await engine.stopLocalVoiceSession();
            vi.unstubAllGlobals();
        }
    });
});
