import { describe, expect, it, vi } from 'vitest';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';

const scope = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('actionOperationRunner historical execution projection', () => {
  it('wraps the historical execution once while returning its exact value', async () => {
    const store = createActionOperationStore({ now: () => 10 });
    const runner = createActionOperationRunner({ store, createOperationId: () => 'operation-1', now: () => 10 });
    const exact = { ok: true as const, childSessionId: 'child-1' };
    const value = await runner.executeHistorical({
      request: { actionId: 'session.fork', input: {}, requestId: 'request-1', scope: { sessionId: 'parent-1' } },
      scope,
      title: 'Fork session',
      cancellation: 'supported',
      scopeSessionId: 'parent-1',
      execute: async ({ update }) => {
        update({ progress: { kind: 'phase', phase: 'creating', label: 'Creating fork' } });
        return exact;
      },
      projectResult: (result) => ({ ok: true, result }),
    });

    expect(value).toBe(exact);
    expect(store.get('operation-1', scope)).toMatchObject({
      requestId: 'request-1', revision: 4, state: 'succeeded', result: exact,
    });
  });

  it('reuses one projection for repeated delivery of the same scoped Action request', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, createOperationId: vi.fn(() => 'operation-1') });
    const execute = vi.fn(async () => ({ ok: true as const, childSessionId: 'child-1' }));
    const invoke = () => runner.executeHistorical({
      request: { actionId: 'session.fork', input: {}, requestId: 'request-1', scope: {} },
      scope,
      title: 'Fork session',
      cancellation: 'supported' as const,
      execute,
      projectResult: (result: Awaited<ReturnType<typeof execute>>) => ({ ok: true as const, result }),
    });

    await Promise.all([invoke(), invoke()]);
    await invoke();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.list({}, scope).items).toHaveLength(1);
    expect(store.get('operation-1', scope)).toMatchObject({ state: 'succeeded', revision: 3 });
  });

  it('requests cooperative cancellation and only terminalizes when the owner throws AbortError', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, createOperationId: () => 'operation-cancel' });
    let observedSignal: AbortSignal | null = null;
    const running = runner.executeHistorical({
      request: { actionId: 'session.spawn_new', input: {}, requestId: 'spawn-1', scope: {} },
      scope,
      title: 'Create session',
      cancellation: 'supported',
      execute: async ({ signal }) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true }));
        return { type: 'success' as const, sessionId: 'unreachable' };
      },
      projectResult: (result) => ({ ok: true, result }),
    });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    expect(runner.cancel('operation-cancel', scope)).toEqual({ kind: 'requested' });
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.get('operation-cancel', scope)).toMatchObject({ state: 'cancelled' });
  });
});

describe('actionOperationRunner start and shared admission', () => {
  it('acknowledges without waiting, joins one same-mode effect, excludes another mode and shares cancellation', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let effects = 0;
    const input = {
      request: { actionId: 'session.direct.takeover_persist', input: {}, scope: { sessionId: 's1' } },
      scope, scopeSessionId: 's1', exclusiveKey: 'takeover:s1',
      title: 'Import history', cancellation: 'supported' as const,
      execute: async ({ signal, update }: { signal: AbortSignal; update: (value: { progress?: import('@happier-dev/protocol').ActionOperationProgressV1; cancellation?: 'supported' | 'unsupported' }) => void }) => {
        effects += 1;
        update({ progress: { kind: 'determinate', current: 1, total: 2 } });
        await pending;
        signal.throwIfAborted();
        return { ok: true as const };
      },
      projectResult: (value: { ok: true }) => ({ ok: true as const, result: value }),
    };
    const started = runner.startHistorical(input);
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') throw new Error('expected admission');
    await vi.waitFor(() => expect(effects).toBe(1));
    const joined = runner.startHistorical(input);
    expect(joined).toMatchObject({ kind: 'started', operation: { operationId: started.operation.operationId } });
    expect(runner.startHistorical({ ...input, request: { ...input.request, actionId: 'session.direct.takeover' } })).toEqual({ kind: 'conflict' });
    expect(store.list({ sessionId: 's1' }, scope).items).toHaveLength(1);
    expect(runner.cancel(started.operation.operationId, scope)).toEqual({ kind: 'requested' });
    expect(store.get(started.operation.operationId, scope)).toMatchObject({ state: 'running', cancellation: 'unsupported', progress: { kind: 'phase', phase: 'cancelling' } });
    release();
    await expect(started.completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(effects).toBe(1);
    expect(store.get(started.operation.operationId, scope)).toMatchObject({ state: 'cancelled' });
  });
});

it('rejects changed input for an existing request identity instead of reusing another session result', async () => {
  const store = createActionOperationStore();
  const runner = createActionOperationRunner({ store });
  const input = {
    request: { actionId: 'session.fork', input: { sessionId: 's1' }, requestId: 'r1', scope: {} }, scope,
    title: 'Fork session', cancellation: 'unsupported' as const,
    execute: async () => ({ ok: true as const }), projectResult: (value: { ok: true }) => ({ ok: true as const, result: value }),
  };
  const started = runner.startHistorical(input);
  expect(started.kind).toBe('started');
  expect(runner.startHistorical({ ...input, request: { ...input.request, input: { sessionId: 's2' } } })).toEqual({ kind: 'conflict' });
  if (started.kind === 'started') await started.completion;
});

it('keeps a genuine failure visible when cancellation was requested but not acknowledged', async () => {
  const store = createActionOperationStore();
  const runner = createActionOperationRunner({ store });
  let fail!: () => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = () => reject(Object.assign(new Error('private-credential-value'), { code: 'private-credential-code' })); });
  const started = runner.startHistorical({
    request: { actionId: 'session.direct.takeover_persist', input: {}, scope: {} }, scope,
    title: 'Import history', cancellation: 'supported',
    execute: async () => { await pending; return { ok: true as const }; },
    projectResult: value => ({ ok: true, result: value }),
  });
  if (started.kind !== 'started') throw new Error('expected admission');
  expect(runner.cancel(started.operation.operationId, scope)).toEqual({ kind: 'requested' });
  fail();
  await expect(started.completion).rejects.toThrow('private-credential-value');
  expect(store.get(started.operation.operationId, scope)).toMatchObject({ state: 'failed', error: { errorCode: 'action_failed', error: 'Action failed' } });
});
