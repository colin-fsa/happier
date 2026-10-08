import { describe, expect, it, vi } from 'vitest';

import { createKeyedStreamedTranscriptBridge } from './createKeyedStreamedTranscriptBridge';
import { createDisconnectedEphemeralSendOutcome } from './ephemeralSendOutcome';

type TranscriptCall = {
  provider: string;
  body: unknown;
  localId: string;
  meta: Record<string, unknown> | undefined;
};

function readMessageBody(call: TranscriptCall): { type?: unknown; message?: unknown; sidechainId?: unknown } {
  return call.body && typeof call.body === 'object' ? call.body : {};
}

async function settleSnapshots() {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createKeyedStreamedTranscriptBridge', () => {
  it.each(['turn-end', 'matching', 'admission'] as const)(
    'recovers a failed %s snapshot without absorbing its successor or changing its terminal state',
    async (boundary) => {
      vi.useFakeTimers();
      let connected = true;
      const stored = new Map<string, { body: unknown; meta: Record<string, unknown> | undefined }>();
      const bridge = createKeyedStreamedTranscriptBridge({
        provider: 'codex',
        initialCheckpointDelayMs: 0,
        checkpointIntervalMs: 60_000,
        checkpointMinChars: 1_000_000,
        createSessionForStream: () => ({
          sendAgentMessageEphemeral: () => connected
            ? { accepted: true, epoch: 0 }
            : createDisconnectedEphemeralSendOutcome(0),
          sendAgentMessageCommitted: async (_provider, body, opts) => {
            if (!connected) throw new Error('Socket not connected');
            stored.set(opts.localId, { body, meta: opts.meta });
          },
        }),
      });
      const stream = { streamKey: 'assistant-demo', sidechainId: null };
      bridge.appendAssistantDelta({ ...stream, deltaText: 'Hello ' });
      await vi.advanceTimersByTimeAsync(0);
      const originalLocalId = [...stored.keys()][0]!;
      expect(stored.get(originalLocalId)?.body).toEqual({ type: 'message', message: 'Hello ' });
      bridge.appendAssistantDelta({ ...stream, deltaText: 'world' });
      connected = false;
      if (boundary === 'turn-end') {
        expect(await bridge.flushAll({ reason: 'turn-end' })).toMatchObject([
          { assistant: { sawText: true, didDurablyFlush: false } },
        ]);
      } else if (boundary === 'matching') {
        await bridge.flushStreamsMatching({ reason: 'tool-call-boundary', matches: () => true });
      } else {
        await bridge.flushStreamsMatchingThroughDurableAdmission({ reason: 'tool-call-boundary', matches: () => true });
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(stored.get(originalLocalId)?.meta).toMatchObject({
        happierStreamSegmentV1: { segmentState: 'streaming' },
      });

      bridge.appendAssistantDelta({ ...stream, deltaText: 'Next reply' });
      connected = true;
      await bridge.flushAll({ reason: 'abort', interruptedReason: 'cancelled' });
      expect(stored.get(originalLocalId)).toMatchObject({
        body: { type: 'message', message: 'Hello world' },
        meta: { happierStreamSegmentV1: { segmentState: 'complete' } },
      });
      expect([...stored.values()].filter((row) => row.body !== stored.get(originalLocalId)?.body)).toEqual([
        expect.objectContaining({
          body: { type: 'message', message: 'Next reply' },
          meta: expect.objectContaining({ happierStreamSegmentV1: expect.objectContaining({ segmentState: 'interrupted' }) }),
        }),
      ]);
      const recovered = [...stored.entries()];
      await bridge.flushAll({ reason: 'turn-end' });
      expect([...stored.entries()]).toEqual(recovered);
    },
  );

  it('keeps a successor appended while flushAll awaits acknowledgement', async () => {
    vi.useFakeTimers();
    const acknowledgement = createDeferred<void>();
    const stored: TranscriptCall[] = [];
    const bridge = createKeyedStreamedTranscriptBridge({
      provider: 'codex',
      initialCheckpointDelayMs: 60_000,
      createSessionForStream: () => ({
        sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
        sendAgentMessageCommitted: async (provider, body, opts) => {
          if (body.type === 'message' && body.message === 'Before') await acknowledgement.promise;
          stored.push({ provider, body, localId: opts.localId, meta: opts.meta });
        },
      }),
    });
    const stream = { streamKey: 'same-key', sidechainId: null };
    bridge.appendAssistantDelta({ ...stream, deltaText: 'Before' });
    const flush = bridge.flushAll({ reason: 'turn-end' });
    await settleSnapshots();
    bridge.appendAssistantDelta({ ...stream, deltaText: 'After' });
    acknowledgement.resolve();
    await flush;
    await bridge.flushAll({ reason: 'turn-end' });
    expect(stored.map((row) => readMessageBody(row).message)).toEqual(['Before', 'After']);
    expect(new Set(stored.map((row) => row.localId)).size).toBe(2);
  });

  it('drains an admitted terminal snapshot without duplicating it after a late checkpoint ACK', async () => {
    vi.useFakeTimers();
    const checkpointAck = createDeferred<void>();
    const calls: TranscriptCall[] = [];
    const bridge = createKeyedStreamedTranscriptBridge({
      provider: 'codex',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 60_000,
      checkpointMinChars: 1_000_000,
      createSessionForStream: () => ({
        sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
        sendAgentMessageCommitted: async (provider, body, opts) => {
          calls.push({ provider, body, localId: opts.localId, meta: opts.meta });
          if (calls.length === 1) await checkpointAck.promise;
        },
      }),
    });
    const stream = { streamKey: 'same-key', sidechainId: 'child' };
    bridge.appendThinkingDelta({ ...stream, deltaText: 'Thinking before tool' });
    await vi.advanceTimersByTimeAsync(0);
    await bridge.flushStreamsMatchingThroughDurableAdmission({ reason: 'tool-call-boundary', matches: () => true });
    expect(calls).toHaveLength(2);
    const drain = bridge.flushAll({ reason: 'turn-end' });
    checkpointAck.resolve();
    expect(await drain).toMatchObject([{ thinking: { sawText: true, didDurablyFlush: true } }]);
    await bridge.flushAll({ reason: 'turn-end' });
    expect(calls).toHaveLength(2);
  });

  it('forwards live and durable cadence options into created writers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const durableCalls: TranscriptCall[] = [];
    const liveCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageEphemeral: (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        liveCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
        return { accepted: true as const, epoch: 0 };
      },
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 200,
      checkpointIntervalMs: 2_000,
      checkpointMinChars: 256,
      liveSnapshotIntervalMs: 40,
      liveSnapshotMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'item-1', sidechainId: null, deltaText: 'Hello' });
    await settleSnapshots();

    expect(liveCalls).toHaveLength(1);
    expect(durableCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await settleSnapshots();

    expect(durableCalls).toHaveLength(1);
    expect(durableCalls[0]).toMatchObject({
      provider: 'codex',
      body: { type: 'message', message: 'Hello' },
    });
  });

  it('flushes only matching stream scopes at tool-call boundaries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const durableCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: 'Root before' });
    await settleSnapshots();
    bridge.appendAssistantDelta({ streamKey: 'child:assistant:item-1', sidechainId: 'sc-1', deltaText: 'Child text' });
    await settleSnapshots();

    const initialRootLocalId = durableCalls.find((call) => readMessageBody(call).sidechainId === undefined)?.localId;
    expect(initialRootLocalId).toEqual(expect.any(String));

    await bridge.flushStreamsMatching({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === 'sc-1',
    });
    await settleSnapshots();

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: ' and after' });
    await settleSnapshots();

    const rootCalls = durableCalls.filter((call) => readMessageBody(call).sidechainId === undefined);
    const childCalls = durableCalls.filter((call) => readMessageBody(call).sidechainId === 'sc-1');

    expect(rootCalls.map((call) => call.localId)).toEqual([initialRootLocalId, initialRootLocalId]);
    expect(readMessageBody(rootCalls.at(-1)!).message).toBe('Root before and after');
    expect(childCalls.at(-1)?.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('keeps appends that arrive while a matching stream is flushing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const firstCommitDrain = createDeferred<void>();
    let pendingFirstCommit = true;
    const durableCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
        if (pendingFirstCommit) {
          pendingFirstCommit = false;
          await firstCommitDrain.promise;
        }
      },
    };

    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: 'Before boundary' });
    await settleSnapshots();

    const boundaryFlush = bridge.flushStreamsMatching({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === null,
    });
    await settleSnapshots();

    bridge.appendAssistantDelta({ streamKey: 'main:assistant:item-1', sidechainId: null, deltaText: 'After boundary' });
    await settleSnapshots();

    firstCommitDrain.resolve();
    await boundaryFlush;
    await bridge.flushAll({ reason: 'turn-end' });
    await settleSnapshots();

    const afterBoundaryCalls = durableCalls.filter((call) => readMessageBody(call).message === 'After boundary');
    expect(afterBoundaryCalls.length).toBeGreaterThan(0);
    expect(afterBoundaryCalls.at(-1)?.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
  });

  it('admits a terminal durable snapshot before releasing an ordered tool boundary without waiting for its ACK', async () => {
    const firstCommitDrain = createDeferred<void>();
    const durableCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
        await firstCommitDrain.promise;
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      liveSnapshotIntervalMs: 60_000,
      liveSnapshotMinChars: 10_000,
      initialCheckpointDelayMs: 60_000,
      checkpointIntervalMs: 60_000,
      checkpointMinChars: 10_000,
    });

    bridge.appendAssistantDelta({
      streamKey: 'main:assistant:item-1',
      sidechainId: null,
      deltaText: 'Before tool',
    });
    await bridge.flushStreamsMatchingThroughDurableAdmission({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === null,
    });

    expect(durableCalls.length).toBeGreaterThan(0);
    expect(readMessageBody(durableCalls.at(-1)!).message).toBe('Before tool');
    expect(durableCalls.at(-1)?.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
    firstCommitDrain.resolve();
  });

  it('admits the terminal boundary snapshot even while an earlier streaming snapshot awaits its ACK', async () => {
    const firstCommitDrain = createDeferred<void>();
    const durableCalls: TranscriptCall[] = [];
    const session = {
      sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string; meta?: Record<string, unknown> }) => {
        durableCalls.push({ provider, body, localId: opts.localId, meta: opts.meta });
        if (durableCalls.length === 1) await firstCommitDrain.promise;
      },
    };
    const bridge = createKeyedStreamedTranscriptBridge<{
      streamKey: string;
      sidechainId: string | null;
    }>({
      provider: 'codex',
      createSessionForStream: () => session,
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 60_000,
      checkpointMinChars: 1,
    });

    bridge.appendAssistantDelta({
      streamKey: 'main:assistant:item-1',
      sidechainId: null,
      deltaText: 'Before tool',
    });
    await settleSnapshots();
    expect(durableCalls).toHaveLength(1);

    bridge.appendAssistantDelta({
      streamKey: 'main:assistant:item-1',
      sidechainId: null,
      deltaText: ' and after checkpoint',
    });
    await settleSnapshots();
    expect(durableCalls).toHaveLength(1);

    await bridge.flushStreamsMatchingThroughDurableAdmission({
      reason: 'tool-call-boundary',
      matches: (stream) => stream.sidechainId === null,
    });

    expect(durableCalls).toHaveLength(2);
    expect(durableCalls[1]?.meta).toMatchObject({
      happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
    });
    firstCommitDrain.resolve();
    await settleSnapshots();
    expect(durableCalls).toHaveLength(2);
  });
});
