import { afterEach, describe, expect, it, vi } from 'vitest';

import { createdAudioPlayers, getStorage, installBrowserRecordingMock, registerLocalVoiceEngineHarnessHooks, setPlatformOs } from '../../local/localVoiceEngine.testHarness';

describe('local conversation adapter composed startup', () => {
  registerLocalVoiceEngineHarnessHooks();
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(['initial activation', 'binding retry', 'greeting retry', 'active binding failure', 'provider switch during stop'] as const)('captures the microphone after %s through the real binding and engine', async (outcome) => {
    vi.doUnmock('@/voice/sessionBinding/resolveVoiceSessionBinding');
    setPlatformOs('web');
    installBrowserRecordingMock();
    let completeOldStop: (() => void) | undefined;
    let stopping: Promise<void> | undefined;
    if (outcome === 'provider switch during stop') {
      const BaseRecorder = globalThis.MediaRecorder;
      let held = false;
      vi.stubGlobal('MediaRecorder', class extends BaseRecorder {
        override stop() {
          if (!held && this.state === 'recording') {
            held = true;
            completeOldStop = () => super.stop();
            return;
          }
          super.stop();
        }
      });
    }
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const storage = await getStorage();
    const settings = storage.getState().settings;
    const config = settings.voice.adapters.local_conversation;
    storage.__setState({
      settings: { ...settings, voice: { ...settings.voice, adapters: { ...settings.voice.adapters,
        local_conversation: { ...config, conversationMode: 'agent',
          agent: { ...config.agent, backend: 'openai_compat', prewarmOnConnect: true,
            welcome: { enabled: true, mode: 'immediate' },
            openaiCompat: { ...config.agent.openaiCompat, chatBaseUrl: 'http://chat.test' } },
          tts: { ...config.tts, autoSpeakReplies: true,
            openaiCompat: { ...config.tts.openaiCompat, baseUrl: 'http://speech.test' } },
        },
      } } },
      machines: { machine: { id: 'machine', active: true, activeAt: outcome === 'binding retry' ? 1 : Date.now() } },
      sessions: {
        target: { id: 'target', active: true, presence: 'online', metadata: { flavor: 'claude', machineId: 'machine', path: '/project' } },
        conversation: { id: 'conversation', active: true, presence: 'online', metadata: {
          flavor: 'claude', machineId: 'machine', path: '/project',
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
          voiceConversationScopeV1: { v: 1, kind: 'session_root', sessionRootId: 'target' },
        } },
      },
    });
    let failGreeting = outcome === 'greeting retry';
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).includes('/audio/speech')) {
        if (failGreeting) { failGreeting = false; return new Response('', { status: 503 }); }
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/wav' } });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    const { createLocalConversationVoiceAdapter } = await import('./localConversationAdapter');
    const engine = await import('../../local/localVoiceEngine');
    const adapter = createLocalConversationVoiceAdapter();
    const { createLocalDirectVoiceAdapter } = await import('../localDirect/localDirectAdapter');
    const direct = createLocalDirectVoiceAdapter();
    const { createVoiceSessionManager } = await import('../../session/voiceSessionManager');
    const manager = createVoiceSessionManager({
      resolveActiveAdapterId: () => storage.getState().settings.voice.providerId,
      getAdapter: (id) => id === adapter.id ? adapter : id === direct.id ? direct : null,
    });
    try {
      if (outcome === 'binding retry') {
        await expect(adapter.toggle({ sessionId: 'target' })).rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
        expect(getUserMedia).not.toHaveBeenCalled();
        storage.__setState({ machines: { machine: { id: 'machine', active: true, activeAt: Date.now() } } });
      }
      if (outcome === 'greeting retry') {
        await expect(adapter.toggle({ sessionId: 'target' })).rejects.toThrow('tts_failed:503');
        expect(adapter.getSnapshot().status).toBe('error');
        expect(getUserMedia).not.toHaveBeenCalled();
      }
      const startup = outcome === 'provider switch during stop' ? manager.toggle('target') : adapter.toggle({ sessionId: 'target' });
      if (outcome !== 'greeting retry') {
        await vi.waitFor(() => expect(createdAudioPlayers).toHaveLength(1));
        expect(getUserMedia).not.toHaveBeenCalled();
        createdAudioPlayers[0].__emit('ended');
      }
      await startup;
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(adapter.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
      expect(adapter.getSnapshot().errorCode).toBeUndefined();
      if (outcome === 'active binding failure') {
        storage.__setState({ machines: { machine: { id: 'machine', active: true, activeAt: 1 } } });
        await expect(adapter.toggle({ sessionId: 'target' })).rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE' });
        expect(engine.getLocalVoiceState().status).toBe('recording');
        expect(adapter.getSnapshot()).toMatchObject({ status: 'error', mode: 'listening', canStop: true });
        expect(getUserMedia).toHaveBeenCalledOnce();
      }
      if (outcome === 'provider switch during stop') {
        stopping = manager.stop('');
        expect(completeOldStop).toBeTypeOf('function');
        const currentSettings = storage.getState().settings;
        storage.__setState({ settings: { ...currentSettings, voice: { ...currentSettings.voice, providerId: 'local_direct' } } });
        await manager.toggle('direct-target');
        expect(manager.getSnapshot().adapterId).toBe(direct.id);
        completeOldStop?.();
        await stopping;
        expect(manager.getSnapshot()).toMatchObject({ adapterId: direct.id, status: 'connected', mode: 'listening' });
      }
    } finally {
      completeOldStop?.();
      await stopping;
      await engine.stopLocalVoiceSession();
    }
  });
});
