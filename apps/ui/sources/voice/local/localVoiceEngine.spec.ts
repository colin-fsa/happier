import { describe, expect, it } from 'vitest';

import {
    getStorage,
    registerLocalVoiceEngineHarnessHooks,
    submitMessage,
} from './localVoiceEngine.testHelpers';

describe('local voice engine (turn-based) smoke', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('records then transcribes and sends a message on stop', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');

        await toggleLocalVoiceTurn('s1');
        expect(getLocalVoiceState().status).toBe('recording');

        await toggleLocalVoiceTurn('s1');
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(submitMessage).toHaveBeenCalledWith('s1', 'hello world', undefined, undefined, {
            callerSurface: 'voice_turn',
            forceImmediate: true,
        });
        // After a turn completes, the local voice session remains active (ready for another turn)
        // until the user explicitly hangs up.
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    }, 120_000);

    it('does not start a local voice turn while realtime voice is connected', async () => {
        const storage = await getStorage();
        storage.__setState({ realtimeStatus: 'connected' });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await import('./localVoiceEngine');
        await toggleLocalVoiceTurn('s1');

        // Local voice should not start recording while a realtime call is active.
        expect(getLocalVoiceState().status).toBe('idle');
    });
});
