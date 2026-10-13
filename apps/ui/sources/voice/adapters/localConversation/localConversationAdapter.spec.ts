import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionBinding } from '@/voice/sessionBinding/voiceSessionBindingTypes';
import { getLocalVoiceState, patchLocalVoiceState, subscribeLocalVoiceState } from '@/voice/local/localVoiceState';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

const toggleLocalVoiceTurn = vi.fn(async () => {});
const stopLocalVoiceSession = vi.fn(async () => {});
const abortLocalVoiceTurn = vi.fn(async (_sessionId: string) => {});
const appendLocalVoiceAgentContextUpdate = vi.fn();
const sendVoiceTextTurn = vi.fn(async () => {});

const ensureBound = vi.fn(async (params: any): Promise<VoiceSessionBinding | null> => ({
  adapterId: 'local_conversation',
  controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
  conversationSessionId: 'sys_voice',
  transcriptMode: 'native_session',
  targetSessionId: params.requestedTargetSessionId ?? null,
  updatedAt: 1,
}));
const voiceAgentSessions = { sendTurn: vi.fn(), stop: vi.fn(), isActive: vi.fn(), appendContextUpdate: vi.fn() };

const state: any = {
  settings: {
    voice: {
      providerId: 'local_conversation',
      adapters: {
        local_conversation: { conversationMode: 'agent', agent: { backend: 'openai_compat' } },
      },
    },
  },
};

function resetMockVoiceSettings(): void {
  state.settings.voice.providerId = 'local_conversation';
  state.settings.voice.adapters.local_conversation = {
    conversationMode: 'agent',
    agent: { backend: 'openai_compat' },
  };
}

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: { getState: () => state },
});
});

vi.mock('@/voice/local/localVoiceEngine', () => ({
  toggleLocalVoiceTurn,
  stopLocalVoiceSession,
  abortLocalVoiceTurn,
  appendLocalVoiceAgentContextUpdate,
  getLocalVoiceState,
  subscribeLocalVoiceState,
}));
vi.mock('@/voice/local/sendVoiceTextTurn', () => ({
  sendVoiceTextTurn,
}));
vi.mock('@/voice/agent/voiceAgentSessions', () => ({
  voiceAgentSessions,
}));
vi.mock('@/voice/sessionBinding/voiceSessionBindingRuntime', () => ({
  voiceSessionBindingManager: {
    ensureBound: (params: any) => ensureBound(params),
  },
}));

describe('local conversation voice adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockVoiceSettings();
    patchLocalVoiceState({
      status: 'idle',
      sessionId: null,
      error: null,
    });
  });

  afterAll(() => {
    vi.resetModules();
  });

  it('delegates toggle to local voice engine', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
  });

  it('binds the requested target session through the voice session binding manager when starting from a session in agent mode', async () => {
    ensureBound.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(ensureBound).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: 's1',
    });
  });

  it('binds the global hidden voice conversation session when starting from the sidebar in agent mode', async () => {
    ensureBound.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: '' });
    expect(ensureBound).toHaveBeenCalledWith({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      requestedTargetSessionId: null,
    });
  });

  it('sends context updates to the local agent buffer', async () => {
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    adapter.sendContextUpdate({ sessionId: 's1', update: 'context' });
    expect(appendLocalVoiceAgentContextUpdate).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID, 'context');
  });

  it('treats idle local voice state with a sessionId as connected (ready)', async () => {
    patchLocalVoiceState({ status: 'idle', sessionId: VOICE_AGENT_GLOBAL_SESSION_ID, error: null });
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    expect(adapter.getSnapshot()).toMatchObject({
      status: 'connected',
      mode: 'idle',
      sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      canStop: true,
    });
  });

  it('interrupt aborts the current turn without hanging up the local voice session', async () => {
    abortLocalVoiceTurn.mockClear();
    stopLocalVoiceSession.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.interrupt({ sessionId: 's1' });

    expect(abortLocalVoiceTurn).toHaveBeenCalledWith(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(stopLocalVoiceSession).not.toHaveBeenCalled();
  });

  it('routes typed sends through the local voice text turn path for synthetic agent sessions', async () => {
    sendVoiceTextTurn.mockClear();
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home',
      text: 'hello from composer',
      localId: 'voice-local-1',
      handoffMode: 'interrupt_and_send',
    });

    expect(sendVoiceTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        userText: 'hello from composer',
        voiceAgentSessions,
      }),
    );
  });

  it('routes typed sends through the local voice text turn path for daemon-backed agent sessions too', async () => {
    sendVoiceTextTurn.mockClear();
    state.settings.voice.adapters.local_conversation.agent.backend = 'daemon';
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.sendTextTurn?.({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'voice-home',
      text: 'hello from daemon composer',
      localId: 'voice-local-2',
      handoffMode: 'interrupt_and_send',
    });

    expect(sendVoiceTextTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        userText: 'hello from daemon composer',
        voiceAgentSessions,
      }),
    );
  });
  it('does not record a voice-agent turn when the binding was never established', async () => {
    ensureBound.mockResolvedValueOnce(null);
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await expect(adapter.toggle({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'VOICE_SESSION_BINDING_REQUIRED',
      message: 'voice_session_binding_required',
    });
    expect(toggleLocalVoiceTurn).not.toHaveBeenCalled();
  });

  it('rejects stale bindings for another control session before recording', async () => {
    ensureBound.mockResolvedValueOnce({
      adapterId: 'local_conversation',
      controlSessionId: 'wrong-session',
      conversationSessionId: 'sys_voice',
      transcriptMode: 'native_session',
      targetSessionId: 's1',
      updatedAt: 1,
    });
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await expect(adapter.toggle({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'VOICE_SESSION_BINDING_REQUIRED',
    });
    expect(toggleLocalVoiceTurn).not.toHaveBeenCalled();
  });

  it('does not require an agent binding in direct-session mode', async () => {
    state.settings.voice.adapters.local_conversation.conversationMode = 'direct_session';
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    await adapter.toggle({ sessionId: 's1' });
    expect(ensureBound).not.toHaveBeenCalled();
    expect(toggleLocalVoiceTurn).toHaveBeenCalledWith('s1');
  });

  it('does not start the microphone after stop cancels a pending binding', async () => {
    let finishBinding!: (binding: VoiceSessionBinding | null) => void;
    ensureBound.mockImplementationOnce(() => new Promise((resolve) => { finishBinding = resolve; }));
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    const startup = adapter.toggle({ sessionId: 's1' });
    await adapter.stop({ sessionId: '' });
    finishBinding({
      adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'sys_voice', transcriptMode: 'native_session', targetSessionId: 's1', updatedAt: 1,
    });
    await startup;
    expect(toggleLocalVoiceTurn).not.toHaveBeenCalled();

    await adapter.toggle({ sessionId: 's1' });
    expect(toggleLocalVoiceTurn).toHaveBeenCalledOnce();
  });

  it('publishes pending binding and failure through the adapter snapshot', async () => {
    let failBinding!: (error: Error) => void;
    ensureBound.mockImplementationOnce(() => new Promise((_resolve, reject) => { failBinding = reject; }));
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const adapter = createLocalConversationVoiceAdapter();

    const observed: VoiceSessionSnapshot[] = [];
    const unsubscribe = adapter.subscribe?.(() => { observed.push(adapter.getSnapshot()); });
    const startup = adapter.toggle({ sessionId: 's1' });
    const result = startup.catch(() => {});
    expect(adapter.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
    failBinding(new Error('Target machine daemon is offline'));
    await result;
    expect(adapter.getSnapshot()).toMatchObject({ status: 'error', canStop: false, errorMessage: 'Target machine daemon is offline' });
    expect(observed.at(-1)).toMatchObject({ status: 'error', canStop: false, errorMessage: 'Target machine daemon is offline' });
    unsubscribe?.();
  });

});
