import { describe, expect, it, vi } from 'vitest';

import {
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    submitMessage,
    setNextRecorderPrepareError,
    setPlatformOs,
} from './localVoiceEngine.testHarness';

describe('local voice engine recording lifecycle', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('records with browser MediaRecorder and posts the captured blob to OpenAI-compatible STT', async () => {
        setPlatformOs('web');

        const trackStop = vi.fn();
        const getUserMedia = vi.fn(async () => ({
            getTracks: () => [{ stop: trackStop }],
        }));
        const mediaRecorderInstances: FakeMediaRecorder[] = [];

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
                this.state = 'recording';
            }

            stop() {
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
            const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');

            await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();
            expect(getLocalVoiceState().status).toBe('recording');
            expect(mediaRecorderInstances).toHaveLength(1);
            expect(mediaRecorderInstances[0]?.state).toBe('recording');

            await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

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
