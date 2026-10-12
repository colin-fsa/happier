import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendUser = vi.fn();
const appendAssistant = vi.fn();
const appendNote = vi.fn();
const resolveToolSessionId = vi.fn<(params: unknown) => string>(() => 's1');
const sendSessionMessageHandler = vi.fn<(args: unknown) => Promise<string>>(
  async () => JSON.stringify({ ok: true, status: 'sent' }),
);
const sendMessage = vi.fn();
const submitMessage = vi.fn();
const enqueuePendingMessage = vi.fn();
let conversationMode: 'agent' | 'direct_session' = 'agent';
let voiceAgentBackend: 'daemon' | 'openai_compat' = 'daemon';
let transcriptMode: 'synthetic' | 'native_session' = 'synthetic';

vi.mock('@/voice/sessionBinding/resolveVoiceSessionBinding', () => ({
  resolveVoiceSessionBindingByControlSessionId: (params: { controlSessionId: string }) =>
    params.controlSessionId === 'voice-global'
      ? {
          adapterId: 'local_conversation',
          controlSessionId: 'voice-global',
          conversationSessionId: 'carrier-s1',
          transcriptMode,
          targetSessionId: 's1',
          updatedAt: 1,
        }
      : null,
  resolveVoiceSessionBindingByConversationSessionId: () => null,
}));

vi.mock('@/voice/sessionBinding/voiceConversationTranscript', () => ({
  appendVoiceConversationUserText: (params: any) => appendUser(params),
  appendVoiceConversationAssistantText: (params: any) => appendAssistant(params),
  appendVoiceConversationNoteText: (params: any) => appendNote(params),
}));

vi.mock('@/voice/activity/voiceActivityController', () => ({
  voiceActivityController: {
    appendUserText: vi.fn(),
    appendAssistantText: vi.fn(),
    appendError: vi.fn(),
    appendActionExecuted: vi.fn(),
  },
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => ({
      sessionMessages: {},
    }),
  },
});
});

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage,
    submitMessage,
    enqueuePendingMessage,
  },
}));

vi.mock('@/voice/local/localVoiceSettings', () => ({
  resolveLocalVoiceAdapterSettings: () => ({
    adapterId: 'local_conversation',
    config: {
      conversationMode,
      agent: { backend: voiceAgentBackend },
      tts: { autoSpeakReplies: false },
    },
  }),
}));

vi.mock('@/voice/runtime/fetchWithTimeout', () => ({
  resolveVoiceNetworkTimeoutMs: () => 15000,
}));

vi.mock('@/voice/output/TtsChunker', () => ({
  createTtsChunker: vi.fn(),
  resolveStreamingTtsChunkChars: () => 120,
}));

vi.mock('@/voice/output/speakAssistantText', () => ({
  speakAssistantText: vi.fn(),
}));

vi.mock('@/voice/runtime/waitForNextAssistantTextMessage', () => ({
  waitForNextAssistantTextMessage: vi.fn(),
}));

vi.mock('@/voice/tools/handlers', () => ({
  createVoiceToolHandlers: ({ resolveSessionId }: any) => ({
    sendSessionMessage: async (args: any) => {
      const resolvedSessionId = resolveSessionId(args?.sessionId);
      return await sendSessionMessageHandler({ ...args, sessionId: resolvedSessionId });
    },
  }),
}));

vi.mock('@/voice/tools/resolveToolSessionId', () => ({
  resolveToolSessionId: (params: any) => resolveToolSessionId(params),
}));

vi.mock('./localVoiceState', () => ({
  patchLocalVoiceState: vi.fn(),
  setIdleStateUnlessRecording: vi.fn(),
}));

describe('sendVoiceTextTurn synthetic transcript mirroring', () => {
  beforeEach(() => {
    appendUser.mockReset();
    appendAssistant.mockReset();
    appendNote.mockReset();
    resolveToolSessionId.mockReset();
    resolveToolSessionId.mockReturnValue('s1');
    sendSessionMessageHandler.mockReset();
    sendSessionMessageHandler.mockResolvedValue(JSON.stringify({ ok: true, status: 'sent' }));
    sendMessage.mockReset();
    submitMessage.mockReset();
    submitMessage.mockResolvedValue(undefined);
    enqueuePendingMessage.mockReset();
    enqueuePendingMessage.mockImplementation(async (_sessionId, _text, _displayText, _meta, options) => ({
      localId: options.localId,
      accepted: true,
      externalHandoffClaimed: true,
    }));
    conversationMode = 'agent';
    voiceAgentBackend = 'daemon';
    transcriptMode = 'synthetic';
  });

  it('submits direct-session voice input durably before immediate provider dispatch', async () => {
    conversationMode = 'direct_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 's1',
      settings: {},
      userText: 'send this durably',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: vi.fn(),
      },
    });

    expect(submitMessage).toHaveBeenCalledWith(
      's1',
      'send this durably',
      undefined,
      undefined,
      {
        callerSurface: 'voice_turn',
        forceImmediate: true,
      },
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('delegates the durable user row to the daemon while mirroring assistant turns locally', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    const sendTurn = vi.fn(async () => ({ assistantText: 'I found Claude and Codex.', actions: [] }));

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
      userText: 'list the backends',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(appendUser).not.toHaveBeenCalled();
    expect(sendTurn).toHaveBeenCalledWith(
      'voice-global',
      'list the backends',
      {
        userTranscript: {
          mode: 'persist',
          localId,
        },
      },
    );
    expect(appendAssistant).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'I found Claude and Codex.',
    });
    expect(appendNote).not.toHaveBeenCalled();
  });

  it('dispatches daemon voice turns through a native-session binding', async () => {
    transcriptMode = 'native_session';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    const sendTurn = vi.fn(async () => ({ assistantText: 'I found Claude and Codex.', actions: [] }));

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
      userText: 'list the backends',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: { sendTurn },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(enqueuePendingMessage).toHaveBeenCalledWith(
      'carrier-s1',
      'list the backends',
      undefined,
      undefined,
      expect.objectContaining({ localId }),
    );
    expect(sendTurn).toHaveBeenCalledWith(
      'voice-global',
      'list the backends',
      {
        userTranscript: {
          mode: 'persist',
          localId,
        },
      },
    );
    expect(appendUser).not.toHaveBeenCalled();
    expect(appendAssistant).not.toHaveBeenCalled();
  });

  it('durably enqueues synthetic speech input before one exact local-agent dispatch', async () => {
    const events: string[] = [];
    enqueuePendingMessage.mockImplementationOnce(async (_sessionId, _text, _displayText, _meta, options) => {
      events.push(`enqueue:${options.localId}`);
      return { localId: options.localId, accepted: true, externalHandoffClaimed: true };
    });
    const sendTurn = vi.fn(async (_sessionId: string, _prompt: string, options?: any) => {
      const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
      events.push(`dispatch:${options?.userTranscript?.localId}`);
      return { assistantText: 'done', actions: [] };
    });
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
      userText: 'from microphone',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: { sendTurn },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(localId).toEqual(expect.any(String));
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(appendUser).not.toHaveBeenCalled();
    expect(sendTurn).toHaveBeenCalledWith(
      'voice-global',
      'from microphone',
      {
        userTranscript: {
          mode: 'persist',
          localId,
        },
      },
    );
    expect(events).toEqual([
      `enqueue:${localId}`,
      `dispatch:${localId}`,
    ]);
  });

  it('retains the UI transcript writer for the non-daemon voice backend', async () => {
    voiceAgentBackend = 'openai_compat';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
      userText: 'from local compatibility backend',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: vi.fn(async () => ({ assistantText: 'done', actions: [] })),
      },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'from local compatibility backend',
      localId,
    });
  });

  it('normalizes sendSessionMessage preambles and appends concise tool execution notes into the hidden conversation session', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will send that now.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done.',
        actions: [],
      });

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
      userText: 'send hello',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    expect(appendAssistant).toHaveBeenNthCalledWith(1, {
      conversationSessionId: 'carrier-s1',
      text: 'I sent that to the coding assistant and am waiting for its update.',
    });
    expect(appendNote).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Tool result: sendSessionMessage succeeded',
    });
  });

  it('resolves implicit tool session ids from the bound target session', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will send that now.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done.',
        actions: [],
      });

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: {},
      userText: 'send hello',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    expect(sendSessionMessageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
      }),
    );
  });

  it('rethrows agent-mode send failures after recording the error state', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await expect(
      sendVoiceTextTurn({
        sessionId: 'voice-global',
        settings: {},
        userText: 'send hello',
        playbackController: {
          registerStopper: () => () => {},
          interrupt: () => {},
          captureEpoch: () => 1,
          isEpochCurrent: () => true,
        },
        voiceAgentSessions: {
          sendTurn: async () => {
            throw new Error('send_failed');
          },
        },
      }),
    ).rejects.toThrow('voice_turn_dispatch_ambiguous');
  });
});
