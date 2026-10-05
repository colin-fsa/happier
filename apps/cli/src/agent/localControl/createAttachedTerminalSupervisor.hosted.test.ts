import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { writeDaemonSettingsFixture, withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

const sockets = vi.hoisted(() => ({ io: vi.fn() }));
const filesystem = vi.hoisted(() => ({
  beforeRead: null as null | ((path: Parameters<typeof import('node:fs/promises')['readFile']>[0]) => Promise<void>),
  beforeUnlink: null as null | ((path: Parameters<typeof import('node:fs/promises')['unlink']>[0]) => Promise<undefined | (() => Promise<void>)>),
  afterRead: null as null | ((path: Parameters<typeof import('node:fs/promises')['readFile']>[0]) => void),
  beforeRename: null as null | ((source: Parameters<typeof import('node:fs/promises')['rename']>[0],
    destination: Parameters<typeof import('node:fs/promises')['rename']>[1]) => Promise<void>),
}));
// Scheduling at the genuine FS boundary leaves serialization, locks and the actual rename real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    await filesystem.beforeRead?.(args[0]);
    const result = await actual.readFile(...args);
    filesystem.afterRead?.(args[0]);
    return result;
  }, unlink: async (...args: Parameters<typeof actual.unlink>) => {
    const cleanup = await filesystem.beforeUnlink?.(args[0]);
    try { return await actual.unlink(...args); }
    finally { await cleanup?.(); }
  }, rename: async (...args: Parameters<typeof actual.rename>) => {
    await filesystem.beforeRename?.(...args);
    return await actual.rename(...args);
  } };
});
// Socket.IO is the relay boundary; the real Session client and mode projection stay in use.
vi.mock('socket.io-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('socket.io-client')>(), io: sockets.io,
}));

import { ApiSessionClient } from '@/api/session/sessionClient';
import { createAttachedTerminalSupervisor } from './createAttachedTerminalSupervisor';
import { createSharedProviderLocalControl } from './createSharedProviderLocalControl';
import { createHerdrClient } from '@/integrations/herdr/client';
import { createHerdrTerminalHostAdapter } from '@/integrations/herdr/adapter';
import { readTerminalAttachmentInfo, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { launchOwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import type { OwnedTerminalProcessIdentity } from '@/terminal/runtime/ownedTerminalProcess';
import { proveTerminalClientCustody, retireTerminalClientProcess } from '@/terminal/runtime/terminalClientCustody';
import { superviseTrackedOptionalTerminalPresentation } from '@/daemon/sessions/disconnectedTerminalHostSupervision';
import { clearTerminalControlServiceabilityProjection } from '@/daemon/sessions/terminalControlServiceabilityProjection';
import type { Metadata } from '@/api/types';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { startDaemonHeartbeatLoop } from '@/daemon/lifecycle/heartbeat';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import { handleAttachCommand } from '@/cli/commands/attach';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';
import Fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { acquireSessionRunnerLock } from '@/daemon/sessionRunnerLock';
import { logger } from '@/ui/logger';
import { createOpenCodeTuiSupervisor } from '@/backends/opencode/localControl/openCodeTuiSupervisor';
import { createCodexSharedLocalControl } from '@/backends/codex/localControl/createCodexSharedLocalControl';
import { writeCodexSharedControlEndpoint } from '@/backends/codex/localControl/codexSharedControlEndpoint';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import { readProcessRunState } from '@/daemon/processRunState';
import { isSupportedHerdrVersion } from '@/integrations/herdr/runtimeBinary';

// Real-host cases require the same supported binary as production; socket-fixture
// cases below provide their own executable boundary and always remain runnable.
const herdrVersion = spawnSync(process.env.HERDR_BIN_PATH?.trim() || 'herdr', ['--version'], { encoding: 'utf8' });
const hasSupportedHerdr = herdrVersion.status === 0 && isSupportedHerdrVersion(herdrVersion.stdout);

const httpCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of httpCleanups.splice(0)) await cleanup();
  sockets.io.mockReset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  filesystem.beforeRename = null;
  filesystem.beforeRead = null;
  filesystem.afterRead = null;
  filesystem.beforeUnlink = null;
});

async function createSharedSession(homeDir: string, id: string, beforeMetadataAck?: () => Promise<void | false>,
  deliverMetadataUpdate: (publish: () => void) => void = publish => publish()): Promise<ApiSessionClient> {
  // The genuine Herdr process must use this fixture's private configuration/namespace root.
  vi.stubEnv('HERDR_CONFIG_PATH', join(homeDir, 'herdr.toml'));
  vi.stubEnv('XDG_CONFIG_HOME', homeDir);
  await writeDaemonSettingsFixture(homeDir, {
    machineIdByServerId: { [configuration.activeServerId]: 'fixture-machine' },
  });
  const relay = Fastify();
  relay.get('/v1/access-keys/:sessionId/:machineId', async () => ({ accessKey: { id: 'synthetic-machine-key' } }));
  await relay.ready();
  const restoreHttp = installAxiosFastifyAdapter({ app: relay, origin: new URL(resolveServerHttpBaseUrl()).origin });
  httpCleanups.push(async () => { restoreHttp(); await relay.close(); });
  let session: ApiSessionClient;
  const relaySockets = new Set<ReturnType<typeof createApiSessionSocketStub>>();
  const createSocket = () => {
    const socket = createApiSessionSocketStub({ connected: true,
    onConnect: socket => queueMicrotask(() => socket.trigger('connect')),
    emit: (event, args) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return;
      // This untyped network envelope is consumed by the real runner RPC authority.
      const request = args[0] as Parameters<ApiSessionClient['rpcHandlerManager']['handleRequest']>[0];
      const acknowledge = args[1];
      if (typeof acknowledge !== 'function') throw new Error('Fixture RPC acknowledgement missing');
      void session.rpcHandlerManager.handleRequest(request).then(result => acknowledge({ ok: true, result }),
        () => acknowledge({ ok: false, error: 'Fixture runner RPC rejected' }));
    },
    emitWithAck: async (event, payload, transport) => {
      if (event === 'update-metadata' || event === 'update-state') {
        const body = payload as { sid: string; metadata?: unknown; agentState?: unknown; expectedVersion: number };
        if (event === 'update-metadata' && await beforeMetadataAck?.() === false) {
          return { result: 'error', error: 'fixture metadata retirement refused' };
        }
        if (event === 'update-metadata') deliverMetadataUpdate(() => {
          for (const subscriber of relaySockets) subscriber.trigger('update', { id: 'metadata-update', seq: body.expectedVersion + 1,
            createdAt: Date.now(), body: { t: 'update-session', sid: body.sid,
              metadata: { value: body.metadata, version: body.expectedVersion + 1 } } });
        });
        return { result: 'success', metadata: body.metadata, agentState: body.agentState, version: body.expectedVersion + 1 };
      }
      return resolveApiSessionSocketDefaultAck(event, payload);
    },
    });
    relaySockets.add(socket);
    return socket;
  };
  sockets.io.mockImplementation(createSocket);
  // Feature negotiation remains real against a supported older server with no features endpoint.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  const fixture = createPlainSessionFixture({ id });
  session = new ApiSessionClient('synthetic-token', { ...fixture, metadata: { ...fixture.metadata, path: homeDir,
    startedBy: 'daemon', machineId: 'fixture-machine',
    agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({ backendMode: 'appServer', vendorSessionId: 'same-native-session' }),
  } });
  return session;
}

describe('shared hosted native presentation', () => {
  it.skipIf(process.platform !== 'linux' || !hasSupportedHerdr)('proves released Herdr foreground custody and retires only the actual launcher tree', async ({ task }) => {
    await withConfiguredDaemonTestHome({ prefix: 'native-custody-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'native-custody-session');
      const binary = process.env.HERDR_BIN_PATH ?? 'herdr';
      const sessionName = `custody-${process.pid}`;
      const client = createHerdrClient({ binary, sessionName, actionTimeoutMs: 30_000, startupTimeoutMs: 30_000 });
      const identityPath = join(homeDir, 'launcher.json');
      const nativePath = join(homeDir, 'native.json');
      const invocation = { command: process.execPath, args: ['-e',
        `require('node:fs').writeFileSync(${JSON.stringify(nativePath)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`] };
      const prepared = await prepareOwnedTerminalSpawn({ ...invocation, cwd: homeDir, env: process.env });
      const source = `
        const { launchOwnedTerminalProcess } = await import(${JSON.stringify(pathToFileURL(resolve('src/terminal/runtime/ownedTerminalProcess.ts')).href)});
        const { writeFile } = await import('node:fs/promises');
        const child = await launchOwnedTerminalProcess({ spawn: ${JSON.stringify({ spawnArgv: prepared.spawnArgv, spawnEnv: prepared.spawnEnv })}, cwd: ${JSON.stringify(homeDir)} });
        await writeFile(${JSON.stringify(identityPath)}, JSON.stringify(child.launcherIdentity));
        await child.whenExited;
        // The restored foreground wrapper remains available after managed Detach.
        setInterval(() => {}, 1000);
      `;
      let paneId: string | undefined;
      try {
        await client.ensureServer();
        const pane = await client.createPane({ cwd: process.cwd(), argv: [process.execPath, '--import', 'tsx', '--input-type=module', '-e', source], env: {}, label: 'custody-probe' });
        paneId = pane.paneId;
        let identity!: OwnedTerminalProcessIdentity;
        let native!: { pid: number };
        try {
          await vi.waitFor(async () => {
            identity = JSON.parse(await readFile(identityPath, 'utf8'));
            native = JSON.parse(await readFile(nativePath, 'utf8'));
            expect(identity.pid).toBeGreaterThan(1);
          }, { timeout: task.timeout });
        } catch (error) {
          // This isolated pane runs only the fixture script above, not an authenticated agent.
          const output = await client.readPane(pane.paneId);
          const processes = await client.processInfo(pane.paneId);
          const state = processes.shellPid ? await readProcessRunState(processes.shellPid) : 'no_shell';
          throw new Error(`Released Herdr fixture launcher did not start: ${JSON.stringify({
            output: { length: output.length, errorCode: output.match(/\bERR_[A-Z_]+\b/)?.[0] ?? null },
            shellPid: processes.shellPid, state, foreground: processes.foregroundProcesses.map(item => ({
              pid: item.pid, executable: item.argv[0], argvLength: item.argv.length,
            })),
          })}`, { cause: error });
        }
        const info = await client.processInfo(pane.paneId);
        expect(info.foregroundProcesses.map(process => process.pid)).toEqual(expect.arrayContaining([identity.pid, native.pid]));
        const admitted = await proveTerminalClientCustody({ launcher: identity, processes: info, invocation });
        expect(admitted, JSON.stringify({ shellPid: info.shellPid, launcherPid: identity.pid, nativePid: native.pid,
          processes: info.foregroundProcesses.map(process => ({ pid: process.pid, executable: process.argv[0],
            argvLength: process.argv.length, nativeArgsMatch: process.pid === native.pid && process.argv.slice(1).every((arg, i) => arg === invocation.args[i]) })) })).toBe(true);
        await retireTerminalClientProcess(identity);
        expect(await client.getPane(pane.paneId)).toMatchObject({ terminalId: pane.terminalId });
        await vi.waitFor(() => expect(() => process.kill(native.pid, 0)).toThrow());
      } finally {
        if (paneId) await client.closePane(paneId).catch(() => undefined);
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
        await prepared.cleanupUnreadArtifacts();
        await session.close();
      }
    });
  });
  it.skipIf(process.platform !== 'linux').each(['local_descriptor', 'heartbeat_retired', 'retired_metadata_changes', 'retired_descriptor_replaced', 'detach_reattach'] as const)('public attach inside the restored pane rebinds the live headless controller without creating a pane (%s)', async previousCustody => {
    await withConfiguredDaemonTestHome({ prefix: 'restored-public-client-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'same-happier-cold-session');
      const lock = await acquireSessionRunnerLock({ happyHomeDir: homeDir, sessionId: session.sessionId });
      if (!lock.ok) throw new Error('Synthetic controller could not acquire its runner lock');
      const nativeFile = join(homeDir, 'native.json');
      const cliPath = join(homeDir, 'native-codex.js');
      await writeFile(cliPath, `require('node:fs').writeFileSync(${JSON.stringify(nativeFile)},JSON.stringify({pid:process.pid,parent:process.ppid,args:process.argv.slice(2)}));setInterval(()=>{},1000)`);
      vi.stubEnv('HAPPIER_CODEX_TUI_BIN', cliPath);
      await writeCodexSharedControlEndpoint({ happyHomeDir: homeDir, sessionId: session.sessionId, endpoint: 'unix:///same-running-controller.sock' });
      let control: ReturnType<typeof createCodexSharedLocalControl> | undefined;
      let front: Promise<void> | undefined;
      let frontFailure: unknown;
      let apiSocketPath = '';
      try {
        await withHerdrApi(async api => {
          vi.stubEnv('HERDR_BIN_PATH', api.binary);
          apiSocketPath = api.socketPath;
          try {
          const terminal = { mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath,
            paneId: 'managed', terminalId: 'old-cold-terminal' } } as const;
          await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId, attachmentId: 'old-cold-attachment', terminal,
            handle: { kind: 'herdr', ...terminal.herdr, attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } } });
          await session.updateMetadata(metadata => ({ ...metadata, terminal: { ...terminal,
            controlServiceabilityV1: { v: 1, attachmentId: 'old-cold-attachment', state: 'servable', observedAt: Date.now() },
          } }));
          control = createCodexSharedLocalControl({ startingMode: 'remote', getSession: () => session,
            getSessionId: () => 'same-native-session', directory: homeDir, endpoint: 'unix:///same-running-controller.sock',
            terminalRuntime: { mode: 'plain', requested: 'herdr', herdrSessionName: 'work', herdrSocketPath: api.socketPath } });
          await control.onAfterStart();
          if (previousCustody !== 'local_descriptor') {
            // The real optional-host retirement owner removes dead local custody while
            // preserving the live controller and its canonical historical placement.
            const tracked: TrackedSession = { pid: process.pid, startedBy: 'daemon', happySessionId: session.sessionId,
              spawnOptions: { directory: homeDir, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                codexBackendMode: 'appServer', terminal: { mode: 'herdr' } } };
            const adapterOptions = { binary: process.env.HERDR_BIN_PATH ?? 'herdr', sessionName: 'work',
              socketPath: api.socketPath, actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
              startupTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs };
            const adapter = createHerdrTerminalHostAdapter({ ...adapterOptions, client: createHerdrClient(adapterOptions) });
            await superviseTrackedOptionalTerminalPresentation({ tracked, isCurrent: () => true, happyHomeDir: homeDir,
              loadTerminalHostAdapters: async () => ({ herdr: adapter }),
              retireExactTerminalControlServiceability: async ({ attachmentInfo }) => {
                await session.updateMetadata(metadata => clearTerminalControlServiceabilityProjection({ metadata,
                  retiredAttachmentId: attachmentInfo.attachmentId, retiredAt: Date.now(), terminalMode: 'herdr' }));
              },
            });
            expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
            expect(session.getMetadataSnapshot()?.terminal?.controlServiceabilityV1).toMatchObject({
              attachmentId: 'old-cold-attachment', retired: true,
            });
          }
          vi.stubEnv('HERDR_ENV', '1'); vi.stubEnv('HERDR_SOCKET_PATH', api.socketPath); vi.stubEnv('HERDR_PANE_ID', 'managed');
          vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`Fixture process exit ${code ?? 0}`); });
          const before = session.getMetadataSnapshot()!;
          front = handleAttachCommand([session.sessionId], {
            readCredentialsFn: async () => ({ token: 'synthetic-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
            fetchSessionByIdFn: async () => createSessionRecordFixture({ id: session.sessionId, active: true,
              encryptionMode: 'plain', metadata: JSON.stringify(before), agentState: JSON.stringify(session.getAgentStateSnapshot()) }),
          }).catch(error => { frontFailure = error; });
          if (previousCustody === 'retired_metadata_changes' || previousCustody === 'retired_descriptor_replaced') {
            await front;
            expect(frontFailure).toBeDefined();
            expect(api.requests.some(request => request.method === 'layout.apply' || request.method === 'pane.close')).toBe(false);
            expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: false, canDetach: false });
            const native = JSON.parse(await readFile(nativeFile, 'utf8')) as { pid: number };
            await vi.waitFor(() => expect(() => process.kill(native.pid, 0)).toThrow());
            const remaining = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
            if (previousCustody === 'retired_descriptor_replaced') expect(remaining).toMatchObject({ attachmentId: 'replacement-attachment' });
            else expect(remaining).toBeNull();
            return;
          }
          await vi.waitFor(() => {
            if (frontFailure) throw frontFailure;
            expect(session.getMetadataSnapshot()?.terminal?.herdr?.terminalId === 'terminal_1'
              || api.requests.some(request => request.method === 'layout.apply')).toBe(true);
          }, { timeout: resolveSessionStartupTimeoutMs() });
          expect(api.requests.some(request => request.method === 'layout.apply')).toBe(false);
          await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: true, canDetach: true, remoteWritable: true }));
          const native = JSON.parse(await readFile(nativeFile, 'utf8')) as { args: string[]; pid: number };
          expect(native.args).toEqual(['--remote', 'unix:///same-running-controller.sock', '--cd', homeDir, 'resume', 'same-native-session']);
          expect(session.sessionId).toBe('same-happier-cold-session');
          expect(await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).toBe(true);
          await front;
          // The existing native leaf maps a signal exit to code 1. Managed Detach
          // owns presentation retirement, not a new native CLI exit-code policy.
          expect(frontFailure).toEqual(new Error('Fixture process exit 1'));
          expect(api.requests.some(request => request.method === 'pane.close')).toBe(false);
          expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
          if (previousCustody === 'detach_reattach') {
            // Real managed Detach retired the client, not its current shell. A
            // second public attach must reuse that same pane and conversation.
            await unlink(nativeFile);
            frontFailure = undefined;
            const retired = session.getMetadataSnapshot()!;
            front = handleAttachCommand([session.sessionId], {
              readCredentialsFn: async () => ({ token: 'synthetic-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
              fetchSessionByIdFn: async () => createSessionRecordFixture({ id: session.sessionId, active: true,
                encryptionMode: 'plain', metadata: JSON.stringify(retired), agentState: JSON.stringify(session.getAgentStateSnapshot()) }),
            }).catch(error => { frontFailure = error; });
            await vi.waitFor(() => {
              if (frontFailure) throw frontFailure;
              expect(session.getAgentStateSnapshot()?.localControl?.attached === true
                || api.requests.some(request => request.method === 'layout.apply')).toBe(true);
            }, { timeout: resolveSessionStartupTimeoutMs() });
            expect(api.requests.some(request => request.method === 'layout.apply')).toBe(false);
            expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: true, canDetach: true });
            const nextNative = JSON.parse(await readFile(nativeFile, 'utf8')) as { args: string[]; pid: number };
            expect(nextNative.pid).not.toBe(native.pid);
            expect(nextNative.args).toEqual(native.args);
            expect(await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).toBe(true);
            await front;
            expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
            expect(api.requests.some(request => request.method === 'pane.close')).toBe(false);
          }
          } finally { await control?.dispose(); await front; }
        }, { response: async method => {
          if (method !== 'pane.process_info') return undefined;
          let native: { pid: number; parent: number } | undefined;
          await vi.waitFor(async () => { native = JSON.parse(await readFile(nativeFile, 'utf8')); expect(native).toBeDefined(); },
            { timeout: resolveSessionStartupTimeoutMs() });
          if (previousCustody === 'retired_metadata_changes') {
            await session.updateMetadata(metadata => ({ ...metadata, terminal: { ...metadata.terminal,
              mode: 'herdr', herdr: { sessionName: 'work', socketPath: apiSocketPath, paneId: 'managed', terminalId: 'different-historical-host' },
            } }));
          } else if (previousCustody === 'retired_descriptor_replaced') {
            const terminal = { mode: 'herdr', herdr: { sessionName: 'work', socketPath: apiSocketPath,
              paneId: 'managed', terminalId: 'replacement-terminal' } } as const;
            await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId,
              attachmentId: 'replacement-attachment', terminal, handle: { kind: 'herdr', ...terminal.herdr,
                attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } } });
          }
          const argv = async (pid: number) => (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          return { process_info: { shell_pid: process.pid, foreground_processes: [
            { pid: native!.parent, argv: await argv(native!.parent) }, { pid: native!.pid, argv: await argv(native!.pid) },
          ] } };
        } });
      } finally { await control?.dispose(); await front; await lock.release(); await session.close(); }
    });
  });
  it.skipIf(process.platform === 'win32').each(['detach', 'concurrent_detach_exit', 'detach_retry', 'descriptor_retry', 'descriptor_heartbeat', 'initial_heartbeat', 'native_exit', 'target_changes', 'old_host_alive', 'stale_release', 'concurrent_switch', 'descriptor_changes'] as const)('rebinds a proved restored native client and retires only launcher custody (%s)', async ending => {
    await withConfiguredDaemonTestHome({ prefix: 'restored-client-' }, async ({ homeDir }) => {
      let blockRetirementAck = false;
      let rejectRetirementAck = false;
      let deferRetirementUpdate = false;
      let publishRetirementUpdate: (() => void) | undefined;
      let releaseRetirementAck!: () => void;
      let retirementAckEntered!: () => void;
      const retirementAck = new Promise<void>(resolve => { releaseRetirementAck = resolve; });
      const retirementEntered = new Promise<void>(resolve => { retirementAckEntered = resolve; });
      const session = await createSharedSession(homeDir, 'restored-shared-session', async () => {
        if (rejectRetirementAck) { rejectRetirementAck = false; return false as const; }
        if (!blockRetirementAck) return;
        retirementAckEntered();
        await retirementAck;
        return undefined;
      }, publish => {
        if (deferRetirementUpdate) { deferRetirementUpdate = false; publishRetirementUpdate = publish; }
        else publish();
      });
      const marker = join(homeDir, 'native-client.json');
      const invocation = { command: process.execPath, args: ['-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000)`] };
      const prepared = await prepareOwnedTerminalSpawn({ ...invocation, cwd: homeDir, env: process.env });
      const child = await launchOwnedTerminalProcess({ spawn: prepared, cwd: homeDir });
      try {
        await vi.waitFor(async () => expect(JSON.parse(await readFile(marker, 'utf8')).parent).toBe(child.launcherIdentity?.pid),
          { timeout: resolveSessionStartupTimeoutMs() });
        const native = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; parent: number };
        if (!child.launcherIdentity) throw new Error('Real launcher identity unavailable');
        let mutateDescriptorDuringProof = false;
        await withHerdrApi(async api => {
          vi.stubEnv('HERDR_BIN_PATH', api.binary);
          const terminal = { mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath,
            paneId: 'managed', terminalId: ending === 'old_host_alive' ? 'terminal_1' : 'old-terminal' } } as const;
          await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId, attachmentId: 'old-attachment', terminal,
            handle: { kind: 'herdr', ...terminal.herdr, attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared' } } });
          await session.updateMetadata(metadata => ({ ...metadata, terminal }));
          let control: ReturnType<typeof createSharedProviderLocalControl<string>>;
          let target = 'same-native-session';
          const supervisor = createAttachedTerminalSupervisor({ resolveInvocation: () => invocation,
            terminalPresentation: { runtime: { mode: 'plain', requested: 'herdr', herdrSessionName: 'work', herdrSocketPath: api.socketPath },
              getSession: () => session }, onExit: async () => await control.onTerminalExit() });
          control = createSharedProviderLocalControl({ supported: true, startingMode: 'remote', getSession: () => session,
            resolveTarget: () => target, isSameTarget: (a, b) => a === b, supervisor });
          const retireViaHeartbeat = async () => {
            const tracked: TrackedSession = { pid: process.pid, startedBy: 'daemon', happySessionId: session.sessionId,
              spawnOptions: { directory: homeDir, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                codexBackendMode: 'appServer', terminal: { mode: 'herdr' } } };
            await superviseTrackedOptionalTerminalPresentation({ tracked, isCurrent: () => true, happyHomeDir: homeDir,
              loadTerminalHostAdapters: async () => ({}),
              retireExactTerminalControlServiceability: async ({ attachmentInfo }) => {
                await session.updateMetadata(metadata => clearTerminalControlServiceabilityProjection({ metadata,
                  retiredAttachmentId: attachmentInfo.attachmentId, retiredAt: Date.now(), terminalMode: 'herdr' }));
              },
            });
          };
          await control.onAfterStart();
          const terminalClient = { attached: true, herdr: { ...terminal.herdr, terminalId: 'terminal_1' }, launcher: child.launcherIdentity! };
          // An absent optional method is an observable rejection, not a fixture/import failure.
          const observe = (request: typeof terminalClient) => control.observeTerminalClient?.(request) ?? Promise.resolve(false);
          let concurrentSwitch: Promise<boolean> | undefined;
          try {
            expect(await observe({ ...terminalClient, launcher: { ...terminalClient.launcher, processInstanceFingerprint: 'different-instance' } })).toBe(false);
            expect(await observe({ ...terminalClient, herdr: { ...terminalClient.herdr, terminalId: 'foreign-terminal' } })).toBe(false);
            if (ending === 'old_host_alive') {
              // File logging is the observable output of this real refusal path.
              const refusal = vi.spyOn(logger, 'infoFile');
              expect(await observe(terminalClient)).toBe(false);
              expect(refusal).toHaveBeenLastCalledWith('[terminal] Restored native client admission refused', {
                error: 'terminal_native_client_admission_refused',
                phase: 'previous_host_alive', sessionId: session.sessionId,
              });
              expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toMatchObject({
                version: 2, attachmentId: 'old-attachment', handle: { terminalId: 'terminal_1' },
              });
              return;
            }
            if (ending === 'target_changes') {
              api.beforeResponse.set('pane.process_info', () => { target = 'different-conversation'; });
              expect(await observe(terminalClient)).toBe(false);
              expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toMatchObject({
                version: 2, attachmentId: 'old-attachment', handle: { terminalId: 'old-terminal' },
              });
              return;
            }
            if (ending === 'descriptor_changes') {
              mutateDescriptorDuringProof = true;
              expect(await observe(terminalClient)).toBe(false);
              expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toMatchObject({
                version: 2, attachmentId: 'old-attachment', handle: { terminalId: 'different-host' },
              });
              return;
            }
            if (ending === 'concurrent_switch') {
              api.beforeResponse.set('pane.process_info', () => { concurrentSwitch ??= control.switchToLocal(); });
            }
            expect(await observe(terminalClient)).toBe(true);
            if (ending === 'concurrent_switch') {
              expect(await concurrentSwitch).toBe(true);
              expect(api.requests.some(request => request.method === 'layout.apply')).toBe(false);
            }
            await vi.waitFor(() => expect(session.getAgentStateSnapshot()).toMatchObject({ localControl: { attached: true, canDetach: true, remoteWritable: true } }));
            expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toMatchObject({
              version: 3, lifecycle: 'borrowed', nativeClientProcess: child.launcherIdentity,
              handle: { terminalId: 'terminal_1' },
            });
            if (ending === 'stale_release') {
              const current = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
              if (!current || current.version !== 3) throw new Error('Borrowed fixture was not admitted');
              await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId,
                attachmentId: 'replacement-attachment', handle: current.handle, terminal: current.terminal,
                lifecycle: 'borrowed', nativeClientProcess: child.launcherIdentity! });
              expect(await observe({ ...terminalClient, attached: false })).toBe(false);
              expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toMatchObject({ attachmentId: 'replacement-attachment' });
              expect(() => process.kill(native.pid, 0)).not.toThrow();
              // Exact replacement evidence belongs to its current owner, not the
              // stale release callback or this old supervisor's disposal.
              await expect(control.dispose()).rejects.toThrow('Borrowed native client cleanup is incomplete');
              return;
            }
            if (ending === 'initial_heartbeat') {
              filesystem.beforeRead = async path => {
                if (String(path) !== join(homeDir, 'terminal', 'sessions', `${session.sessionId}.json`)) return;
                filesystem.beforeRead = null;
                // Real native exit and the canonical heartbeat can complete while
                // the first explicit retirement's descriptor read is pending.
                await child.terminate();
                await child.whenExited;
                await retireViaHeartbeat();
                expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
              };
              expect(await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).toBe(true);
            } else if (ending === 'concurrent_detach_exit') {
              // Hold the relay ACK after physical exit but before retirement
              // publication. The exit callback still sees exact local custody.
              blockRetirementAck = true;
              const detaching = session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' });
              await retirementEntered;
              await child.whenExited;
              let exitReleaseFailure: unknown;
              let descriptorReads = 0;
              filesystem.afterRead = path => {
                if (String(path) === join(homeDir, 'terminal', 'sessions', `${session.sessionId}.json`)) descriptorReads++;
              };
              const exited = observe({ ...terminalClient, attached: false }).catch(error => { exitReleaseFailure = error; return false; });
              // Wait until the exit observer has read genuine local custody;
              // only OS/network scheduling is controlled, never its decision.
              try {
                await vi.waitFor(() => expect(descriptorReads).toBeGreaterThanOrEqual(1));
              } finally { releaseRetirementAck(); filesystem.afterRead = null; }
              expect(await detaching).toBe(true);
              const exitedResult = await exited;
              expect(exitReleaseFailure).toBeUndefined();
              expect(exitedResult).toBe(true);
            } else if (ending === 'descriptor_retry' || ending === 'descriptor_heartbeat') {
              const descriptorDir = join(homeDir, 'terminal', 'sessions');
              filesystem.beforeUnlink = async path => {
                if (String(path) !== join(descriptorDir, `${session.sessionId}.json`)) return;
                filesystem.beforeUnlink = null;
                // Deny the actual descriptor unlink after its canonical lock was
                // acquired, then restore permissions for that lock's cleanup.
                await chmod(descriptorDir, 0o500);
                return async () => { await chmod(descriptorDir, 0o700); };
              };
              deferRetirementUpdate = true;
              try {
                await expect(session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' }))
                  .rejects.toThrow('Borrowed native client cleanup is incomplete');
                await child.whenExited;
                expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId }))
                  .toMatchObject({ version: 3, nativeClientProcess: child.launcherIdentity });
                expect(session.getMetadataSnapshot()?.terminal?.controlServiceabilityV1?.retired).toBe(true);
                // Real server updates can arrive after the accepted ACK and failed
                // unlink. They cannot erase the resource's unfinished local cleanup.
                expect(publishRetirementUpdate).toBeDefined();
                publishRetirementUpdate!();
                // The equal-version retirement broadcast is ignored after its
                // ACK. A subsequent real metadata write still carries that
                // retired placement and must not abandon unfinished unlink.
                await session.updateMetadata(metadata => ({ ...metadata, name: 'Renamed after native Detach' }));
              } finally { await chmod(descriptorDir, 0o700); }
              if (ending === 'descriptor_heartbeat') {
                await retireViaHeartbeat();
                expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
              }
              expect(await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).toBe(true);
              expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
            } else if (ending === 'detach_retry') {
              rejectRetirementAck = true;
              await expect(session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' }))
                .rejects.toThrow('Borrowed native client cleanup is incomplete');
              await child.whenExited;
              expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId }))
                .toMatchObject({ version: 3, nativeClientProcess: child.launcherIdentity });
              // The failed exact resource completion must not poison a later
              // Detach once its genuine metadata transport accepts retirement.
              expect(await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' })).toBe(true);
            } else if (ending === 'detach' || ending === 'concurrent_switch') {
              const response = await session.rpcHandlerManager.invokeLocal('switch', { to: 'remote' });
              expect(response).toBe(true);
            } else {
              await child.terminate();
              await child.whenExited;
              await retireViaHeartbeat();
            }
            await child.whenExited;
            expect(supervisor.isAttached()).toBe(false);
            await vi.waitFor(() => expect(session.getAgentStateSnapshot()).toMatchObject({ localControl: { attached: false, canDetach: false } }));
            expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
            expect(api.requests.some(request => request.method === 'pane.close' || request.method === 'layout.apply')).toBe(false);
            expect(() => process.kill(process.pid, 0)).not.toThrow();
          } finally { releaseRetirementAck(); if (ending !== 'stale_release') await control.dispose(); await concurrentSwitch; }
        }, { response: async method => {
          if (method !== 'pane.process_info') return undefined;
          if (ending === 'descriptor_changes' && mutateDescriptorDuringProof) {
            const current = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
            if (!current || current.version !== 2 || !current.terminal.herdr) throw new Error('Old fixture was not bound');
            await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId,
              attachmentId: current.attachmentId, handle: { ...current.handle, terminalId: 'different-host' },
              terminal: { ...current.terminal, herdr: { ...current.terminal.herdr, terminalId: 'different-host' } } });
          }
          return { process_info: { shell_pid: process.pid,
            foreground_processes: [{ pid: child.launcherIdentity!.pid, argv: prepared.spawnArgv },
              { pid: native.pid, argv: [invocation.command, ...invocation.args] }] } };
        } });
      } finally { await child.terminate(); await prepared.cleanupUnreadArtifacts(); await session.close(); }
    });
  });
  it.each(['plain', 'herdr'] as const)('keeps shared remote controls usable after exact native credential preparation fails (%s)', async requested => {
    await withConfiguredDaemonTestHome({ prefix: 'shared-preparation-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'missing-managed-credential');
      // Real managed credential affinity reads this isolated empty home. The
      // missing exact fingerprint must not fall back to any ambient credential.
      const target = { baseUrl: 'http://127.0.0.1:41997', directory: homeDir,
        sessionId: 'same-native-session', managedServerLaunchFingerprint: 'not-created-in-this-home' };
      const supervisor = createOpenCodeTuiSupervisor({ command: process.execPath,
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir },
        terminalPresentation: { runtime: { mode: 'plain', requested }, getSession: () => session },
      });
      const control = createSharedProviderLocalControl({ supported: true, startingMode: 'local',
        getSession: () => session, resolveTarget: () => target,
        isSameTarget: (left, right) => left === right, supervisor });
      try {
        await expect(control.onAfterStart()).resolves.toBeUndefined();
        expect(control.resolveKeepAliveMode()).toBe('remote');
        expect(control.shouldRenderTerminalDisplay()).toBe(true);
        await vi.waitFor(() => expect(session.getAgentStateSnapshot()).toMatchObject({ controlledByUser: false,
          localControl: { topology: 'shared', attached: false, canDetach: false, canAttach: true, remoteWritable: true } }));
        expect(session.rpcHandlerManager.hasHandler('switch')).toBe(true);
        expect(await control.switchToLocal()).toBe(false);
        expect(control.resolveKeepAliveMode()).toBe('remote');
        expect(supervisor.isAttached()).toBe(false);
        expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
      } finally {
        await control.dispose();
        await session.close();
      }
    });
  });
  it.skipIf(process.platform === 'win32' || !hasSupportedHerdr).each(['normal', 'descriptor_retry'] as const)('keeps the admitted Herdr endpoint after native authentication changes its configuration root (%s)', async ending => {
    await withConfiguredDaemonTestHome({ prefix: 'ep-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'endpoint-native');
      const sessionName = `ep-${process.pid}`;
      const binary = process.env.HERDR_BIN_PATH ?? 'herdr';
      const selected = createHerdrClient({ binary, sessionName, actionTimeoutMs: 30_000, startupTimeoutMs: 30_000 });
      const socketPath = await selected.ensureServer();
      const providerConfigRoot = join(homeDir, 'native-config');
      await mkdir(providerConfigRoot);
      vi.stubEnv('XDG_CONFIG_HOME', providerConfigRoot);
      const nativeReady = join(homeDir, 'native-ready');
      const supervisor = createAttachedTerminalSupervisor({
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir, XDG_CONFIG_HOME: providerConfigRoot },
        terminalPresentation: { runtime: { mode: 'plain', requested: 'herdr', herdrSessionName: sessionName,
          herdrSocketPath: socketPath }, getSession: () => session },
        resolveInvocation: () => ({ command: process.execPath, args: ['-e',
          `if(process.env.XDG_CONFIG_HOME!==${JSON.stringify(providerConfigRoot)})process.exit(2);require('node:fs').writeFileSync(${JSON.stringify(nativeReady)},'ready');setInterval(()=>{},1000)`] }),
      });
      try {
        expect(await supervisor.attach('same-native-session')).toBe(true);
        const attachment = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
        expect(attachment).toMatchObject({ version: 2, handle: { socketPath } });
        await vi.waitFor(async () => expect(await readFile(nativeReady, 'utf8')).toBe('ready'),
          { timeout: resolveSessionStartupTimeoutMs() });
        if (attachment?.version === 2) {
          expect(await selected.findPane(attachment.handle.terminalId!)).not.toBeNull();
        }
        const inventory = await selected.listSessions();
        expect(inventory.some(item => item.name === sessionName && item.running)).toBe(false);
        if (ending === 'descriptor_retry') {
          const descriptorDir = join(homeDir, 'terminal', 'sessions');
          filesystem.beforeUnlink = async path => {
            if (String(path) !== join(descriptorDir, `${session.sessionId}.json`)) return;
            filesystem.beforeUnlink = null;
            await chmod(descriptorDir, 0o500);
            return async () => { await chmod(descriptorDir, 0o700); };
          };
          try {
            await expect(supervisor.detach()).rejects.toThrow('Native terminal presentation cleanup is incomplete');
            expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId }))
              .toMatchObject({ version: 2, attachmentId: attachment?.version === 2 ? attachment.attachmentId : undefined });
            await session.updateMetadata(metadata => ({ ...metadata, name: 'Renamed after owned Detach' }));
          } finally { await chmod(descriptorDir, 0o700); }
          await supervisor.detach();
          expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
        }
      } finally {
        await supervisor.dispose().catch(() => undefined);
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
        vi.stubEnv('XDG_CONFIG_HOME', homeDir);
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
        await session.close();
      }
    });
  });
  it.skipIf(process.platform === 'win32' || !hasSupportedHerdr)('retains a created unbound presenter when exact binding cleanup fails, without launching a replacement', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'shared-hosted-unbound-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'unbound-native');
      const sessionName = `happier-unbound-host-${process.pid}-${Date.now()}`;
      const binary = process.env.HERDR_BIN_PATH ?? 'herdr';
      const client = createHerdrClient({ binary, sessionName, actionTimeoutMs: 30_000, startupTimeoutMs: 30_000 });
      await client.ensureServer();
      const socketPath = client.socketPath!;
      const descriptorPath = join(homeDir, 'terminal', 'sessions', 'unbound-native.json');
      // Real EACCES prevents descriptor commit; real socket permissions prevent disposal.
      // The filesystem spy only schedules these genuine OS failures at the commit boundary.
      const descriptorDir = join(homeDir, 'terminal', 'sessions');
      await mkdir(descriptorDir, { recursive: true });
      let terminalId: string | undefined;
      filesystem.beforeRename = async (source, destination) => {
        if (destination === descriptorPath) {
          const raw: unknown = JSON.parse(await readFile(source, 'utf8'));
          if (raw && typeof raw === 'object' && 'handle' in raw && raw.handle && typeof raw.handle === 'object'
            && 'terminalId' in raw.handle && typeof raw.handle.terminalId === 'string') terminalId = raw.handle.terminalId;
          await chmod(socketPath, 0);
          await chmod(descriptorDir, 0o500);
        }
      };
      const supervisor = createAttachedTerminalSupervisor({
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir },
        terminalPresentation: { runtime: { mode: 'plain', requested: 'herdr', herdrSessionName: sessionName }, getSession: () => session },
        resolveInvocation: () => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }),
      });
      try {
        logger.flushSync();
        const previousLogLength = (await readFile(logger.getLogPath(), 'utf8')).length;
        expect(await supervisor.attach('same-native-session')).toBe(false);
        logger.flushSync();
        const startupDiagnostic = (await readFile(logger.getLogPath(), 'utf8')).slice(previousLogLength);
        const failureLine = startupDiagnostic.split('\n').find(line => line.includes('(terminal_native_startup_failed)'));
        const failureFields: unknown = JSON.parse(failureLine?.slice(failureLine.indexOf('{')) ?? 'null');
        expect(failureFields).toMatchObject({ phase: 'bind_attachment', category: 'cleanup_incomplete' });
        filesystem.beforeRename = null;
        await chmod(descriptorDir, 0o700);
        await chmod(socketPath, 0o600);
        expect(terminalId).toBeTruthy();
        expect(await client.findPane(terminalId!)).not.toBeNull();
        expect(await supervisor.attach('same-native-session')).toBe(false);
        await supervisor.dispose();
        expect(await client.findPane(terminalId!)).toBeNull();
      } finally {
        filesystem.beforeRename = null;
        await chmod(descriptorDir, 0o700);
        await chmod(socketPath, 0o600);
        await supervisor.dispose().catch(() => undefined);
        const pane = terminalId ? await client.findPane(terminalId) : null;
        if (pane) await client.closePane(pane.paneId);
        await session.close();
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
      }
    });
  });
  it.skipIf(process.platform === 'win32' || Boolean(process.versions.bun) || !hasSupportedHerdr)('disposes an exact hosted presenter before awaiting its pending native startup receipt', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'shared-hosted-pending-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'pending-hosted-native');
      const sessionName = `happier-pending-host-${process.pid}-${Date.now()}`;
      const binary = process.env.HERDR_BIN_PATH ?? 'herdr';
      const blocked = join(homeDir, 'launcher-blocked');
      const preload = join(homeDir, 'hold-native-startup.cjs');
      // A real Node preload holds the inner launcher before consuming its handoff. No native
      // process can be acknowledged; the owning terminal can still be physically disposed.
      await writeFile(preload, `if(process.argv[1]?.endsWith('terminal_launch_spec_runner.cjs')){require('node:fs').writeFileSync(${JSON.stringify(blocked)},'blocked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}`);
      const supervisor = createAttachedTerminalSupervisor({
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir,
          HAPPIER_JS_RUNTIME_PATH: process.execPath, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
        terminalPresentation: { runtime: { mode: 'plain', requested: 'herdr', herdrSessionName: sessionName }, getSession: () => session },
        resolveInvocation: () => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }),
      });
      const control = createSharedProviderLocalControl({ supported: true, startingMode: 'local', getSession: () => session,
        resolveTarget: () => 'same-native-session', isSameTarget: (a, b) => a === b, supervisor });
      const starting = control.onAfterStart();
      void starting.catch(() => undefined);
      let disposing: Promise<void> | undefined;
      try {
        await vi.waitFor(async () => expect(await readFile(blocked, 'utf8')).toBe('blocked'), { timeout: 20_000 });
        await vi.waitFor(async () => expect((await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId }))?.version).toBe(2));
        // The test's existing completion deadline bounds this real disposal;
        // a one-second polling cutoff would impose a competing cleanup budget.
        disposing = control.dispose();
        await disposing;
        expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
      } finally {
        // Release a pre-fix waiter through the real physical owner, not a fake receipt/status.
        await supervisor.dispose();
        await starting;
        await disposing;
        await session.close();
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
      }
    });
  });
  it.skipIf(process.platform === 'win32' || !hasSupportedHerdr)('keeps admitted shared remote control available when the optional native executable cannot spawn', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'shared-native-failure-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'failed-native-presentation');
      const sessionName = `happier-failed-host-${process.pid}-${Date.now()}`;
      const binary = process.env.HERDR_BIN_PATH ?? 'herdr';
      const supervisor = createAttachedTerminalSupervisor({
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir },
        terminalPresentation: { runtime: { mode: 'plain', requested: 'herdr', herdrSessionName: sessionName }, getSession: () => session },
        resolveInvocation: () => ({ command: join(homeDir, 'missing-native-executable'), args: [] }),
      });
      const control = createSharedProviderLocalControl({ supported: true, startingMode: 'local', getSession: () => session,
        resolveTarget: () => 'selected-native-session', isSameTarget: (a, b) => a === b, supervisor });
      try {
        await expect(control.onAfterStart()).resolves.toBeUndefined();
        expect(control.resolveKeepAliveMode()).toBe('remote');
        await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: false, canDetach: false, canAttach: true, remoteWritable: true }));
        expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
        expect(session.rpcHandlerManager.hasHandler('switch')).toBe(true);
      } finally {
        await control.dispose();
        await session.close();
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
      }
    });
  });
  it('concurrent shared attach requests create one native client for the same selected target', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'shared-attach-concurrent-' }, async ({ homeDir }) => {
      const session = await createSharedSession(homeDir, 'concurrent-shared');
      const children: ChildProcess[] = [];
      // Instrument the genuine OS boundary, retaining actual launchers/native processes.
      const spawnProcess = ((command: string, args: readonly string[] | undefined, options: SpawnOptions) => {
        const child = spawn(command, args ?? [], options);
        children.push(child);
        return child;
      }) as unknown as typeof spawn;
      const supervisor = createAttachedTerminalSupervisor({ spawnProcess,
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir },
        resolveInvocation: () => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }),
      });
      let target = 'selected-native-session';
      const control = createSharedProviderLocalControl({ supported: true, startingMode: 'remote',
        getSession: () => session, resolveTarget: () => target, isSameTarget: (a, b) => a === b, supervisor });
      try {
        expect(await Promise.all([control.switchToLocal(), control.switchToLocal()])).toEqual([true, true]);
        expect(children).toHaveLength(1);
        target = 'replacement-native-session';
        expect(await control.switchToLocal()).toBe(true);
        expect(children).toHaveLength(2);
      } finally {
        await control.dispose();
        await Promise.all(children.map(child => killProcessTree(child)));
        await session.close();
      }
    });
  });
  it.skipIf(process.platform === 'win32' || !hasSupportedHerdr)('keeps the headless shared controller writable after its exact optional Herdr pane closes, then reopens only explicitly', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'shared-hosted-native-' }, async ({ homeDir }) => {
      const sessionName = `happier-host-test-${process.pid}-${Date.now()}`;
      const binary = process.env.HERDR_BIN_PATH ?? 'herdr';
      const nativeReadyPath = join(homeDir, 'native-ready.json');
      const session = await createSharedSession(homeDir, 'hosted-shared-session');
      const runnerLock = await acquireSessionRunnerLock({ happyHomeDir: homeDir, sessionId: session.sessionId });
      if (!runnerLock.ok) throw new Error('Synthetic live runner could not acquire its canonical lock');
      const client = createHerdrClient({ binary, sessionName, actionTimeoutMs: 30_000, startupTimeoutMs: 30_000 });
      const adapter = createHerdrTerminalHostAdapter({ binary, sessionName, actionTimeoutMs: 30_000, startupTimeoutMs: 30_000, client });
      let localControl: ReturnType<typeof createSharedProviderLocalControl<string>>;
      const supervisorOptions = {
        terminalPresentation: {
          runtime: { mode: 'plain' as const, requested: 'herdr' as const, herdrSessionName: sessionName },
          getSession: () => session,
        },
        env: { PATH: process.env.PATH, HAPPIER_HOME_DIR: homeDir },
        resolveInvocation: (providerSessionId: string) => ({
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(nativeReadyPath)}, JSON.stringify({providerSessionId:${JSON.stringify(providerSessionId)},pid:process.pid}));setInterval(()=>{},1000)`],
        }),
        onExit: () => localControl.onTerminalExit(),
      };
      const supervisor = createAttachedTerminalSupervisor(supervisorOptions);
      let heartbeat: NodeJS.Timeout | undefined;
      let phase = 'native startup';
      localControl = createSharedProviderLocalControl({
        supported: true, startingMode: 'local', getSession: () => session,
        resolveTarget: () => 'same-native-session', isSameTarget: (a, b) => a === b, supervisor,
      });
      try {
        await client.ensureServer();
        const started = localControl.onAfterStart();
        void started.catch(() => undefined);
        await vi.waitFor(async () => {
          try { expect(JSON.parse(await readFile(nativeReadyPath, 'utf8')).providerSessionId).toBe('same-native-session'); }
          catch (cause) {
            const observed = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
            const pane = observed?.version === 2 && observed.handle.terminalId
              ? await client.findPane(observed.handle.terminalId) : null;
            const screen = pane ? await client.readPane(pane.paneId) : 'no-owned-pane';
            throw new Error(`Synthetic native fixture has not started: ${screen}`, { cause });
          }
        }, { timeout: 20_000 });
        await started;
        phase = 'initial binding';
        const attachment = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
        expect(attachment?.version).toBe(2);
        if (attachment?.version !== 2) throw new Error('Native presenter has no exact owned attachment');
        expect(attachment.handle.kind).toBe('herdr');
        const pane = await client.findPane(attachment.handle.terminalId!);
        expect(pane).not.toBeNull();
        await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: true, canDetach: true, topology: 'shared', remoteWritable: true }));
        await client.closePane(pane!.paneId);
        phase = 'heartbeat retirement';
        vi.stubEnv('HAPPIER_DAEMON_HEARTBEAT_INTERVAL', '100');
        const tracked: TrackedSession = { pid: process.pid, startedBy: 'daemon', happySessionId: session.sessionId,
          spawnOptions: { directory: homeDir, backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            codexBackendMode: 'appServer', terminal: { mode: 'herdr' } },
          publishedTerminalControlServiceabilityAttachmentId: attachment.attachmentId };
        const trackedSessions = new Map([[process.pid, tracked]]);
        const observeHealthyPresentation = { onTrackedSessionHealthy: async () => {
          await superviseTrackedOptionalTerminalPresentation({
            tracked, isCurrent: () => trackedSessions.get(process.pid) === tracked, happyHomeDir: homeDir,
            loadTerminalHostAdapters: async () => ({ herdr: adapter }),
            retireExactTerminalControlServiceability: async ({ attachmentInfo }) => {
              await session.updateMetadata((metadata) => clearTerminalControlServiceabilityProjection({
                metadata, retiredAttachmentId: attachmentInfo.attachmentId, retiredAt: Date.now(), terminalMode: 'herdr',
              }) as Metadata);
            },
          });
        } };
        heartbeat = startDaemonHeartbeatLoop({ ...observeHealthyPresentation,
          pidToTrackedSession: trackedSessions, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
          getApiMachineForSessions: () => null, controlPort: 0,
          fileState: { pid: process.pid, httpPort: 0, startedAt: Date.now(), startedWithCliVersion: configuration.currentCliVersion },
          currentCliVersion: configuration.currentCliVersion, requestShutdown: () => undefined,
        });
        await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.localControl).toMatchObject({ attached: false, canDetach: false, canAttach: true, remoteWritable: true }));
        clearInterval(heartbeat);
        heartbeat = undefined;
        phase = 'public attach';
        expect(localControl.resolveKeepAliveMode()).toBe('remote');
        expect(await client.findPane(attachment.handle.terminalId!)).toBeNull();
        let focusedTerminalId: string | undefined;
        vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`Fixture process exit ${code ?? 0}`); });
        const metadataBeforeRestore = session.getMetadataSnapshot()!;
        await handleAttachCommand([session.sessionId], {
          readCredentialsFn: async () => ({ token: 'synthetic-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
          fetchSessionByIdFn: async () => createSessionRecordFixture({ id: session.sessionId, active: true,
            encryptionMode: 'plain', metadata: JSON.stringify(metadataBeforeRestore), agentState: JSON.stringify(session.getAgentStateSnapshot()) }),
          // Terminal focus is an OS boundary; preparation/selection, Switch and binding remain real.
          runHerdrAttachFn: async ({ terminal }) => { focusedTerminalId = terminal.herdr?.terminalId; return 0; },
        });
        const replacement = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
        expect(replacement?.version).toBe(2);
        if (replacement?.version !== 2) throw new Error('Replacement presenter has no attachment');
        expect(replacement.attachmentId).not.toBe(attachment.attachmentId);
        expect(focusedTerminalId).toBe(replacement.handle.terminalId);
        // A delayed retirement for the previous exact presenter cannot detach the replacement.
        await session.updateMetadata((metadata) => clearTerminalControlServiceabilityProjection({
          metadata, retiredAttachmentId: attachment.attachmentId, retiredAt: Date.now(), terminalMode: 'herdr',
        }) as Metadata);
        expect(session.getAgentStateSnapshot()?.localControl?.attached).toBe(true);
        await client.closePane((await client.findPane(replacement.handle.terminalId!))!.paneId);
        // The original webhook publication cache may still name the first client.
        // Current filesystem identity must still let the same heartbeat observe its replacement.
        await observeHealthyPresentation.onTrackedSessionHealthy();
        await vi.waitFor(() => expect(session.getAgentStateSnapshot()?.localControl?.attached).toBe(false));
        expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId })).toBeNull();
        await localControl.switchToLocal();
        const finalPresenter = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: session.sessionId });
        if (finalPresenter?.version !== 2) throw new Error('Final presenter has no exact attachment');
        await localControl.dispose();
        expect(await client.findPane(finalPresenter.handle.terminalId!)).toBeNull();
      } catch (error) {
        console.error('Synthetic hosted failure', phase, error);
        throw error;
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        // Retire an exact known presenter before waiting for any outstanding startup proof.
        await supervisor.dispose().catch(() => undefined);
        await localControl.dispose().catch(() => undefined);
        await session.close();
        await runnerLock.release();
        // Only this test's unique namespace is stopped; no shared Herdr server is targeted.
        try { execFileSync(binary, ['--session', sessionName, 'server', 'stop'], { stdio: 'ignore' }); } catch {}
      }
    });
  });
});
