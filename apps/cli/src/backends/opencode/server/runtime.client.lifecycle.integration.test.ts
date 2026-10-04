import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { cloneCallableSessionRuntimeControls } from '@/api/session/sessionRuntimeControls';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { handleAttachCommand } from '@/cli/commands/attach';
import { runOpenCodeProviderAttach } from '../attach/runOpenCodeProviderAttach';
import type { RpcRequest } from '@/api/rpc/types';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
// Network boundary only: keep command, RPC encryption/registration and provider runtime real.
vi.mock('socket.io-client', () => ({ io: mockIo }));

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import type { PermissionMode } from '@/api/types';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { createOpenCodeSharedLocalControl } from '../localControl/createOpenCodeSharedLocalControl';
import { createOpenCodeTuiSupervisor } from '../localControl/openCodeTuiSupervisor';
import { registerSessionControlHandlers } from '@/rpc/handlers/sessionControls';
import { encodeBase64, encrypt } from '@/api/encryption';

import { createOpenCodeServerRuntimeClient } from './client';
import { createOpenCodeServerRuntime } from './runtime';

function createSessionHarness() {
  const metadata: Record<string, unknown> = {};
  return {
    sessionId: 'happy_opencode_composed_lifecycle',
    keepAlive: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    sessionTurnLifecycle: {
      beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
      attachProviderTurnId: vi.fn(async () => {}),
      appendTranscriptAnchors: vi.fn(async () => {}),
      completeTurn: vi.fn(async () => {}),
      failTurn: vi.fn(async () => {}),
      cancelTurn: vi.fn(async () => {}),
      endSession: vi.fn(async () => {}),
      markRollbackEligible: vi.fn(async () => {}),
      markRolledBack: vi.fn(async () => {}),
    },
    sendUserTextMessageCommitted: vi.fn(async () => {}),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    ensureMetadataSnapshot: vi.fn(async () => ({ ok: true })),
    getMetadataSnapshot: () => metadata,
    updateMetadata: vi.fn(async (updater: (previous: unknown) => unknown) => {
      const next = updater(metadata);
      if (!next || typeof next !== 'object' || Array.isArray(next)) return;
      for (const key of Object.keys(metadata)) delete metadata[key];
      Object.assign(metadata, next);
    }),
    getLastObservedMessageSeq: () => 0,
  };
}

function sendJson(response: ServerResponse, body: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

describe('OpenCode client/runtime lifecycle composition', () => {
  const openServers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }));
  });

  it('refreshes published catalogs after V2 plugin settlement, withdrawal and reconnect without a prompt', async () => {
    // OpenCode 2.0.20 returns an immediate model snapshot before plugins settle, then emits
    // location-scoped model.updated/provider.updated/agent.updated invalidations (schema/core owners).
    let populated = false;
    let agentsAvailable = false;
    let inventoryUnavailable = false;
    let agentInventoryUnavailable = false;
    let eventResponse: ServerResponse | null = null;
    let connections = 0;
    let promptCount = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/info') {
        sendJson(response, { version: '2.0.20', pid: process.pid, urls: [], paths: {} });
      } else if (url.pathname === '/api/session' && request.method === 'POST') {
        sendJson(response, { data: { id: 'ses_catalog', location: { directory: '/tmp' } } });
      } else if (url.pathname === '/api/event') {
        eventResponse = response;
        connections += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
      } else if (['/api/provider', '/api/model', '/api/agent', '/api/model/default'].includes(url.pathname)) {
        expect(url.searchParams.get('location[directory]')).toBe('/tmp');
        if ((url.pathname === '/api/model' && inventoryUnavailable)
          || (url.pathname === '/api/agent' && agentInventoryUnavailable)) {
          sendJson(response, {}, 503);
        } else {
          const data = url.pathname === '/api/provider'
            ? (populated ? [{ id: 'openai', name: 'OpenAI', activation: 'enabled', package: 'aisdk:openai' }] : [])
            : url.pathname === '/api/model'
              ? (populated ? [{ id: 'gpt-5.6-luna', modelID: 'gpt-5.6-luna', providerID: 'openai',
                name: 'Luna', status: 'active', enabled: true,
                capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'low' }],
                time: { released: 0 }, cost: [], limit: { context: 200000, output: 32000 } }] : [])
              : url.pathname === '/api/agent'
                ? (agentsAvailable ? [{ id: 'build', name: 'Build', mode: 'primary', hidden: false, request: {}, permissions: [] }] : [])
                : undefined;
          sendJson(response, { location: { directory: '/tmp' }, data });
        }
      } else if (url.pathname.endsWith('/prompt')) {
        promptCount += 1;
        sendJson(response, {}, 500);
      } else {
        sendJson(response, { data: [] });
      }
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = { ...process.env, HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0' };
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp', baseUrlOverride: baseUrl, env, messageBuffer: new MessageBuffer(),
    });
    const session = createMutableApiSessionClientFixture();
    session.__setMetadata(createTestMetadata());
    session.ensureMetadataSnapshot = async () => session.getMetadataSnapshot();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp', env, session, messageBuffer: new MessageBuffer(), mcpServers: {},
      happierMcpAdmission: { kind: 'not_available_for_execution_run' },
      permissionHandler: new ProviderEnforcedPermissionHandler(session, { logPrefix: '[test]' }),
      onThinkingChange: () => {}, getPermissionMode: () => 'default',
    }, { createClient: async () => client });
    const emit = (type: string): void => {
      eventResponse?.write(`data: ${JSON.stringify({ type, location: { directory: '/tmp' }, data: {} })}\n\n`);
    };
    const disconnectEvents = (): void => { eventResponse?.end(); };
    try {
      await runtime.startOrLoad({});
      await expect.poll(() => session.getMetadataSnapshot()).toMatchObject({
        sessionModelsV1: { availableModels: [] }, sessionModesV1: { availableModes: [] },
      });
      await expect.poll(() => connections).toBe(1);

      populated = true;
      agentsAvailable = true;
      emit('model.updated');
      await expect.poll(() => session.getMetadataSnapshot()).toMatchObject({
        sessionModelsV1: { availableModels: [{ id: 'openai/gpt-5.6-luna' }] },
        sessionModesV1: { availableModes: [{ id: 'build', name: 'Build' }] },
      });

      populated = false;
      agentsAvailable = false;
      emit('agent.updated');
      await expect.poll(() => session.getMetadataSnapshot()).toMatchObject({
        sessionModelsV1: { availableModels: [] }, sessionModesV1: { availableModes: [] },
      });

      populated = true;
      emit('provider.updated');
      await expect.poll(() => session.getMetadataSnapshot()?.sessionModelsV1?.availableModels)
        .toMatchObject([{ id: 'openai/gpt-5.6-luna' }]);

      inventoryUnavailable = true;
      agentsAvailable = true;
      emit('agent.updated');
      await expect.poll(() => session.getMetadataSnapshot()).toMatchObject({
        sessionModelsV1: { availableModels: [{ id: 'openai/gpt-5.6-luna' }] },
        sessionModesV1: { availableModes: [{ id: 'build', name: 'Build' }] },
      });

      inventoryUnavailable = false;
      populated = false;
      agentInventoryUnavailable = true;
      emit('provider.updated');
      await expect.poll(() => session.getMetadataSnapshot()?.sessionModelsV1?.availableModels).toEqual([]);
      expect(session.getMetadataSnapshot()?.sessionModesV1?.availableModes).toMatchObject([{ id: 'build' }]);

      agentInventoryUnavailable = false;
      agentsAvailable = false;
      disconnectEvents();
      await expect.poll(() => connections).toBe(2);
      await expect.poll(() => session.getMetadataSnapshot()).toMatchObject({
        sessionModelsV1: { availableModels: [] }, sessionModesV1: { availableModes: [] },
      });
      expect(promptCount).toBe(0);
    } finally {
      await runtime.reset();
      await client.dispose();
      server.closeAllConnections();
    }
  });

  it.each(['accepted', 'agent-rejected', 'model-rejected', 'config-rejected', 'transport-recovered', 'rpc-preparation', 'rpc-agent-rejected', 'rpc-headless'] as const)(
    'publishes V2 model and reasoning controls to the native session before any prompt: %s', async (startupCase) => {
    // Released @opencode/cli 2.0.20 (84c9be93): the attached TUI reads session.model,
    // including its variant, rather than accepting model/variant attach flags.
    let nativeModel: { id: string; providerID: string; variant?: string } = {
      id: 'expensive-default', providerID: 'openai',
    };
    let promptCount = 0;
    let nativeAgent = 'build';
    let rejectModelUpdate = false;
    let startupPhase = true;
    let modelWrites = 0;
    logger.flushSync();
    const previousLogLength = existsSync(logger.getLogPath()) ? readFileSync(logger.getLogPath(), 'utf8').length : 0;
    let observeNativeAttachment!: (model: unknown) => void;
    const nativeAttachment = new Promise<unknown>((resolve) => {
      observeNativeAttachment = resolve;
    });
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/tui-observed') {
        observeNativeAttachment({ model: { ...nativeModel }, agent: nativeAgent });
        sendJson(response, {});
      } else if (url.pathname === '/tui-life') {
        response.writeHead(200);
        response.flushHeaders();
      } else if (url.pathname === '/api/info') {
        sendJson(response, { version: '2.0.20', pid: process.pid, urls: [], paths: {} });
      } else if (url.pathname === '/api/session' && request.method === 'POST') {
        sendJson(response, { data: { id: 'ses_native_controls', location: { directory: '/tmp' } } });
      } else if (url.pathname === '/api/session/ses_native_controls/agent' && request.method === 'POST') {
        if (startupPhase && (startupCase === 'agent-rejected' || startupCase === 'rpc-agent-rejected')) {
          sendJson(response, { error: 'fixture-private-credential-path' }, 400);
          return;
        }
        const body = await readJsonBody(request);
        if (typeof body.agent !== 'string') {
          sendJson(response, {}, 400);
          return;
        }
        nativeAgent = body.agent;
        response.writeHead(204);
        response.end();
      } else if (url.pathname === '/api/session/ses_native_controls/model' && request.method === 'POST') {
        if (rejectModelUpdate) {
          sendJson(response, { error: 'native selection unavailable' }, 503);
          return;
        }
        const body = await readJsonBody(request);
        const model = body.model;
        if (!model || typeof model !== 'object' || Array.isArray(model)) {
          sendJson(response, {}, 400);
          return;
        }
        const record = model as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.providerID !== 'string') {
          sendJson(response, {}, 400);
          return;
        }
        modelWrites += 1;
        if (startupPhase && (
          (startupCase === 'model-rejected' && record.id === 'cheap-model')
          || (startupCase === 'config-rejected' && record.variant === 'low')
          || (startupCase === 'transport-recovered' && modelWrites === 1)
        )) {
          sendJson(response, { error: 'native selection unavailable' },
            startupCase === 'transport-recovered' ? 503 : 400);
          return;
        }
        nativeModel = {
          id: record.id,
          providerID: record.providerID,
          ...(typeof record.variant === 'string' ? { variant: record.variant } : {}),
        };
        response.writeHead(204);
        response.end();
      } else if (url.pathname === '/api/session/ses_native_controls' && request.method === 'GET') {
        sendJson(response, { data: { id: 'ses_native_controls', model: nativeModel, agent: nativeAgent } });
      } else if (url.pathname === '/api/provider') {
        sendJson(response, { data: [{ id: 'openai' }] });
      } else if (url.pathname === '/api/model') {
        sendJson(response, { data: [
          { id: 'cheap-model', providerID: 'openai', variants: [{ id: 'low' }, { id: 'high' }] },
          { id: 'other-model', providerID: 'openai', variants: [{ id: 'low' }, { id: 'high' }] },
        ] });
      } else if (url.pathname === '/api/model/default') {
        sendJson(response, { data: { id: 'expensive-default', modelID: 'expensive-default', providerID: 'openai' } });
      } else if (url.pathname.endsWith('/prompt')) {
        promptCount += 1;
        sendJson(response, {}, 500);
      } else if (url.pathname === '/api/event') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
      } else {
        sendJson(response, { data: [] });
      }
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const env = { ...process.env, HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0' };
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp', baseUrlOverride: baseUrl, env, messageBuffer: new MessageBuffer(),
    });
    const session = createMutableApiSessionClientFixture({ overrides: {
      updateAgentState: async () => {}, sendSessionEvent: () => {},
    } });
    session.ensureMetadataSnapshot = async () => session.getMetadataSnapshot();
    session.__setMetadata(createTestMetadata({
      sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' },
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'openai/cheap-model' },
      sessionConfigOptionOverridesV1: { v: 1, updatedAt: 22, overrides: {
        reasoning_effort: { updatedAt: 22, value: 'low' },
      } },
    }));
    const permissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[test]' });
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp', env, session,
      messageBuffer: new MessageBuffer(), mcpServers: {},
      happierMcpAdmission: { kind: 'not_available_for_execution_run' },
      permissionHandler,
      onThinkingChange: () => {}, getPermissionMode: () => 'default',
    }, { createClient: async () => client });
    const readNativeSelection = async (): Promise<unknown> => {
      const response = await fetch(`${baseUrl}/api/session/ses_native_controls`);
      return await response.json();
    };
    let prepareLocalAttachment = async (): Promise<boolean> => false;
    const supervisor = createOpenCodeTuiSupervisor({
      command: process.execPath,
      // Real harmless native-terminal process: observes the server selection, then holds its HTTP connection.
      commandArgs: ['-e', 'const a=process.argv;const u=a[a.indexOf("--server")+1];fetch(u+"/tui-observed").then(()=>fetch(u+"/tui-life"));', '--'],
      env, readManagedServerStateFn: async () => null,
    });
    const localControl = createOpenCodeSharedLocalControl({
      support: startupCase === 'rpc-headless' ? { ok: false, reason: 'tty_unavailable' } : { ok: true },
      startingMode: 'local', getSession: () => session,
      getSessionId: runtime.getSessionId, getDirectory: () => '/tmp',
      getServerTarget: () => ({ baseUrl }), supervisor,
      prepareAttachment: () => prepareLocalAttachment(),
    });
    try {
      const startupAccepted = startupCase === 'accepted' || startupCase === 'rpc-preparation' || startupCase === 'rpc-headless';
      let shouldExit = false;
      const queue = new MessageQueue2<{ permissionMode: PermissionMode }, PermissionModeQueuedPrompt>(
        (mode) => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts },
      );
      await runPermissionModePromptLoop({
        providerName: 'OpenCode', providerId: 'opencode', agentMessageType: 'opencode',
        explicitPermissionMode: undefined, session, messageQueue: queue,
        permissionHandler,
        runtime, messageBuffer: new MessageBuffer(),
        createOverrideSynchronizer: (isStarted) => createRuntimeOverrideSynchronizers({ session, runtime, isStarted }),
        shouldExit: () => shouldExit, getAbortSignal: () => new AbortController().signal,
        keepAlive: () => {}, setThinking: () => {}, sendReady: () => {},
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode: () => {},
        setCurrentPermissionModeUpdatedAt: () => {}, startRuntimeBeforeFirstPrompt: true,
        formatPromptErrorMessage: String,
        onAfterStart: async (startup?: { initialControlsApplied: boolean; prepareLocalAttachment: () => Promise<boolean> }) => {
          shouldExit = true;
          if (startupCase === 'accepted' || startupCase === 'transport-recovered') {
            expect(await readNativeSelection()).toMatchObject({ data: {
              agent: 'plan', model: { providerID: 'openai', id: 'cheap-model', variant: 'low' },
            } });
          }
          expect(startup?.initialControlsApplied).toBe(startupAccepted);
          prepareLocalAttachment = startup!.prepareLocalAttachment;
          // The callback returns before entering the loop; allow current-owner attachment admission to run.
          shouldExit = false;
          if (startupCase.startsWith('rpc-')) {
            // Real registered handler + encrypted RPC manager, delegating to this runtime's actual admission owner.
            const runtimeControls = {
              prepareProviderCliAttach: localControl.prepareProviderCliAttach,
            };
            registerSessionControlHandlers(session.rpcHandlerManager, { sessionRuntimeControls: cloneCallableSessionRuntimeControls(runtimeControls) });
            const key = new Uint8Array(32);
            const socket = createApiSessionSocketStub({
              // Match asynchronous network connection while keeping registered RPC admission real.
              onConnect: (connectedSocket) => queueMicrotask(() => connectedSocket.trigger('connect')),
              emit: async (event, args) => {
                const [payload, ack] = args;
                if (event !== 'rpc-call' || typeof ack !== 'function') return;
                // The network harness receives the real typed session-RPC call payload.
                const result: unknown = await session.rpcHandlerManager.handleRequest(payload as RpcRequest);
                ack({ ok: true, result });
              },
            });
            bindApiSessionSocketMock(mockIo, socket);
            const rawSession = createSessionRecordFixture({
              id: session.sessionId, active: true,
              metadata: encodeBase64(encrypt(key, 'legacy', {
                flavor: 'opencode', path: '/tmp', host: 'fixture', machineId: 'machine-fixture',
                opencodeSessionId: 'ses_native_controls', opencodeBackendMode: 'server',
                opencodeServerBaseUrl: baseUrl, opencodeServerBaseUrlExplicit: true,
              })),
            });
            const attach = handleAttachCommand([session.sessionId], {
              readCredentialsFn: async () => ({ token: 'fixture-token', encryption: { type: 'legacy', secret: key } }),
              readSettingsFn: async () => ({ schemaVersion: 1, onboardingCompleted: true, machineId: 'machine-fixture' }),
              fetchSessionByIdFn: async () => rawSession,
              readTerminalAttachmentInfoFn: async () => null,
              runProviderAttachFn: async (params) => await runOpenCodeProviderAttach({
                ...params, command: process.execPath,
                commandArgs: ['-e', 'const a=process.argv;fetch(new URL("/tui-observed",a[a.indexOf("--server")+1]));', '--'],
                env, readManagedServerStateFn: async () => null,
              }),
            });
            if (startupCase === 'rpc-agent-rejected') {
              await expect(attach).rejects.toThrow('provider_cli_attach_not_ready');
            } else {
              await attach;
              // Observe the caller's native child before any local-controller child can satisfy it.
              expect(await nativeAttachment).toEqual({ agent: 'plan', model: { providerID: 'openai', id: 'cheap-model', variant: 'low' } });
            }
          }
          await localControl.onAfterStart({ canAttach: startup!.initialControlsApplied });
          shouldExit = true;
          expect(supervisor.isAttached()).toBe(startupAccepted && startupCase !== 'rpc-headless');
          if (startupCase === 'rpc-headless') expect(localControl.resolveKeepAliveMode()).toBe('remote');
          if (startupAccepted) {
            expect(await nativeAttachment).toEqual({ agent: 'plan', model: { providerID: 'openai', id: 'cheap-model', variant: 'low' } });
          } else {
            expect(localControl.resolveKeepAliveMode()).toBe('remote');
          }
          expect(promptCount).toBe(0);
        },
      });
      if (startupCase === 'agent-rejected') {
        logger.flushSync();
        const diagnostic = existsSync(logger.getLogPath())
          ? readFileSync(logger.getLogPath(), 'utf8').slice(previousLogLength)
          : '';
        expect(diagnostic).toContain('[SessionModeOverrideSync] Failed to apply session mode override; will retry on next sync');
        expect(diagnostic).not.toContain('fixture-private-credential-path');
      }
      startupPhase = false;
      if (!startupAccepted) {
        // An explicit retry uses the synchronizer's current pending commands, not the initial rejection.
        shouldExit = false;
        await expect(localControl.switchToLocal()).resolves.toBe(true);
        shouldExit = true;
        expect(await nativeAttachment).toEqual({ agent: 'plan', model: { providerID: 'openai', id: 'cheap-model', variant: 'low' } });
        expect(runtime.getSessionId()).toBe('ses_native_controls');
        expect(promptCount).toBe(0);
        return;
      }
      await runtime.setSessionModel('openai/expensive-default');
      await runtime.setSessionConfigOption('reasoning_effort', 'low');
      expect(await readNativeSelection()).toMatchObject({ data: { model: {
        providerID: 'openai', id: 'expensive-default', variant: 'low',
      } } });
      await runtime.setSessionModel('openai/cheap-model');
      await runtime.setSessionConfigOption('reasoning_effort', 'low');
      expect(await readNativeSelection()).toMatchObject({ data: { model: {
        providerID: 'openai', id: 'cheap-model', variant: 'low',
      } } });

      await runtime.setSessionModel('openai/other-model');
      await runtime.setSessionConfigOption('reasoning_effort', 'high');
      expect(await readNativeSelection()).toMatchObject({ data: { model: {
        providerID: 'openai', id: 'other-model', variant: 'high',
      } } });
      await runtime.setSessionConfigOption('reasoning_effort', null);
      expect(await readNativeSelection()).toEqual({ data: {
        id: 'ses_native_controls', agent: 'plan', model: { providerID: 'openai', id: 'other-model' },
      } });
      rejectModelUpdate = true;
      await expect(runtime.setSessionModel('openai/cheap-model')).rejects.toThrow();
      await expect(runtime.setSessionConfigOption('reasoning_effort', 'low')).rejects.toThrow();
      rejectModelUpdate = false;
      await runtime.setSessionConfigOption('reasoning_effort', 'high');
      expect(await readNativeSelection()).toMatchObject({ data: { model: {
        providerID: 'openai', id: 'other-model', variant: 'high',
      } } });
      expect(promptCount).toBe(0);
    } finally {
      await localControl.dispose();
      await runtime.reset();
      await client.dispose();
      server.closeAllConnections();
    }
  });

  it('waits for exact-parent terminal inventory after live provider error and idle', async () => {
    let eventResponse: ServerResponse | null = null;
    let eventStreamKind: 'instance' | 'global' | null = null;
    let promptMessageId = '';
    let promptAccepted = false;
    let terminalInventoryReady = false;

    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/global/health') {
        sendJson(response, { healthy: true, version: '1.14.41' });
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/event' || url.pathname === '/global/event')) {
        eventStreamKind = url.pathname === '/event' ? 'instance' : 'global';
        if (eventStreamKind === 'instance') {
          expect(url.searchParams.get('directory')).toBe('/tmp');
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        eventResponse = response;
        const connected = { type: 'server.connected', properties: {} };
        response.write(`data: ${JSON.stringify(eventStreamKind === 'instance'
          ? connected
          : { directory: '/tmp', payload: connected })}\n\n`);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/session') {
        sendJson(response, { id: 'ses_1', directory: '/tmp' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_1/prompt_async') {
        const body = await readJsonBody(request);
        promptMessageId = typeof body.messageID === 'string' ? body.messageID : '';
        promptAccepted = true;
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/session/ses_1/message') {
        if (!promptAccepted) {
          sendJson(response, []);
          return;
        }
        sendJson(response, [
          {
            info: { id: promptMessageId, role: 'user', sessionID: 'ses_1', time: { created: 10 } },
            parts: [{ id: 'part_user', type: 'text', text: 'hello' }],
          },
          {
            info: {
              id: 'msg_provider_error',
              role: 'assistant',
              sessionID: 'ses_1',
              parentID: promptMessageId,
              time: { created: 11, ...(terminalInventoryReady ? { completed: 12 } : {}) },
              error: {
                name: 'ProviderModelNotFoundError',
                data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
              },
            },
            parts: [],
          },
        ]);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/global/config') {
        sendJson(response, { model: 'openai/gpt-test' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/provider') {
        sendJson(response, { all: [{ id: 'openai', models: { 'gpt-test': { id: 'gpt-test' } } }], connected: ['openai'] });
        return;
      }
      if (request.method === 'GET' && (url.pathname === '/agent' || url.pathname === '/skill' || url.pathname === '/permission' || url.pathname === '/question' || url.pathname.endsWith('/todo') || url.pathname.endsWith('/diff'))) {
        sendJson(response, []);
        return;
      }
      sendJson(response, {}, 404);
    });
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED: '0',
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: '10000',
    };
    const client = await createOpenCodeServerRuntimeClient({
      directory: '/tmp',
      baseUrlOverride: baseUrl,
      env,
      messageBuffer: new MessageBuffer(),
    });
    const session = createSessionHarness();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      env,
      session: session as never,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      happierMcpAdmission: { kind: 'not_available_for_execution_run' },
      permissionHandler: { handleToolCall: async () => ({ decision: 'approved' as const }) } as never,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client,
    });

    let promptPromise: Promise<void> | null = null;
    try {
      await runtime.startOrLoad({});
      runtime.beginTurn();
      promptPromise = runtime.sendPromptWithMeta?.({ text: 'hello', localId: 'local-composed-error' }) ?? Promise.resolve();
      void promptPromise.catch(() => undefined);
      await expect.poll(() => promptAccepted).toBe(true);
      await expect.poll(() => eventResponse !== null).toBe(true);

      const emit = (event: unknown): void => {
        const payload = eventStreamKind === 'instance'
          ? event
          : { directory: '/tmp', payload: event };
        eventResponse?.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      emit({
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'ProviderModelNotFoundError',
            data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();

      emit({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.sessionTurnLifecycle.failTurn).not.toHaveBeenCalled();

      terminalInventoryReady = true;
      emit({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_provider_error',
            role: 'assistant',
            sessionID: 'ses_1',
            parentID: promptMessageId,
            time: { created: 11, completed: 12 },
            error: {
              name: 'ProviderModelNotFoundError',
              data: { message: 'Model not found: openai-codex/gpt-5.6-luna' },
            },
          },
        },
      });

      const promptOutcome = Promise.race([
        promptPromise,
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out waiting for prompt failure')), 500);
          timer.unref?.();
        }),
      ]);
      await expect(promptOutcome).rejects.toThrow('Model not found: openai-codex/gpt-5.6-luna');
      await expect.poll(() => session.sessionTurnLifecycle.failTurn.mock.calls.length).toBe(1);
    } finally {
      await runtime.reset().catch(() => {});
      await client.dispose().catch(() => {});
      await promptPromise?.catch(() => undefined);
    }
  });
});
