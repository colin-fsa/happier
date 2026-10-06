import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V1, type ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';

// Credential storage and network are the system boundaries; provider paging, importing,
// encryption, spawn-option resolution and the operation lifecycle remain real.
const mockIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: mockIo }));
const readCredentials = vi.hoisted(() => vi.fn<() => Promise<Credentials | null>>());
vi.mock('@/persistence', async (original) => ({
  ...await original<typeof import('@/persistence')>(), readCredentials,
}));
import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';

describe('direct-session import operation', () => {
  // First provider initialization loads the real backend modules; allow that boundary
  // to complete on shared CI hosts rather than treating Vitest's 1s default as failure.
  const waitFor = <T>(callback: () => T) => vi.waitFor(callback, { timeout: 10_000 });
  let root = '';
  let session: RawSessionRecord;
  let handlers: Map<string, (input: unknown) => Promise<unknown>>;
  const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 's1' }));
  const input = { machineId: 'm1', sessionId: 's1' };

  beforeEach(async () => {
    root = await createTempDir('direct-import-operation-');
    vi.stubEnv('HAPPIER_HOME_DIR', root);
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', root);
    await mkdir(join(root, 'projects', 'project'), { recursive: true });
    await writeFile(join(root, 'projects', 'project', 'native.jsonl'), [
      { type: 'user', uuid: 'u1', cwd: root, message: { content: 'hello' } },
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'world' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    session = {
      id: 's1', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 0,
      encryptionMode: 'plain', metadataVersion: 1, agentState: null,
      agentStateVersion: 0, dataEncryptionKey: null,
      metadata: JSON.stringify({ path: root, directSessionV1: {
        v: 1, providerId: 'claude', machineId: 'm1', remoteSessionId: 'native',
        linkedAtMs: 1, source: { kind: 'claudeConfig', configDir: root, projectId: 'project' },
      } }),
    };
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub({
      emit: (event, args) => {
        if (event !== 'update-metadata') return;
        const [payload, callback] = args;
        if (!payload || typeof payload !== 'object' || !('metadata' in payload) || typeof callback !== 'function') return;
        session.metadata = String(payload.metadata);
        session.metadataVersion += 1;
        callback({ result: 'success', version: session.metadataVersion, metadata: session.metadata });
      },
    }));
    readCredentials.mockResolvedValue({ token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => String(url).includes('/v2/sessions/s1')
      ? { status: 200, data: { session } } : { status: 404, data: {} });
    handlers = new Map();
    const rpcHandlerManager: RpcHandlerRegistrar = { registerHandler: (method, handler) => { // RPC registration erases the per-method input type at the transport boundary.
      handlers.set(method, handler as (input: unknown) => Promise<unknown>); } };
    spawnSession.mockReset();
    spawnSession.mockResolvedValue({ type: 'success', sessionId: 's1' });
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store });
    const getScope = async () => ({ accountId: 'a1', machineId: 'm1' });
    registerActionOperationRpcHandlers({ rpcHandlerManager, store, runner, getScope });
    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession: async () => true, actionOperations: { runner, getScope } });
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await removeTempDir(root); });

  let operation: ActionOperationSnapshotV1;
  async function start() {
    const result = await handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_START)!(input);
    expect(result).toMatchObject({ ok: true });
    operation = ActionOperationSnapshotV1Schema.parse((result as { operation: unknown }).operation);
    return operation;
  }
  async function get() {
    return handlers.get(ACTION_OPERATION_RPC_METHODS_V1.get)!({ operationId: operation.operationId });
  }
  async function cancel() {
    return handlers.get(ACTION_OPERATION_RPC_METHODS_V1.cancel)!({ operationId: operation.operationId });
  }

  it('keeps malformed-request errors distinct from takeover conflicts', async () => {
    for (const method of [RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST, RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_START]) {
      expect(await handlers.get(method)!({ machineId: 'm1' })).toEqual({ ok: false, errorCode: 'invalid_request', error: 'invalid_request' });
    }
  });

  it('retries a cancelled import with stable message IDs, completes conversion, and disables stop once starting', async () => {
    const localIds: string[] = [];
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body: unknown) => {
      const localId = body && typeof body === 'object' && 'localId' in body ? String(body.localId) : '';
      localIds.push(localId);
      if (localIds.length === 1) await firstPending;
      return { status: 200, data: { didWrite: true, message: { id: 'msg1', seq: 1, createdAt: 1, localId } } };
    });
    await start();
    await waitFor(() => expect(post).toHaveBeenCalled());
    await cancel();
    releaseFirst();
    await waitFor(async () => expect(await get())
      .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } }));
    let releaseSpawn!: () => void;
    const spawnPending = new Promise<void>(resolve => { releaseSpawn = resolve; });
    spawnSession.mockImplementationOnce(async () => { await spawnPending; return { type: 'success', sessionId: 's1' }; });
    await start();
    await waitFor(() => expect(spawnSession).toHaveBeenCalled());
    expect(await cancel())
      .toMatchObject({ kind: 'unsupported' });
    releaseSpawn();
    await waitFor(async () => expect(await get())
      .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } }));
    expect(JSON.parse(session.metadata)).not.toHaveProperty('directSessionV1');
    expect(JSON.parse(session.metadata)).toHaveProperty('externalHistoryImportV1');
    expect(localIds).toHaveLength(3);
    expect(localIds[0]).toBe(localIds[1]);
    expect(localIds[0]).toMatch(/^direct-import:v1:claude:/);
  });

  it('prevents a direct takeover from bypassing an active import', async () => {
    let releaseWrite!: () => void;
    const pending = new Promise<void>(resolve => { releaseWrite = resolve; });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      await pending;
      return { status: 200, data: { didWrite: true, message: { id: 'msg1', seq: 1, createdAt: 1, localId: 'local1' } } };
    });
    await start();
    await waitFor(() => expect(post).toHaveBeenCalled());
    try {
      const result = await handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER)!(input);
      expect(result).toMatchObject({ ok: false, error: 'direct_session_import_in_progress' });
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await cancel();
      releaseWrite();
      await waitFor(async () => expect(await get())
        .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } }));
    }
  });

  it('acknowledges and coalesces import while a message write is pending, then stops before takeover', async () => {
    let releaseWrite!: () => void;
    const writePending = new Promise<void>(resolve => { releaseWrite = resolve; });
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      await writePending;
      return { status: 200, data: { didWrite: true, message: { id: 'msg1', seq: 1, createdAt: 1, localId: 'local1' } } };
    });
    const started = await start();
    expect(started).toMatchObject({ state: 'running', cancellation: 'supported', scope: { sessionId: 's1' } });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(await start())
      .toMatchObject({ state: 'running', progress: { kind: 'determinate', total: 2 } });
    expect(await cancel())
      .toMatchObject({ kind: 'requested' });
    releaseWrite();
    await waitFor(async () => expect(await get())
      .toMatchObject({ kind: 'found', operation: { state: 'cancelled' } }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(await handlers.get(ACTION_OPERATION_RPC_METHODS_V1.list)!({ sessionId: 's1' })).toMatchObject({ items: [{ operationId: operation.operationId, state: 'cancelled' }] });
    expect(JSON.parse(session.metadata)).toHaveProperty('directSessionV1');
  });
  it('keeps the released synchronous import as a completion adapter to the listed attempt', async () => {
    let releaseWrite!: () => void;
    const pending = new Promise<void>(resolve => { releaseWrite = resolve; });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async () => {
      await pending;
      return { status: 200, data: { didWrite: true, message: { id: 'm1', seq: 1, createdAt: 1, localId: 'l1' } } };
    });
    const first = await start();
    await waitFor(() => expect(writes).toHaveBeenCalled());
    const historical = handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST)!(input);
    const joined = await start();
    expect(joined.operationId).toBe(first.operationId);
    expect(await handlers.get(ACTION_OPERATION_RPC_METHODS_V1.list)!({ sessionId: 's1' })).toMatchObject({ items: [{ operationId: first.operationId }] });
    releaseWrite();
    expect(await historical).toEqual({ ok: true, converted: true });
    expect(await get()).toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { ok: true, converted: true } } });
    expect(writes).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('excludes persisted import while direct takeover owns runner startup', async () => {
    let releaseSpawn!: () => void;
    const pending = new Promise<void>(resolve => { releaseSpawn = resolve; });
    spawnSession.mockImplementationOnce(async () => { await pending; return { type: 'success', sessionId: 's1' }; });
    const direct = handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER)!(input);
    await waitFor(() => expect(spawnSession).toHaveBeenCalled());
    const joined = handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER)!(input);
    expect(await handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_START)!(input)).toMatchObject({ ok: false, error: 'direct_session_takeover_in_progress' });
    releaseSpawn();
    expect(await direct).toEqual({ ok: true });
    expect(await joined).toEqual({ ok: true });
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

});
