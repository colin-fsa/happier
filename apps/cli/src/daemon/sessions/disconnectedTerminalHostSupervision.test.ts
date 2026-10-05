import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readTerminalAttachmentInfo, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createStopSession } from './stopSession';
import { createOnChildExited } from './onChildExited';
import { readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import type { TrackedSession } from '../types';
import type { StopSessionResult } from './stopSessionContract';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';
import { probeSessionRunnerServiceability } from './isSessionRunnerActive';

// Socket.IO is an external network boundary. A superseded projection must not write to it.
vi.mock('socket.io-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('socket.io-client')>(),
  io: () => { throw new Error('unexpected_projection_write'); },
}));

const filesystemGates = vi.hoisted(() => ({
  beforeUnlink: null as ((path: unknown) => Promise<void>) | null,
  afterRead: null as ((path: unknown) => void) | null,
}));
// The filesystem is the genuine OS boundary; all parsing, locking and lifecycle logic stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      await filesystemGates.beforeUnlink?.(args[0]);
      return await actual.unlink(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      filesystemGates.afterRead?.(args[0]);
      return result;
    },
  };
});

import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import {
  resolveDisconnectedTerminalHostResumeGate,
  shouldRetainTrackedTerminalHostExitMarker,
  superviseDisconnectedTerminalHostCandidate,
  type DisconnectedTerminalHostCandidate,
} from './disconnectedTerminalHostSupervision';

const handle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
  attachmentId: 'attachment-live-1' as NonNullable<TerminalHostHandle['attachmentId']>,
  kind: 'tmux',
  sessionName: 'happier-live-1',
  paneId: 'claude.1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

describe('disconnected terminal-host supervision', () => {
  it.each(['absent', 'unreadable', 'owned', 'borrowed'] as const)(
    'settles an optional controller exit against its %s current terminal custody', async (custody) => {
      await withConfiguredDaemonTestHome({ prefix: `optional-marker-${custody}-` }, async ({ homeDir }) => {
        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        await once(child, 'spawn');
        const pid = child.pid!;
        await once(child, 'exit');
        const sessionId = 'session-optional-marker';
        const terminal = { mode: 'tmux' as const, tmux: { target: `${handle.sessionName}:${handle.paneId}` } };
        const tracked: TrackedSession = {
          pid, startedBy: 'daemon', happySessionId: sessionId,
          hostedTerminal: terminal,
          publishedTerminalControlServiceabilityAttachmentId: handle.attachmentId,
          spawnOptions: { directory: homeDir, backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            terminal: { mode: 'tmux' } },
        };
        await writeSessionMarker({ pid, happySessionId: sessionId });
        if (custody === 'unreadable') {
          const directory = join(homeDir, 'terminal', 'sessions');
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, `${sessionId}.json`), '{', 'utf8');
        } else if (custody !== 'absent') {
          await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId, handle,
            attachmentId: handle.attachmentId, terminal, lifecycle: custody });
        }
        const tracking = new Map([[pid, tracked]]);
        await createOnChildExited({ pidToTrackedSession: tracking, spawnResourceCleanupByPid: new Map(),
          sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null,
          shouldPreserveSessionMarkerOnExit: async () => await shouldRetainTrackedTerminalHostExitMarker({
            tracked, happyHomeDir: homeDir,
          }),
        })(pid, { reason: 'process-exited', code: 0, signal: null });
        expect(tracking.has(pid)).toBe(false);
        expect(Boolean(await readSessionMarkerForPid(pid))).toBe(custody === 'owned' || custody === 'unreadable');
      });
    },
  );

  it('disposes an exact optional client after its controller is proven absent, preserving a newer remote projection', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'optional-controller-exit-' }, async ({ homeDir }) => {
      const client = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await once(client, 'spawn');
      const exit = once(client, 'exit');
      const sessionId = 'session-live-1';
      const metadata = JSON.stringify({ terminal: { mode: 'tmux', controlServiceabilityV1: {
        v: 1, attachmentId: 'newer-remote-attachment', state: 'servable', observedAt: 20,
      } }, unrelated: 'retained' });
      const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata });
      const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, statusText: 'OK', headers: {},
        config: { headers: new AxiosHeaders() }, data: { session: raw } });
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => ({ paneAlive: client.exitCode === null && client.signalCode === null, observedAt: Date.now() }),
        dispose: async () => { client.kill('SIGTERM'); await exit; },
      };
      try {
        await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId, attachmentId: handle.attachmentId, handle,
          terminal: { mode: 'tmux', tmux: { target: `${handle.sessionName}:${handle.paneId}` } } });
        const candidate = { sessionId, pid: process.pid, happyHomeDir: homeDir, attachmentId: handle.attachmentId, handle,
          controlDescriptorStatus: 'not_applicable' as const, spawnOptions: {
            directory: homeDir, backendTarget: { kind: 'builtInAgent' as const, agentId: 'opencode' }, terminal: { mode: 'tmux' as const },
          } } satisfies DisconnectedTerminalHostCandidate;
        await expect(superviseDisconnectedTerminalHostCandidate({ candidate, terminalHostAdapters: { tmux: adapter },
          probeSessionServiceability: async (id) => await probeSessionRunnerServiceability({ sessionId: id, trackedSessions: [],
            probeCapability: async () => { throw new Error('Absent runner cannot provide RPC controls'); } }),
          retireExactTerminalControlServiceability: async ({ attachmentInfo }) => await retireExactTerminalControlServiceability({
            credentials: { token: 'synthetic-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            sessionId, attachmentId: attachmentInfo.attachmentId, terminalMode: attachmentInfo.terminal.mode,
          }),
        })).resolves.toEqual({ state: 'stopped' });
        expect(client.signalCode).toBe('SIGTERM');
        expect(await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId })).toBeNull();
        expect(raw.metadata).toBe(metadata);
      } finally { get.mockRestore(); client.kill('SIGTERM'); await exit; }
    });
  });
  async function createStopFixture(
    homeDir: string,
    adapter: TerminalHostAdapter,
    retireExactTerminalControlServiceability?: Parameters<typeof createStopSession>[0]['retireExactTerminalControlServiceability'],
  ) {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'spawn');
    const pid = child.pid!;
    await once(child, 'exit');
    const sessionId = 'session-live-1';
    await writeTerminalAttachmentInfo({
      happyHomeDir: homeDir, sessionId, attachmentId: handle.attachmentId, handle,
      terminal: { mode: 'tmux', tmux: { target: `${handle.sessionName}:${handle.paneId}` } },
    });
    const candidate: DisconnectedTerminalHostCandidate = {
      sessionId, pid, happyHomeDir: homeDir, handle, attachmentId: handle.attachmentId,
      controlDescriptorStatus: 'not_applicable',
    };
    const candidates: DisconnectedTerminalHostCandidate[] = [];
    const pendingStops = new Map<string, Promise<StopSessionResult>>();
    const tracked = new Map<number, TrackedSession>([[pid, { pid, startedBy: 'terminal', happySessionId: sessionId }]]);
    let earlierSupervision: Promise<unknown> | null = null;
    const supervise = async () => {
      if (earlierSupervision) await earlierSupervision;
      for (const selected of candidates) {
        await superviseDisconnectedTerminalHostCandidate({
          candidate: selected, terminalHostAdapters: { tmux: adapter },
        });
      }
    };
    const onExit = createOnChildExited({
      pidToTrackedSession: tracked, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      shouldPreserveSessionMarkerOnExit: () => true,
      onFinalTrackedSessionExitStaged: async () => { candidates.push(candidate); await supervise(); },
    });
    const probe = async () => await waitForTrackedRunnerProcessesExit({ runners: [{ pid }], timeoutMs: 0, pollIntervalMs: 0, onExitObserved: onExit });
    const stop = createStopSession({ pidToTrackedSession: tracked, terminalHostAdapters: { tmux: adapter }, areTrackedRunnersExited: probe, waitForTrackedRunnersExit: probe, retireExactTerminalControlServiceability });
    return {
      candidate, pendingStops, candidates, supervise,
      observeExit: async () => await onExit(pid, { reason: 'process-missing', code: null, signal: null }),
      setEarlierSupervision: (operation: Promise<unknown>) => { earlierSupervision = operation; },
      requestStop: async () => {
        const operation = Promise.resolve().then(() => stop(sessionId));
        pendingStops.set(sessionId, operation);
        try { return await operation; } finally { pendingStops.delete(sessionId); }
      },
    };
  }

  it.each(['owned', 'borrowed'] as const)('returns the public descriptor-retirement failure after an %s attachment unlink is denied', async (lifecycle) => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-descriptor-denied-' }, async ({ homeDir }) => {
      const dispose = vi.fn(async () => undefined);
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => ({ paneAlive: true, observedAt: 1 }), dispose,
      };
      const fixture = await createStopFixture(homeDir, adapter);
      await writeTerminalAttachmentInfo({
        happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId, attachmentId: handle.attachmentId, handle, lifecycle,
        terminal: { mode: 'tmux', tmux: { target: `${handle.sessionName}:${handle.paneId}` } },
      });
      const descriptorPath = join(homeDir, 'terminal', 'sessions', `${fixture.candidate.sessionId}.json`);
      filesystemGates.beforeUnlink = async (path) => {
        if (String(path) === descriptorPath) throw Object.assign(new Error('OS unlink denied'), { code: 'EACCES' });
      };
      try {
        await expect(fixture.requestStop()).resolves.toEqual({ status: 'incomplete', reason: 'terminal_attachment_descriptor_retirement_failed' });
        expect(dispose).toHaveBeenCalledTimes(lifecycle === 'borrowed' ? 0 : 1);
        await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId }))
          .resolves.toMatchObject({ attachmentId: handle.attachmentId });
      } finally { filesystemGates.beforeUnlink = null; }
    });
  });

  it.each(['superseded', 'unavailable'] as const)('keeps borrowed Stop scoped to its exited runner when remote retirement is %s', async (remoteState) => {
    await withConfiguredDaemonTestHome({ prefix: 'borrowed-stop-projection-' }, async ({ homeDir }) => {
      const sessionId = 'session-live-1';
      const metadata = JSON.stringify({
        terminal: { mode: 'tmux', controlServiceabilityV1: {
          v: 1, attachmentId: 'replacement-attachment', state: 'servable', observedAt: 20,
        } },
        unrelated: 'retained',
      });
      const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata });
      const get = vi.spyOn(axios, 'get');
      if (remoteState === 'superseded') get.mockResolvedValue({
        status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: { session: raw },
      });
      else get.mockRejectedValue(new Error('HTTP transport unavailable'));
      try {
        const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        if (remoteState === 'superseded') {
          await expect(retireExactTerminalControlServiceability({ credentials, sessionId, attachmentId: handle.attachmentId, terminalMode: 'tmux' }))
            .resolves.toBe('superseded');
        }
        const dispose = vi.fn(async () => undefined);
        const fixture = await createStopFixture(homeDir, {
          kind: 'tmux', createOrAttachHost: async () => handle,
          injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
          evaluateLiveness: async () => ({ paneAlive: true, observedAt: 1 }), dispose,
        }, async ({ attachmentInfo }) => await retireExactTerminalControlServiceability({
          credentials, sessionId, attachmentId: attachmentInfo.attachmentId, terminalMode: attachmentInfo.terminal.mode,
        }));
        await writeTerminalAttachmentInfo({
          happyHomeDir: homeDir, sessionId, attachmentId: handle.attachmentId, handle, lifecycle: 'borrowed',
          terminal: { mode: 'tmux', tmux: { target: `${handle.sessionName}:${handle.paneId}` } },
        });
        await expect(fixture.requestStop()).resolves.toEqual(remoteState === 'superseded'
          ? { status: 'stopped' }
          : { status: 'incomplete', reason: 'terminal_control_serviceability_retirement_failed' });
        expect(dispose).not.toHaveBeenCalled();
        expect(raw.metadata).toBe(metadata);
        const retained = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId });
        if (remoteState === 'superseded') expect(retained).toBeNull();
        else expect(retained).toMatchObject({ attachmentId: handle.attachmentId, lifecycle: 'borrowed' });
      } finally { get.mockRestore(); }
    });
  });

  it('confirms Stop completion during normal-exit retirement while unrelated confirmed-dead hosts still retire', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-host-owner-' }, async ({ homeDir }) => {
      // Terminal adapter calls are the OS boundary; process/descriptor/lifecycle logic is real.
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: Date.now() }),
        dispose: async () => {},
      };
      const fixture = await createStopFixture(homeDir, adapter);
      const otherHandle = { ...handle, attachmentId: 'attachment-other' as typeof handle.attachmentId };
      await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-other', attachmentId: otherHandle.attachmentId, handle: otherHandle,
        terminal: { mode: 'tmux', tmux: { target: `${otherHandle.sessionName}:${otherHandle.paneId}` } } });
      fixture.candidates.push({ ...fixture.candidate, sessionId: 'session-other', handle: otherHandle, attachmentId: otherHandle.attachmentId });
      await expect(fixture.requestStop()).resolves.toEqual({ status: 'stopped' });
      await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId })).resolves.toBeNull();
      await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-other' })).resolves.toBeNull();
      expect(fixture.pendingStops.size).toBe(0);
    });
  });

  it('confirms Stop completion when it overlaps a dispatched supervisor OS liveness probe', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-host-probe-' }, async ({ homeDir }) => {
      let releaseProbe!: () => void;
      let enteredProbe!: () => void;
      const entered = new Promise<void>((resolve) => { enteredProbe = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseProbe = resolve; });
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => { enteredProbe(); await blocked; return { paneAlive: false, paneDead: true, observedAt: Date.now() }; },
        dispose: async () => {},
      };
      const fixture = await createStopFixture(homeDir, adapter);
      const recovery = superviseDisconnectedTerminalHostCandidate({ candidate: fixture.candidate, terminalHostAdapters: { tmux: adapter } });
      fixture.setEarlierSupervision(recovery);
      await entered;
      const stopping = fixture.requestStop();
      releaseProbe();
      try { await expect(stopping).resolves.toEqual({ status: 'stopped' }); }
      finally { releaseProbe(); await recovery; }
    });
  });

  it('retains recovery after an incomplete Stop and resumes normal positive-dead retirement once its owner settles', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-host-recovery-' }, async ({ homeDir }) => {
      let confirmedDead = false;
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => confirmedDead ? { paneAlive: false, paneDead: true, observedAt: Date.now() } : { paneAlive: false, probeInconclusive: true, observedAt: Date.now() },
        dispose: async () => { throw new Error('OS disposal unavailable'); },
      };
      const fixture = await createStopFixture(homeDir, adapter);
      await expect(fixture.requestStop()).resolves.toEqual({ status: 'incomplete', reason: 'destroy_failed' });
      expect(fixture.pendingStops.size).toBe(0);
      await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId })).resolves.toMatchObject({ attachmentId: handle.attachmentId });
      confirmedDead = true;
      await fixture.supervise();
      await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId })).resolves.toBeNull();
    });
  });

  it('confirms exact owned retirement when Stop captures its descriptor during a normal-exit filesystem commit', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-host-commit-' }, async ({ homeDir }) => {
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: Date.now() }),
        dispose: async () => {},
      };
      const fixture = await createStopFixture(homeDir, adapter);
      let releaseCommit!: () => void;
      let enteredCommit!: () => void;
      let capturedDescriptor!: () => void;
      const entered = new Promise<void>((resolve) => { enteredCommit = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseCommit = resolve; });
      const captured = new Promise<void>((resolve) => { capturedDescriptor = resolve; });
      filesystemGates.beforeUnlink = async (path) => {
        if (String(path).startsWith(homeDir) && String(path).endsWith('.json')) {
          enteredCommit();
          await blocked;
        }
      };
      filesystemGates.afterRead = (path) => {
        if (fixture.pendingStops.has(fixture.candidate.sessionId) && String(path).startsWith(homeDir)) capturedDescriptor();
      };
      const exiting = fixture.observeExit();
      try {
        await entered;
        fixture.setEarlierSupervision(exiting);
        const stopping = fixture.requestStop();
        await captured;
        releaseCommit();
        await expect(stopping).resolves.toEqual({ status: 'stopped' });
        await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId })).resolves.toBeNull();
      } finally {
        releaseCommit();
        await exiting;
        filesystemGates.afterRead = null;
        filesystemGates.beforeUnlink = null;
      }
    });
  });

  it.each(['alive', 'inconclusive'] as const)('does not treat descriptor absence as physical completion when disposal fails and the host is %s', async (state) => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-host-unproven-' }, async ({ homeDir }) => {
      let recoveryProbeCompleted = false;
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => {
          if (!recoveryProbeCompleted) {
            recoveryProbeCompleted = true;
            return { paneAlive: false, paneDead: true, observedAt: Date.now() };
          }
          return state === 'alive'
            ? { paneAlive: true, observedAt: Date.now() }
            : { paneAlive: false, probeInconclusive: true, observedAt: Date.now() };
        },
        dispose: async () => { throw new Error('OS disposal unavailable'); },
      };
      const fixture = await createStopFixture(homeDir, adapter);
      await expect(fixture.requestStop()).resolves.toEqual({ status: 'incomplete', reason: 'destroy_failed' });
      await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId })).resolves.toBeNull();
    });
  });

  it('preserves a replacement attachment installed while the captured owned host is disposed', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'stop-host-replacement-' }, async ({ homeDir }) => {
      const replacement = { ...handle, attachmentId: 'attachment-replacement' as typeof handle.attachmentId };
      const adapter: TerminalHostAdapter = {
        kind: 'tmux', createOrAttachHost: async () => handle,
        injectUserPrompt: async () => ({ status: 'injected', at: 1, bytesWritten: 1 }), interruptTurn: async () => {},
        evaluateLiveness: async () => ({ paneAlive: false, paneDead: true, observedAt: Date.now() }),
        dispose: async () => {
          await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: 'session-live-1', attachmentId: replacement.attachmentId,
            handle: replacement, terminal: { mode: 'tmux', tmux: { target: `${replacement.sessionName}:${replacement.paneId}` } } });
        },
      };
      const fixture = await createStopFixture(homeDir, adapter);
      await expect(fixture.requestStop()).resolves.toEqual({ status: 'incomplete', reason: 'terminal_attachment_descriptor_retirement_failed' });
      await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId: fixture.candidate.sessionId })).resolves.toMatchObject({ attachmentId: replacement.attachmentId });
    });
  });


  it('requires explicit Stop before Resume when an exact preserved host is not controllable', () => {
    expect(resolveDisconnectedTerminalHostResumeGate({
      state: 'recoverable_unservable',
      reason: 'control_descriptor_missing',
    })).toEqual({
      action: 'fence',
      reason: 'control_descriptor_missing',
    });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'servable' })).toEqual({ action: 'resume' });
    expect(resolveDisconnectedTerminalHostResumeGate({ state: 'stopped' })).toEqual({ action: 'resume' });
  });

  it('classifies a live bound provider host as running without mutating its attachment', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 123 })),
      dispose: vi.fn(),
    };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-live-1',
        pid: 43214,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'not_applicable',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-live-1',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      probeSessionServiceability: async () => ({ state: 'runner_present', control: { state: 'servable' } }),
    })).resolves.toEqual({ state: 'servable' });

    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('classifies an alive host with unavailable exact-session controls as recoverable without mutation', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 123 })), dispose: vi.fn(),
    };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: { sessionId: 'session-live-1', pid: 43214, happyHomeDir: '/tmp/happy', attachmentId: handle.attachmentId, handle, controlDescriptorStatus: 'available' },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2, attachmentId: handle.attachmentId, sessionId: 'session-live-1', handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } }, updatedAt: 1,
      }),
      probeSessionServiceability: async () => ({
        state: 'runner_present', control: { state: 'recoverable_unservable', reason: 'rpc_method_unavailable' },
      }),
    })).resolves.toEqual({ state: 'recoverable_unservable', reason: 'rpc_method_unavailable' });
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('classifies an exact alive host without its attachment-bound control descriptor as recoverable', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux', createOrAttachHost: vi.fn(), injectUserPrompt: vi.fn(), interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 123 })), dispose: vi.fn(),
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-live-1',
        pid: 43214,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'missing',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2, attachmentId: handle.attachmentId, sessionId: 'session-live-1', handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } }, updatedAt: 1,
      }),
      probeSessionServiceability: vi.fn(),
    })).resolves.toEqual({
      state: 'recoverable_unservable',
      reason: 'control_descriptor_missing',
    });
    expect(adapter.dispose).not.toHaveBeenCalled();
  });

  it('retains marker evidence after exact positive-dead retirement for awaited exact-turn staging', async () => {
    const calls: string[] = [];
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };
    const attachmentInfo = {
      version: 2 as const,
      attachmentId: handle.attachmentId,
      sessionId: 'session-dead-1',
      handle,
      terminal: { mode: 'tmux' as const, tmux: { target: 'happier-live-1:claude.1' } },
      updatedAt: 1,
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-1',
        pid: 43214,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => attachmentInfo,
      removeTerminalAttachmentInfo: async () => {
        calls.push('local-descriptor');
        return true;
      },
      retireExactTerminalControlServiceability: async (input) => {
        calls.push('remote-serviceability');
        expect(input.attachmentInfo).toBe(attachmentInfo);
      },
      onExactTerminalAttachmentRetired: async (input) => {
        calls.push('provider');
        expect(input.attachmentInfo).toBe(attachmentInfo);
      },
    })).resolves.toEqual({ state: 'stopped' });

    expect(calls).toEqual(['remote-serviceability', 'local-descriptor', 'provider']);
  });

  it('retains exact local evidence when remote serviceability retirement fails', async () => {
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };

    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-retirement-failed',
        pid: 43216,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-dead-retirement-failed',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      removeTerminalAttachmentInfo,
      retireExactTerminalControlServiceability: async () => {
        throw new Error('metadata update failed');
      },
      onExactTerminalAttachmentRetired,
    })).resolves.toEqual({ state: 'unknown', reason: 'retirement_failed' });

    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
    expect(onExactTerminalAttachmentRetired).not.toHaveBeenCalled();
  });

  it('retires the positively dead old host without changing a newer remote projection', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'dead-host-superseded-' }, async ({ homeDir }) => {
      const sessionId = 'session-dead-retirement-superseded';
      await writeTerminalAttachmentInfo({
        happyHomeDir: homeDir, sessionId, attachmentId: handle.attachmentId, handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
      });
      const metadata = JSON.stringify({
        terminal: { mode: 'tmux', controlServiceabilityV1: {
          v: 1, attachmentId: 'replacement-attachment', state: 'servable', observedAt: 20,
        } },
        unrelated: 'retained',
      });
      const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata });
      const get = vi.spyOn(axios, 'get').mockResolvedValue({
        status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() }, data: { session: raw },
      });
      try {
        const adapter: TerminalHostAdapter = {
          kind: 'tmux',
          createOrAttachHost: vi.fn(),
          injectUserPrompt: vi.fn(),
          interruptTurn: vi.fn(),
          evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
          dispose: vi.fn(async () => {}),
        };

        await expect(superviseDisconnectedTerminalHostCandidate({
          candidate: {
            sessionId,
            pid: 43217,
            happyHomeDir: homeDir,
            attachmentId: handle.attachmentId,
            handle,
            controlDescriptorStatus: 'available',
          },
          terminalHostAdapters: { tmux: adapter },
          retireExactTerminalControlServiceability: async ({ attachmentInfo }) => await retireExactTerminalControlServiceability({
            credentials: { token: 'test-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            sessionId, attachmentId: attachmentInfo.attachmentId, terminalMode: attachmentInfo.terminal.mode,
          }),
          onExactTerminalAttachmentRetired: async () => undefined,
        })).resolves.toEqual({ state: 'stopped' });

        expect(adapter.dispose).not.toHaveBeenCalled();
        expect(raw.metadata).toBe(metadata);
        await expect(readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId })).resolves.toBeNull();
      } finally { get.mockRestore(); }
    });
  });

  it('does not release marker evidence when provider cleanup fails after successful host retirement', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 123 })),
      dispose: vi.fn(async () => {}),
    };
    await expect(superviseDisconnectedTerminalHostCandidate({
      candidate: {
        sessionId: 'session-dead-cleanup-failed',
        pid: 43215,
        happyHomeDir: '/tmp/happy',
        attachmentId: handle.attachmentId,
        handle,
        controlDescriptorStatus: 'available',
      },
      terminalHostAdapters: { tmux: adapter },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: handle.attachmentId,
        sessionId: 'session-dead-cleanup-failed',
        handle,
        terminal: { mode: 'tmux', tmux: { target: 'happier-live-1:claude.1' } },
        updatedAt: 1,
      }),
      removeTerminalAttachmentInfo: async () => true,
      onExactTerminalAttachmentRetired: async () => { throw new Error('provider cleanup failed'); },
    })).resolves.toEqual({ state: 'stopped' });
  });
});
