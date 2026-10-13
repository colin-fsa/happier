import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

import type { VoiceAdapterController, VoiceAdapterId, VoiceSessionSnapshot } from './types';
import { createVoiceSessionManager } from './voiceSessionManager';
import { setVoiceSessionSnapshot } from './voiceSessionStore';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function makeAdapter(id: VoiceAdapterId, opts?: { initial?: Partial<VoiceSessionSnapshot> }) {
  let started = false;
  let lastSessionId: string | null = null;
  const snapshot: Mutable<VoiceSessionSnapshot> = {
    adapterId: id,
    sessionId: null,
    status: 'disconnected',
    mode: 'idle',
    canStop: false,
    ...(opts?.initial ?? {}),
  };

  const controller: VoiceAdapterController = {
    id,
    getSnapshot: () => ({ ...snapshot }),
    start: async ({ sessionId }) => {
      started = true;
      lastSessionId = sessionId;
      snapshot.sessionId = sessionId;
      snapshot.status = 'connected';
      snapshot.mode = 'listening';
      snapshot.canStop = true;
    },
    stop: async ({ sessionId }) => {
      if (snapshot.sessionId !== sessionId) return;
      snapshot.sessionId = null;
      snapshot.status = 'disconnected';
      snapshot.mode = 'idle';
      snapshot.canStop = false;
    },
    toggle: async ({ sessionId }) => {
      if (snapshot.status === 'connected') {
        await controller.stop({ sessionId });
        return;
      }
      await controller.start({ sessionId });
    },
    interrupt: async () => {},
    sendContextUpdate: () => {},
  };

  return {
    controller,
    get started() {
      return started;
    },
    get lastSessionId() {
      return lastSessionId;
    },
  };
}

describe('voiceSessionManager (core)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    setVoiceSessionSnapshot({
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    });
  });

  it('starts the active adapter when toggled from disconnected', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => a.controller.id,
      getAdapter: (id) => (id === a.controller.id ? a.controller : null),
    });

    expect(mgr.getSnapshot().status).toBe('disconnected');

    await mgr.toggle('s1');

    const snap = mgr.getSnapshot();
    expect(a.started).toBe(true);
    expect(a.lastSessionId).toBe('s1');
    expect(snap.status).toBe('connected');
    expect(snap.mode).toBe('listening');
    expect(snap.adapterId).toBe(a.controller.id);
    expect(snap.sessionId).toBe('s1');
    expect(snap.canStop).toBe(true);
  });

  it('stops the active adapter when toggled from connected', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => a.controller.id,
      getAdapter: (id) => (id === a.controller.id ? a.controller : null),
    });

    await mgr.toggle('s1');
    expect(mgr.getSnapshot().status).toBe('connected');

    await mgr.toggle('s1');

    const snap = mgr.getSnapshot();
    expect(snap.status).toBe('disconnected');
    expect(snap.mode).toBe('idle');
    expect(snap.sessionId).toBe(null);
    expect(snap.canStop).toBe(false);
  });

  it('is a no-op when adapter id resolves to off', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => 'off',
      getAdapter: (_id) => a.controller,
    });

    await mgr.toggle('s1');
    expect(mgr.getSnapshot().status).toBe('disconnected');
    expect(a.started).toBe(false);
  });

  it('stops the active adapter when toggled but the adapter id resolves to off', async () => {
    const a = makeAdapter('test_adapter' as VoiceAdapterId);
    await a.controller.start({ sessionId: 's1' });
    setVoiceSessionSnapshot(a.controller.getSnapshot());

    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => 'off',
      getAdapter: (id) => (id === a.controller.id ? a.controller : null),
    });

    expect(mgr.getSnapshot().status).toBe('connected');
    await mgr.toggle('s1');
    expect(mgr.getSnapshot().status).toBe('disconnected');
  });
  it('surfaces a failed agent binding and allows a fresh connection attempt', async () => {
    const a = makeAdapter('local_conversation');
    let attempts = 0;
    const adapter: VoiceAdapterController = {
      ...a.controller,
      toggle: async ({ sessionId }) => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Target machine daemon is offline'), {
            code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
          });
        }
        await a.controller.toggle({ sessionId });
      },
    };
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => adapter.id,
      getAdapter: () => adapter,
    });

    await expect(mgr.toggle('s1')).rejects.toThrow('Target machine daemon is offline');
    expect(mgr.getSnapshot()).toMatchObject({
      adapterId: adapter.id,
      status: 'error',
      mode: 'idle',
      sessionId: null,
      canStop: false,
      errorCode: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
      errorMessage: 'Target machine daemon is offline',
    });

    await mgr.toggle('s1');
    expect(attempts).toBe(2);
    expect(mgr.getSnapshot().status).toBe('connected');
    expect(mgr.getSnapshot().errorCode).toBeUndefined();
  });

  it('does not create two voice sessions from clicks while startup is pending', async () => {
    let finishStart!: () => void;
    const startup = new Promise<void>((resolve) => { finishStart = resolve; });
    const a = makeAdapter('local_conversation');
    let attempts = 0;
    const adapter: VoiceAdapterController = {
      ...a.controller,
      toggle: async ({ sessionId }) => {
        attempts += 1;
        await startup;
        await a.controller.toggle({ sessionId });
      },
    };
    const mgr = createVoiceSessionManager({
      resolveActiveAdapterId: () => adapter.id,
      getAdapter: () => adapter,
    });

    const first = mgr.toggle('s1');
    const second = mgr.toggle('s1');
    expect(second).toBe(first);
    expect(attempts).toBe(1);
    expect(mgr.getSnapshot().status).toBe('connecting');

    finishStart();
    await Promise.all([first, second]);
    expect(mgr.getSnapshot().status).toBe('connected');
  });

  it('allows a fresh start after stop and ignores the cancelled startup failure', async () => {
    let failFirst!: (error: Error) => void;
    const firstStartup = new Promise<void>((_resolve, reject) => { failFirst = reject; });
    const a = makeAdapter('local_conversation');
    let attempts = 0;
    const adapter: VoiceAdapterController = {
      ...a.controller,
      toggle: async ({ sessionId }) => {
        attempts += 1;
        if (attempts === 1) return await firstStartup;
        await a.controller.toggle({ sessionId });
      },
    };
    const mgr = createVoiceSessionManager({ resolveActiveAdapterId: () => adapter.id, getAdapter: () => adapter });
    const first = mgr.toggle('s1');
    const firstResult = first.catch(() => {});
    await mgr.stop('s1');
    const retry = mgr.toggle('s1');
    expect(retry).not.toBe(first);
    await retry;
    failFirst(new Error('Cancelled binding failed late'));
    await firstResult;
    expect(mgr.getSnapshot()).toMatchObject({ status: 'connected', sessionId: 's1', errorCode: undefined });
  });

  it('keeps an existing microphone session stoppable when a toggle fails', async () => {
    const a = makeAdapter('local_conversation');
    await a.controller.start({ sessionId: 's1' });
    setVoiceSessionSnapshot(a.controller.getSnapshot());
    const adapter: VoiceAdapterController = {
      ...a.controller,
      toggle: async () => { throw new Error('Target machine daemon is offline'); },
    };
    const mgr = createVoiceSessionManager({ resolveActiveAdapterId: () => adapter.id, getAdapter: () => adapter });

    await expect(mgr.toggle('s1')).rejects.toThrow('Target machine daemon is offline');
    expect(mgr.getSnapshot()).toMatchObject({ status: 'error', sessionId: 's1', canStop: true });
    await mgr.stop('s1');
    expect(mgr.getSnapshot().status).toBe('disconnected');
  });

  it('does not publish a connected snapshot from a stopped startup', async () => {
    let finishStart!: () => void;
    const startup = new Promise<void>((resolve) => { finishStart = resolve; });
    const a = makeAdapter('local_conversation');
    const adapter: VoiceAdapterController = {
      ...a.controller,
      toggle: async ({ sessionId }) => {
        await startup;
        await a.controller.start({ sessionId });
      },
    };
    const mgr = createVoiceSessionManager({ resolveActiveAdapterId: () => adapter.id, getAdapter: () => adapter });

    const attempt = mgr.toggle('s1');
    await mgr.stop('s1');
    finishStart();
    await attempt;
    expect(mgr.getSnapshot().status).toBe('disconnected');
  });

  it('unlocks browser audio synchronously before asynchronous voice startup', async () => {
    let unlocked = false;
    vi.stubGlobal('AudioContext', class {
      destination = {};
      resume() { unlocked = true; return Promise.resolve(); }
      createBuffer() { return {}; }
      createBufferSource() { return { connect() {}, start() {}, disconnect() {} }; }
    });
    let finishStart!: () => void;
    const startup = new Promise<void>((resolve) => { finishStart = resolve; });
    const a = makeAdapter('local_conversation');
    const adapter: VoiceAdapterController = { ...a.controller, toggle: async () => { await startup; } };
    const mgr = createVoiceSessionManager({ resolveActiveAdapterId: () => adapter.id, getAdapter: () => adapter });

    const attempt = mgr.toggle('s1');
    expect(unlocked).toBe(true);
    finishStart();
    await attempt;
  });

});
