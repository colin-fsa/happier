import { renderHook, createSessionFixture, flushHookEffects, createDeferred } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import type { DirectSessionImportOperation } from '@happier-dev/protocol';
import { RpcError } from '@/sync/runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseDirectSessionRuntimeResult } from './useDirectSessionRuntime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machineRpcSpy = vi.hoisted(() => vi.fn());
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async () => {}));
const refreshSessionsSpy = vi.hoisted(() => vi.fn(async () => {}));
const showDirectSessionTakeoverDialogSpy = vi.hoisted(() =>
  vi.fn<() => Promise<{ action: 'direct' | 'persisted' | null; forceStop: boolean }>>(async () => ({ action: null, forceStop: false })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());

let activeServerId = 'server-1';

vi.mock('@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog', () => ({
  showDirectSessionTakeoverDialog: showDirectSessionTakeoverDialogSpy,
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
            confirm: vi.fn(async () => false),
        },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: activeServerId }),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcSpy,
}));
vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessionMessages: refreshSessionMessagesSpy,
    refreshSessions: refreshSessionsSpy,
  },
}));

async function renderHarness(
  directSessionRuntime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>,
) {
  const { useDirectSessionTakeover } = await import('./useDirectSessionTakeover');

  return renderHook(
    (runtime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>) =>
      useDirectSessionTakeover({ sessionId: 's1', hasWriteAccess: true, directSessionRuntime: runtime }),
    {
      initialProps: directSessionRuntime,
    },
  );
}

describe('useDirectSessionTakeover', () => {
  const directSessionLink: NonNullable<UseDirectSessionRuntimeResult['directSessionLink']> = {
    v: 1,
    providerId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'vendor-session-1',
    source: { kind: 'codexHome', home: 'user' },
  };
  const status: NonNullable<UseDirectSessionRuntimeResult['status']> = {
    ok: true,
    machineOnline: true,
    runnerActive: false,
    activity: 'running',
    canTakeOverDirect: true,
    canTakeOverPersist: true,
    canForceStop: false,
  };

  beforeEach(() => {
    activeServerId = 'server-1';
    storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: 'server-owned' }) }, machines: {} });
    machineRpcSpy.mockReset();
    machineRpcSpy.mockImplementation(async ({ method }) => method === 'daemon.directSessions.import.status'
      ? { ok: true, operation: null } : { ok: true });
    refreshSessionMessagesSpy.mockReset();
    refreshSessionMessagesSpy.mockResolvedValue(undefined);
    refreshSessionsSpy.mockReset();
    refreshSessionsSpy.mockResolvedValue(undefined);
    showDirectSessionTakeoverDialogSpy.mockReset();
    showDirectSessionTakeoverDialogSpy.mockResolvedValue({ action: null, forceStop: false });
    modalAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('restores daemon import progress when a direct session is reopened', async () => {
    const operation = { sessionId: 's1', state: 'running', phase: 'importing', importedCount: 42, canCancel: true };
    machineRpcSpy.mockResolvedValue({ ok: true, operation });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    expect(harness.getCurrent()).toEqual(expect.objectContaining({ importOperation: operation, takeoverInFlight: 'persisted' }));
    machineRpcSpy.mockRejectedValueOnce(new Error('temporarily disconnected'));
    await act(async () => { await harness.getCurrent().refreshImport(); });
    expect(harness.getCurrent().importOperation).toEqual(operation);
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    await act(async () => { await harness.getCurrent().refreshImport(); });
    expect(harness.getCurrent().importStatusError).toBeNull();
    await harness.unmount();
  });

  it.each(['cancelled', 'completed', 'failed'] as const)('keeps import pending until the daemon reports %s and refreshes retained history', async (terminalState) => {
    vi.useFakeTimers();
    let operation: DirectSessionImportOperation | null = null;
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') {
        operation = { sessionId: 's1', state: 'running', phase: 'importing', importedCount: 5, canCancel: true };
      }
      if (method === 'daemon.directSessions.import.cancel' && operation) {
        operation = { ...operation, state: 'cancelling', canCancel: false };
      }
      return { ok: true, operation };
    });
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ directSessionLink, status, refreshNow });
    let result: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then((ready) => { result = ready; }); });
    await flushHookEffects();
    expect(result).toBeUndefined();
    expect(harness.getCurrent().importOperation?.importedCount).toBe(5);
    expect(harness.getCurrent().takeoverInFlight).toBe('persisted');
    if (terminalState === 'cancelled') {
      await act(async () => { await harness.getCurrent().cancelImport(); });
      expect(harness.getCurrent().importOperation?.state).toBe('cancelling');
      expect(result).toBeUndefined();
    }
    operation = { sessionId: 's1', state: terminalState, phase: 'importing', importedCount: 5, canCancel: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result).toBe(terminalState === 'completed');
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');
    expect(refreshSessionsSpy).toHaveBeenCalled();
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeoverPersist')).toBe(false);
    await harness.unmount();
  });

  it('observes completion at the admitted daemon after metadata conversion removes the direct link', async () => {
    vi.useFakeTimers();
    let operation: DirectSessionImportOperation | null = null;
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') {
        operation = { sessionId: 's1', state: 'running', phase: 'importing', importedCount: 5, canCancel: true };
      }
      return { ok: true, operation };
    });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    let result: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then((ready) => { result = ready; }); });
    await flushHookEffects();
    await harness.rerender({ directSessionLink: null, status: null, refreshNow: vi.fn(async () => null) });
    expect(harness.getCurrent().importOperation?.state).toBe('running');
    machineRpcSpy.mockClear();
    operation = { sessionId: 's1', state: 'completed', phase: 'converting', importedCount: 5, canCancel: false };
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result).toBe(true);
    expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1', method: 'daemon.directSessions.import.status', payload: { machineId: 'machine-1', sessionId: 's1' },
    }));
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    await act(async () => { expect(await harness.getCurrent().ensureReadyForSend()).toBe(true); });
    await harness.unmount();
  });

  it('drops the retained import address and pending send when the hook moves to another session', async () => {
    vi.useFakeTimers();
    let operation: DirectSessionImportOperation | null = null;
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') {
        operation = { sessionId: 's1', state: 'running', phase: 'importing', importedCount: 5, canCancel: true };
      }
      return { ok: true, operation };
    });
    const { useDirectSessionTakeover } = await import('./useDirectSessionTakeover');
    type Input = { sessionId: string; runtime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'> };
    const harness = await renderHook<ReturnType<typeof useDirectSessionTakeover>, Input>((input) => useDirectSessionTakeover({
      sessionId: input.sessionId, hasWriteAccess: true, directSessionRuntime: input.runtime,
    }), { initialProps: { sessionId: 's1', runtime: { directSessionLink, status, refreshNow: vi.fn(async () => status) } } });
    let result: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then((ready) => { result = ready; }); });
    await flushHookEffects();
    await harness.rerender({ sessionId: 's2', runtime: { directSessionLink: null, status: null, refreshNow: vi.fn(async () => null) } });
    expect(result).toBe(false);
    expect(harness.getCurrent().importOperation).toBeNull();
    machineRpcSpy.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(machineRpcSpy).not.toHaveBeenCalled();
    await harness.unmount();
  });

  it('settles a pending send and enables retry when the daemon no longer owns an import after restart', async () => {
    let operation: DirectSessionImportOperation | null = null;
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') {
        operation = { sessionId: 's1', state: 'running', phase: 'importing', importedCount: 5, canCancel: true };
      }
      return { ok: true, operation };
    });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    let result: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then((ready) => { result = ready; }); });
    await flushHookEffects();
    expect(harness.getCurrent().takeoverInFlight).toBe('persisted');
    operation = null;
    await act(async () => { await harness.getCurrent().refreshImport(); });
    expect(result).toBe(false);
    expect(harness.getCurrent().importOperation).toBeNull();
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    await harness.unmount();
  });

  it('pauses status requests while hidden, restores progress on return, and stops after unmount', async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const documentStub = { visibilityState: 'visible', addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal('document', documentStub);
    machineRpcSpy.mockResolvedValue({ ok: true, operation: { sessionId: 's1', state: 'running', phase: 'reading', importedCount: 0, canCancel: true } });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockClear();
    documentStub.visibilityState = 'hidden';
    await act(async () => { for (const listener of listeners) listener(); await vi.advanceTimersByTimeAsync(10_000); });
    expect(machineRpcSpy).not.toHaveBeenCalled();
    documentStub.visibilityState = 'visible';
    await act(async () => { for (const listener of listeners) listener(); });
    expect(machineRpcSpy).toHaveBeenCalled();
    await harness.unmount();
    machineRpcSpy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(machineRpcSpy).not.toHaveBeenCalled();
  });

  it('observes the daemon after a lost start acknowledgement instead of launching another import', async () => {
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') throw new Error('transport disconnected');
      return { ok: true, operation: { sessionId: 's1', state: 'completed', phase: 'converting', importedCount: 23, canCancel: false } };
    });
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(true); });
    expect(harness.getCurrent().importOperation?.importedCount).toBe(23);
    expect(machineRpcSpy.mock.calls.filter(([request]) => request.method === 'daemon.directSessions.takeoverPersist.start')).toHaveLength(1);
    await harness.unmount();
  });

  it('preserves the draft and original daemon address when completion refresh fails after conversion', async () => {
    vi.useFakeTimers();
    let operation: DirectSessionImportOperation | null = null;
    machineRpcSpy.mockImplementation(async ({ method }) => {
      if (method === 'daemon.directSessions.takeoverPersist.start') {
        operation = { sessionId: 's1', state: 'running', phase: 'importing', importedCount: 23, canCancel: true };
      }
      return { ok: true, operation };
    });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    let result: boolean | undefined;
    await act(async () => { void harness.getCurrent().requestTakeover('persisted').then((ready) => { result = ready; }); });
    await flushHookEffects();
    await harness.rerender({ directSessionLink: null, status: null, refreshNow: vi.fn(async () => null) });
    operation = { sessionId: 's1', state: 'completed', phase: 'converting', importedCount: 23, canCancel: false };
    refreshSessionsSpy.mockRejectedValueOnce(new Error('refresh disconnected'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result).toBe(false);
    expect(harness.getCurrent().importOperation?.state).toBe('completed');
    expect(harness.getCurrent().importStatusError).not.toBeNull();
    await act(async () => { await harness.getCurrent().refreshImport(); });
    expect(harness.getCurrent().importStatusError).toBeNull();
    await harness.unmount();
  });

  it('requires a daemon update when async imports are unavailable without falling back to synchronous import', async () => {
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockRejectedValue(new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(false); });
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'chatFooter.directImportRequiresDaemonUpgrade');
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeoverPersist')).toBe(false);
    await harness.unmount();
  });

  it('acknowledges import intent while preflight status is still pending', async () => {
    const latestStatus = createDeferred<NonNullable<UseDirectSessionRuntimeResult['status']>>();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: () => latestStatus.promise });
    let ready: Promise<boolean> | undefined;
    await act(async () => { ready = harness.getCurrent().requestTakeover('persisted'); });
    expect(harness.getCurrent().takeoverInFlight).toBe('persisted');
    expect(harness.getCurrent().importOperation).toBeNull();
    await act(async () => { latestStatus.resolve({ ...status, machineOnline: false }); await ready; });
    expect(harness.getCurrent().takeoverInFlight).toBeNull();
    await harness.unmount();
  });

  it('rechecks admission when terminal recovery starts during takeover preflight', async () => {
    const observation = createDeferred<{ ok: true; operation: DirectSessionImportOperation | null }>();
    const latestStatus = createDeferred<NonNullable<UseDirectSessionRuntimeResult['status']>>();
    const refresh = createDeferred<void>();
    refreshSessionsSpy.mockReturnValueOnce(refresh.promise);
    machineRpcSpy.mockImplementation(async ({ method }) => method === 'daemon.directSessions.import.status'
      ? observation.promise : { ok: true, operation: { sessionId: 's1', state: 'running', phase: 'preparing', importedCount: 0, canCancel: true } });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: () => latestStatus.promise });
    let request: Promise<boolean> | undefined;
    await act(async () => { request = harness.getCurrent().requestTakeover('persisted'); });
    await act(async () => { observation.resolve({ ok: true, operation: { sessionId: 's1', state: 'failed', phase: 'importing', importedCount: 5, canCancel: false } }); });
    await act(async () => { latestStatus.resolve(status); });
    await flushHookEffects();
    expect(machineRpcSpy.mock.calls.some(([entry]) => entry.method === 'daemon.directSessions.takeoverPersist.start')).toBe(false);
    await act(async () => { expect(await request).toBe(false); refresh.resolve(); });
    await harness.unmount();
  });

  it('does not admit retry during recovered terminal refresh with no original request', async () => {
    const refresh = createDeferred<void>();
    refreshSessionsSpy.mockReturnValueOnce(refresh.promise);
    machineRpcSpy.mockResolvedValue({ ok: true, operation: { sessionId: 's1', state: 'failed', phase: 'importing', importedCount: 5, canCancel: false } });
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    expect(harness.getCurrent().importOperation?.state).toBe('failed');
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(false); });
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeoverPersist.start')).toBe(false);
    await act(async () => { refresh.resolve(); });
    await harness.unmount();
  });

  it('does not let a retry overwrite the pending request during terminal refresh', async () => {
    const refresh = createDeferred<void>();
    const harness = await renderHarness({ directSessionLink, status, refreshNow: vi.fn(async () => status) });
    machineRpcSpy.mockResolvedValue({ ok: true, operation: { sessionId: 's1', state: 'failed', phase: 'importing', importedCount: 5, canCancel: false } });
    refreshSessionsSpy.mockReturnValueOnce(refresh.promise);
    let original: Promise<boolean> | undefined;
    await act(async () => { original = harness.getCurrent().requestTakeover('persisted'); });
    await flushHookEffects();
    expect(harness.getCurrent().importOperation?.state).toBe('failed');
    await act(async () => { expect(await harness.getCurrent().requestTakeover('persisted')).toBe(false); });
    await act(async () => { refresh.resolve(); expect(await original).toBe(false); });
    expect(machineRpcSpy.mock.calls.filter(([request]) => request.method === 'daemon.directSessions.takeoverPersist.start')).toHaveLength(1);
    await harness.unmount();
  });

  it('uses the owning session server when footer takeover is requested after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().requestTakeover('direct');
    });

    expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: { machineId: 'machine-1', sessionId: 's1' },
      method: 'daemon.directSessions.takeover', serverId: 'server-owned',
    }));
    await harness.unmount();
  });

  it('re-checks direct-session status before manual takeover after a server switch', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      machineOnline: false,
    }));
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    let ready = true;
    await act(async () => {
      ready = await harness.getCurrent().requestTakeover('direct');
    });

    expect(ready).toBe(false);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeover')).toBe(false);
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'chatFooter.directSessionMachineOffline');
    await harness.unmount();
  });

  it('uses the owning session server when send takeover is confirmed after an active-server switch', async () => {
    const refreshNow = vi.fn(async () => status);
    showDirectSessionTakeoverDialogSpy.mockResolvedValueOnce({ action: 'direct', forceStop: false });
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    await act(async () => {
      await harness.getCurrent().ensureReadyForSend();
    });

    expect(showDirectSessionTakeoverDialogSpy).toHaveBeenCalledWith({
      canTakeOverDirect: true,
      canTakeOverPersist: true,
      canForceStop: false,
    });
    expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: { machineId: 'machine-1', sessionId: 's1' },
      method: 'daemon.directSessions.takeover', serverId: 'server-owned',
    }));
    await harness.unmount();
  });

  it('re-checks direct-session status before prompting for send takeover after a server switch', async () => {
    const refreshNow = vi.fn(async () => ({
      ...status,
      runnerActive: true,
    }));
    const harness = await renderHarness({ directSessionLink, status, refreshNow });

    activeServerId = 'server-2';
    let ready = false;
    await act(async () => {
      ready = await harness.getCurrent().ensureReadyForSend();
    });

    expect(ready).toBe(true);
    expect(refreshNow).toHaveBeenCalledTimes(1);
    expect(showDirectSessionTakeoverDialogSpy).not.toHaveBeenCalled();
    expect(machineRpcSpy.mock.calls.some(([request]) => request.method === 'daemon.directSessions.takeover')).toBe(false);
    await harness.unmount();
  });
});
