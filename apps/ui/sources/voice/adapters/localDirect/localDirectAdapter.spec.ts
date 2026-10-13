import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalVoiceState, patchLocalVoiceState, subscribeLocalVoiceState } from '@/voice/local/localVoiceState';

const toggleLocalVoiceTurn = vi.fn(async () => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const abortLocalVoiceTurn = vi.fn(async (_sessionId: string) => {});

vi.mock('@/voice/local/localVoiceEngine', () => ({
  toggleLocalVoiceTurn,
  stopLocalVoiceSession,
  abortLocalVoiceTurn,
  getLocalVoiceState,
  subscribeLocalVoiceState,
}));

describe('local direct voice adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
  });
  it('maps idle+sessionId to connected so the status bar can remain stoppable', async () => {
    patchLocalVoiceState({ status: 'idle', sessionId: 's1', error: null });
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    expect(adapter.getSnapshot()).toEqual({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });
  });

  it('delegates toggle to local voice engine', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
  });

  it('keeps agent warmup connecting and stoppable', async () => {
    patchLocalVoiceState({ status: 'connecting', sessionId: 's1', error: null });
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    expect(createLocalDirectVoiceAdapter().getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
  });

  it('stop stops the local voice session', async () => {
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.stop({ sessionId: 's1' });
    expect(stopLocalVoiceSession).toHaveBeenCalledTimes(1);
  });

  it('interrupt aborts the current turn without hanging up the local voice session', async () => {
    abortLocalVoiceTurn.mockClear();
    stopLocalVoiceSession.mockClear();
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    await adapter.interrupt({ sessionId: 's1' });

    expect(abortLocalVoiceTurn).toHaveBeenCalledWith('s1');
    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
  });

  it('does not start capture after stop cancels a pending session switch', async () => {
    toggleLocalVoiceTurn.mockClear();
    patchLocalVoiceState({ status: 'recording', sessionId: 'old', error: null });
    let finishPreviousStop!: () => void;
    stopLocalVoiceSession.mockImplementationOnce(() => new Promise((resolve) => { finishPreviousStop = resolve; }));
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    const adapter = createLocalDirectVoiceAdapter();

    const startup = adapter.toggle({ sessionId: 'new' });
    await adapter.stop({ sessionId: '' });
    finishPreviousStop();
    await startup;
    expect(toggleLocalVoiceTurn).not.toHaveBeenCalled();
  });
});
