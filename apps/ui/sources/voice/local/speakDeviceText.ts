import * as ExpoSpeech from 'expo-speech';

export async function speakDeviceText(text: string, onStart?: () => void, options?: Readonly<{ preferLocalVoice?: boolean; language?: string | null }>): Promise<void> {
    let voice: string | undefined;
    if (options?.preferLocalVoice && typeof speechSynthesis !== 'undefined') {
        const language = (options.language?.trim() || globalThis.navigator?.language || 'en-US').toLowerCase();
        const localVoices = speechSynthesis.getVoices().filter((candidate) => candidate.localService);
        const matchingVoice = localVoices.find((candidate) => candidate.lang.toLowerCase() === language)
            ?? localVoices.find((candidate) => candidate.lang.toLowerCase().split('-')[0] === language.split('-')[0]);
        voice = matchingVoice?.voiceURI;
    }

    return await new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            reject(err);
        };

        try {
            // Notify callers right before we invoke the device speech API.
            // This makes calling code (and tests) more deterministic.
            onStart?.();
            ExpoSpeech.speak(text, {
                ...(voice ? { voice } : {}),
                onDone: done,
                onStopped: done,
                onError: fail,
            } as any);
        } catch (err) {
            fail(err);
        }
    });
}

export function stopDeviceSpeech(): void {
    try {
        ExpoSpeech.stop();
    } catch {
        // best-effort
    }
}
