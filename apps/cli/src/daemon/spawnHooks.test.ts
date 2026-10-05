import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { requireCatalogEntry } from '@/backends/catalog';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from './types';
import { createStopSession } from './sessions/stopSession';
import { waitForTrackedRunnerProcessesExit } from './sessions/waitForTrackedRunnerProcessesExit';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from './processSupervision/sessionRunnerRespawnDescriptor';
import { logger } from '@/ui/logger';
import { HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY } from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';

import { buildTrackedSpawnOptions, resolveDaemonTerminalPresentation, resolveDefaultDaemonTerminalPresentation } from './spawnHooks';

describe('tracked spawn topology', () => {
  it('recovers an accepted optional-client runtime remotely until an explicit attachment request', async () => {
    const hooks = await requireCatalogEntry('codex').getDaemonSpawnHooks!();
    const input = { hooks, host: 'herdr' as const, agentId: 'codex' as const, configuredAcpBackend: false,
      accountSettings: null, runtimeSelection: { codexBackendMode: 'appServer' as const }, processEnv: {} };
    expect(resolveDaemonTerminalPresentation(input)).toMatchObject({ kind: 'provider_attach', startingMode: 'local' });
    const recovery = { existingSessionId: 'accepted-session' };
    expect(resolveDaemonTerminalPresentation({ ...input, ...recovery })).toMatchObject({ kind: 'provider_attach', startingMode: 'remote' });
  });
  it.skipIf(process.platform === 'win32')('stops a proven headless controller when its optional native presentation is absent', async () => {
    const hooks = await requireCatalogEntry('codex').getDaemonSpawnHooks!();
    const options: SpawnSessionOptions = { directory: process.cwd(), backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'appServer', terminal: { mode: 'herdr' } };
    const terminalPresentation = hooks.resolveTerminalPresentation!({ host: 'herdr', accountSettings: null,
      runtimeSelection: { codexBackendMode: 'appServer' }, processEnv: {} });
    expect(terminalPresentation.kind).toBe('provider_attach');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    const sessionId = `optional-no-client-${child.pid}`;
    const tracked: TrackedSession = { pid: child.pid!, childProcess: child, startedBy: 'daemon', happySessionId: sessionId,
      spawnOptions: buildTrackedSpawnOptions({ options, terminalPresentation }) };
    try {
      const stop = createStopSession({ pidToTrackedSession: new Map([[child.pid!, tracked]]),
        // A real selected host has not created any descriptor; the filesystem remains genuine.
        waitForTrackedRunnersExit: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
          runners: trackedPids.map(pid => ({ pid })), timeoutMs: 15_000, pollIntervalMs: 50,
        }),
        logWarning: message => logger.infoFile(message),
      });
      await expect(stop(sessionId)).resolves.toEqual({ status: 'stopped' });
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
  it('preserves provider-hosted requests and persists accepted native or fallback topology', async () => {
    const hooks = await requireCatalogEntry('claude').getDaemonSpawnHooks!();
    const terminalPresentation = hooks.resolveTerminalPresentation!({
      host: 'herdr', accountSettings: null, runtimeSelection: {},
      processEnv: { [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: 'test-endpoint-recovery' },
    });
    expect(terminalPresentation.kind).toBe('provider');
    const options: SpawnSessionOptions = { directory: process.cwd(), terminal: { mode: 'herdr', herdr: { sessionName: 'selected' } } };
    expect(buildTrackedSpawnOptions({ options, terminalPresentation }).terminal).toEqual(options.terminal);
    for (const actualTerminal of [
      { mode: 'plain' as const },
      { mode: 'windows_terminal' as const },
      { mode: 'windows_console' as const },
      { mode: 'tmux' as const, tmux: { sessionName: 'accepted', isolated: true, tmpDir: '/tmp/accepted-tmux' } },
    ]) {
      const tracked = buildTrackedSpawnOptions({ options, actualTerminal });
      expect(tracked.terminal).toEqual(actualTerminal);
      expect(buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(tracked)?.terminal).toEqual(actualTerminal);
    }
  });
  it.skipIf(process.platform === 'win32')('records headless admitted fallback as plain custody while hosted runners still require an attachment', async () => {
    const hooks = await requireCatalogEntry('codex').getDaemonSpawnHooks!();
    const options: SpawnSessionOptions = {
      directory: process.cwd(), codexBackendMode: 'acp', terminal: { mode: 'herdr' },
    };
    const presentationInput = {
      host: 'herdr' as const, accountSettings: null,
      runtimeSelection: { codexBackendMode: 'acp' as const },
      processEnv: { HAPPIER_CODEX_BACKEND_MODE: 'mcp' },
    };
    const terminalPresentation = hooks.resolveTerminalPresentation!(presentationInput);
    expect(terminalPresentation.kind).toBe('none');
    const trackedInput = { options, terminalPresentation };
    const spawnOptions = buildTrackedSpawnOptions(trackedInput);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    try {
      expect(spawnOptions.terminal?.mode).toBe('plain');
      const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions);
      expect(respawn?.terminal?.mode).toBe('plain');
      const pid = child.pid!;
      const sessionId = `headless-test-${pid}`;
      const tracked: TrackedSession = { pid, happySessionId: sessionId, startedBy: 'daemon', childProcess: child, spawnOptions };
      const stop = createStopSession({
        pidToTrackedSession: new Map([[pid, tracked]]),
        // Attachment persistence is the filesystem boundary; no host was created.
        readAttachmentState: async () => ({ status: 'absent' }),
        waitForTrackedRunnersExit: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
          runners: trackedPids.map((pid) => ({ pid })), timeoutMs: 15_000, pollIntervalMs: 50,
        }),
        logWarning: (message) => logger.infoFile(message),
      });
      await expect(stop(sessionId)).resolves.toEqual({ status: 'stopped' });
      await exited;

      const hostedInput = {
        options: { ...options, backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' }, environmentVariables: {
          [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: 'test-endpoint-recovery',
        } },
        terminalPresentation: (await requireCatalogEntry('claude').getDaemonSpawnHooks!()).resolveTerminalPresentation!({
          host: 'herdr', accountSettings: null, runtimeSelection: {}, processEnv: {
            [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: 'test-endpoint-recovery',
          },
        }),
      };
      const hosted = buildTrackedSpawnOptions(hostedInput);
      expect(hosted.terminal?.mode).toBe('herdr');
      const hostedStop = createStopSession({
        pidToTrackedSession: new Map([[pid, { ...tracked, spawnOptions: hosted }]]),
        readAttachmentState: async () => ({ status: 'absent' }),
        logWarning: (message) => logger.infoFile(message),
      });
      await expect(hostedStop(sessionId)).resolves.toEqual({ status: 'incomplete', reason: 'missing_attachment_identity' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});

describe('resolveDefaultDaemonTerminalPresentation', () => {
  it('hosts terminal-capable runners in the selected host without inventing a TUI for ACP', () => {
    expect(resolveDefaultDaemonTerminalPresentation({
      host: 'herdr',
      agentId: 'gemini',
      configuredAcpBackend: false,
    })).toEqual({ kind: 'runner', startingMode: 'local' });
    expect(resolveDefaultDaemonTerminalPresentation({
      host: 'zellij',
      agentId: 'pi',
      configuredAcpBackend: false,
    })).toEqual({ kind: 'runner', startingMode: 'local' });
    expect(resolveDefaultDaemonTerminalPresentation({
      host: 'tmux',
      agentId: 'gemini',
      configuredAcpBackend: false,
    })).toEqual({ kind: 'runner', startingMode: 'remote' });
    expect(resolveDefaultDaemonTerminalPresentation({
      host: 'herdr',
      agentId: 'agy',
      configuredAcpBackend: false,
    })).toEqual({ kind: 'none' });
    expect(resolveDefaultDaemonTerminalPresentation({
      host: 'herdr',
      agentId: 'customAcp',
      configuredAcpBackend: true,
    })).toEqual({ kind: 'none' });
  });
});
