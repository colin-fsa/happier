import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

type WebRecognitionModule = {
    start: (options: { requiresOnDeviceRecognition?: boolean }) => void;
    supportsOnDeviceRecognition: () => boolean;
    addListener: (event: 'result', listener: (result: { isFinal: boolean; results: Array<{ transcript: string }> }) => void) => { remove: () => void };
};

function loadInstalledWebModule(Recognition: new () => EventTarget): WebRecognitionModule {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('expo-speech-recognition/package.json'));
    const source = readFileSync(join(root, 'build/ExpoSpeechRecognitionModule.web.js'), 'utf8')
        .replace('import { registerWebModule, NativeModule } from "expo";', '')
        .replace('export const ExpoSpeechRecognitionModule =', 'return');
    // Expo registration and the browser recognizer are platform boundaries. The
    // installed third-party module itself runs unchanged beneath those adapters.
    const evaluate = new Function('NativeModule', 'registerWebModule', 'webkitSpeechRecognition', source);
    const result: unknown = evaluate(class { addListener() { return { remove: () => {} }; } }, (Module: new () => object) => new Module(), Recognition);
    if (!result || typeof result !== 'object' || !('start' in result) || typeof result.start !== 'function'
        || !('supportsOnDeviceRecognition' in result) || typeof result.supportsOnDeviceRecognition !== 'function'
        || !('addListener' in result) || typeof result.addListener !== 'function') {
        throw new Error('Invalid installed speech recognition module');
    }
    // Narrow the untyped external JavaScript module after validating its API.
    return result as WebRecognitionModule;
}

describe('installed web speech recognition local-mode contract', () => {
    it('uses native local processing only when explicitly requested', () => {
        const observed: boolean[] = [];
        class Recognition extends EventTarget {
            private local = false;
            get processLocally() { return this.local; }
            set processLocally(value: boolean) { this.local = value; }
            start() { observed.push(this.processLocally); }
        }
        const sdk = loadInstalledWebModule(Recognition);
        sdk.start({ requiresOnDeviceRecognition: true });
        sdk.start({});
        expect(observed).toEqual([true, false]);
        expect(sdk.supportsOnDeviceRecognition()).toBe(true);
    });

    it('preserves earlier finalized phrases when later browser speech results arrive', () => {
        let recognizer: EventTarget | undefined;
        class Recognition extends EventTarget {
            start() { recognizer = this; }
        }
        const sdk = loadInstalledWebModule(Recognition);
        sdk.start({});
        const observed: Array<{ isFinal: boolean; text: string }> = [];
        sdk.addListener('result', (event) => observed.push({ isFinal: event.isFinal, text: event.results[0].transcript }));
        const segment = (transcript: string, isFinal: boolean) => Object.assign([{ transcript, confidence: 1 }], { isFinal });
        const first = segment('Please inspect the session', true);
        for (const [resultIndex, results] of [
            [0, [first]],
            [1, [first, segment('and report', false)]],
            [1, [first, segment('and report its status', true)]],
        ] as const) {
            const event = Object.assign(new Event('result'), { resultIndex, results });
            recognizer?.dispatchEvent(event);
        }
        expect(observed).toEqual([
            { isFinal: true, text: 'Please inspect the session' },
            { isFinal: false, text: 'Please inspect the session and report' },
            { isFinal: true, text: 'Please inspect the session and report its status' },
        ]);
    });

    it('rejects an unsupported explicit local request instead of silently using remote recognition', () => {
        let started = false;
        class Recognition extends EventTarget {
            start() { started = true; }
        }
        const sdk = loadInstalledWebModule(Recognition);
        expect(sdk.supportsOnDeviceRecognition()).toBe(false);
        expect(() => sdk.start({ requiresOnDeviceRecognition: true })).toThrow('on_device_recognition_unavailable');
        expect(started).toBe(false);
        sdk.start({});
        expect(started).toBe(true);
    });
});
