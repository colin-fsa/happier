import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionHandoffPrepareTargetResultGetResponseSchema, SessionHandoffStartResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

afterEach(() => { vi.doUnmock('@/configuration'); vi.unstubAllEnvs(); vi.resetModules(); });

async function withLocalHandoff(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const root = await mkdtemp(join(os.tmpdir(), 'happier-local-handoff-'));
  try { await run(await createFixture(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

async function createFixture(root: string) {
  vi.resetModules();
  vi.doMock('@/configuration', () => ({ configuration: { activeServerDir: join(root, 'server'), activeServerId: 'local-handoff-test' } }));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  const sourcePath = join(root, 'code');
  const targetPath = join(sourcePath, 'my-app');
  await mkdir(targetPath, { recursive: true });
  const transcript = '{"type":"user","message":{"role":"user","content":"keep this history"}}\n';
  const transcriptPath = join(root, 'source.jsonl');
  await writeFile(transcriptPath, transcript);
  const registered = new Map<string, (raw: unknown) => unknown>();
  // The registry is the network boundary; domain handlers, stores and provider import/export stay real.
  const rpcHandlerManager = {
    registerHandler: (method: string, handler: (raw: unknown) => unknown) => registered.set(method, handler),
    invokeLocal: async (method: string, raw: unknown) => {
      const handler = registered.get(method);
      if (!handler) throw new Error(`Missing RPC ${method}`);
      return await handler(raw);
    },
  } as unknown as RpcHandlerManager;
  let running = true;
  let stopCount = 0;
  let launchedDirectory: string | undefined;
  const { registerMachineSessionHandoffRpcHandlers } = await import('./rpcHandlers.sessionHandoff');
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager,
    loadSessionMetadata: async () => ({ machineId: 'local', path: sourcePath, flavor: 'claude', claudeSessionId: 'native-session', claudeTranscriptPath: transcriptPath }),
    stopSessionForHandoff: async () => { stopCount++; const result = running ? 'stopped' : 'already_inactive'; running = false; return result; },
    spawnSessionForHandoff: async (options, hooks) => {
      await hooks.onBeforeRunnerLaunchAccepted?.();
      running = true;
      launchedDirectory = options.directory;
      return { type: 'success', sessionId: 'session', runnerAcceptance: 'newly_accepted' };
    },
  });
  const call = async (method: string, raw: unknown): Promise<unknown> => {
    const handler = registered.get(method);
    if (!handler) throw new Error(`Missing RPC ${method}`);
    return await handler(raw);
  };
  const startRequest = { sessionId: 'session', sourceMachineId: 'local', targetMachineId: 'local', targetPath, sessionStorageMode: 'persisted', preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer' };
  const startAndPrepare = async () => {
    const started = SessionHandoffStartResponseSchema.parse(await call(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, startRequest));
    await call(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, {
      handoffId: started.handoffId, sessionId: 'session', sourceMachineId: 'local', targetMachineId: 'local', targetPath,
      sourceSessionStorageMode: 'persisted', negotiatedTransportStrategy: 'direct_peer', allowServerRoutedFallback: false, endpointCandidates: started.endpointCandidates, handoffMetadataV2: started.handoffMetadataV2,
    });
    const prepared = await vi.waitFor(async () => SessionHandoffPrepareTargetResultGetResponseSchema.parse(await call(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2, { handoffId: started.handoffId, sessionId: 'session' })), { timeout: 5000, interval: 10 });
    return { started, prepared };
  };
  return { call, startRequest, startAndPrepare, targetPath, sourcePath, transcript, state: () => ({ running, stopCount, launchedDirectory }) };
}

describe('same-machine session handoff', () => {
  it('keeps the resumed runner and native transcript through target commit, source cleanup and retries', async () => {
    await withLocalHandoff(async (fixture) => {
      const { started, prepared } = await fixture.startAndPrepare();
      const attempt = { handoffId: started.handoffId, sessionId: 'session', attemptId: 'local-attempt' };
      expect(prepared.resume).toMatchObject({ directory: fixture.targetPath, resume: 'native-session' });
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, attempt)).resolves.toMatchObject({ disposition: 'started_for_handoff' });
      await fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2, attempt);
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2, { ...attempt, mode: 'target' })).resolves.toMatchObject({ status: { status: 'completed' } });
      for (let retry = 0; retry < 2; retry++) {
        await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, { handoffId: started.handoffId, mode: 'source_cleanup' })).resolves.toMatchObject({ status: { status: 'completed' } });
      }
      expect(fixture.state()).toEqual({ running: true, stopCount: 1, launchedDirectory: fixture.targetPath });
      const source = prepared.directSource as { configDir: string; projectId: string };
      expect(await readFile(join(source.configDir, 'projects', source.projectId, 'native-session.jsonl'), 'utf8')).toBe(fixture.transcript);
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, { handoffId: started.handoffId, sessionId: 'session', reason: 'late-cancel' })).resolves.toMatchObject({ status: { status: 'completed' } });
      expect(fixture.state().running).toBe(true);
    });
  });

  it.each([undefined, ' ', 'same-directory'])('rejects invalid local destination %s before stopping the source', async (destination) => {
    await withLocalHandoff(async (fixture) => {
      const targetPath = destination === 'same-directory' ? join(fixture.sourcePath, 'my-app', '..') : destination;
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, { ...fixture.startRequest, targetPath })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_target_path' });
      expect(fixture.state()).toMatchObject({ running: true, stopCount: 0 });
    });
  });

  it('aborts the source-only stage through the same v2 owner before a target job exists', async () => {
    await withLocalHandoff(async (fixture) => {
      const started = SessionHandoffStartResponseSchema.parse(await fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, fixture.startRequest));
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, { handoffId: started.handoffId, sessionId: 'session', reason: 'cancel' })).resolves.toMatchObject({ status: { status: 'aborted' } });
      expect(fixture.state()).toMatchObject({ running: false, stopCount: 1 });
    });
  });

  it('cancels a local prepare job before its v2 runner ownership is created', async () => {
    await withLocalHandoff(async (fixture) => {
      const started = SessionHandoffStartResponseSchema.parse(await fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, fixture.startRequest));
      await fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, {
        handoffId: started.handoffId, sessionId: 'session', sourceMachineId: 'local', targetMachineId: 'local', targetPath: fixture.targetPath,
        sourceSessionStorageMode: 'persisted', negotiatedTransportStrategy: 'direct_peer', allowServerRoutedFallback: false, endpointCandidates: started.endpointCandidates, handoffMetadataV2: started.handoffMetadataV2,
      });
      const abort = { handoffId: started.handoffId, sessionId: 'session', reason: 'cancel' };
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, abort)).resolves.toMatchObject({ status: { status: 'aborted' } });
      await expect(fixture.call(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, abort)).resolves.toMatchObject({ status: { status: 'aborted' } });
      expect(fixture.state()).toMatchObject({ running: false, stopCount: 1 });
    });
  });
});
