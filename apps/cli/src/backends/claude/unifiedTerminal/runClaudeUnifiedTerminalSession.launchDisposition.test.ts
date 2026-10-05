import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childProcess from 'child_process';

import type {
  TerminalAttachmentId,
  TerminalHostAdapter,
  TerminalHostHandle,
} from '@/integrations/terminalHost/_types';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';

import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';
import { buildClaudeUnifiedTerminalSpawn } from './buildClaudeUnifiedTerminalSpawn';
import { requestClaudeExplicitRunnerStop } from '../claudeExplicitRunnerStop';
import { logger } from '@/ui/logger';
import { createTmuxTerminalHostAdapter, TmuxUtilities } from '@/integrations/tmux';
import { launchOwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const attachmentId = 'attachment-adopted-resume' as TerminalAttachmentId;
const existingHandle: TerminalHostHandle = {
  attachmentId,
  kind: 'tmux',
  sessionName: 'happier-adopted-resume',
  paneId: '%1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};
const existingAttachment: TerminalAttachmentInfo = {
  version: 2,
  attachmentId,
  sessionId: 'happy-adopted-resume',
  handle: existingHandle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
  terminal: {
    mode: 'tmux',
    tmux: { target: 'happier-adopted-resume:%1' },
  },
  updatedAt: 1,
};

function createAdapter(overrides: Partial<TerminalHostAdapter> = {}): TerminalHostAdapter {
  return {
    kind: 'tmux',
    createOrAttachHost: vi.fn(async () => existingHandle),
    injectUserPrompt: vi.fn(async () => ({
      status: 'injected' as const,
      at: Date.now(),
      bytesWritten: 0,
    })),
    interruptTurn: vi.fn(async () => undefined),
    evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function baseOptions(
  adapter: TerminalHostAdapter,
  abortController: AbortController,
): Parameters<typeof runClaudeUnifiedTerminalSession>[0] {
  return {
    path: '/workspace/project',
    happySessionId: 'happy-adopted-resume',
    sessionId: 'claude-resume-id',
    initialMode: {
      permissionMode: 'default',
      claudeUnifiedTerminalHost: 'tmux',
    },
    nextMessage: async () => null,
    signal: abortController.signal,
    resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
    readTerminalHostAttachmentInfo: async () => null,
    buildSpawn: async () => ({ spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'], spawnEnv: {} }),
    createSessionName: () => 'happier-fresh-resume',
    processSignals: null,
    createController: async () => ({
      run: async () => undefined,
      dispose: async () => undefined,
    }),
  };
}

describe('runClaudeUnifiedTerminalSession launch disposition', () => {
  it('retries a borrowed Stop after failed physical termination without retiring the pane or attachment early', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-claude-stop-retry-'));
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory, env: { PATH: process.env.PATH ?? '' } });
    const abortController = new AbortController();
    const adapter = createAdapter();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    let launcherPid: number | undefined;
    let attempts = 0;
    const failure = new Error('physical termination temporarily unavailable');
    try {
      await runClaudeUnifiedTerminalSession({
        ...baseOptions(adapter, abortController), path: directory,
        currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
        launchCurrentTerminalProcess: async () => launchOwnedTerminalProcess({ spawn: prepared, cwd: directory,
          terminateProcess: async (child) => {
            launcherPid = child.pid;
            attempts += 1;
            if (attempts === 1) throw failure;
            await killProcessTree(child);
          } }),
        persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
          storedAttachment = { version: 3, lifecycle: 'borrowed', sessionId, attachmentId,
            handle: { ...handle, attachmentId }, terminal, updatedAt: 1 };
        },
        readTerminalHostAttachmentInfo: async () => storedAttachment,
        removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
        onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
          await expect(stopTerminalHostForExplicitStop()).rejects.toBe(failure);
          expect(storedAttachment).toMatchObject({ version: 3, lifecycle: 'borrowed', attachmentId });
          expect(isPidAlive(launcherPid!)).toBe(true);
          await expect(stopTerminalHostForExplicitStop()).resolves.toBeUndefined();
          await expect(waitForProcessExit(launcherPid!, { timeoutMs: 3_000 })).resolves.toBe(true);
          expect(storedAttachment).toBeNull();
          await stopTerminalHostForExplicitStop();
          abortController.abort();
        },
      });
      expect(attempts).toBe(2);
      expect(adapter.dispose).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      if (launcherPid) await killProcessTree({ pid: launcherPid });
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retains exact borrowed attachment when owned child termination cannot be verified', async () => {
    const abortController = new AbortController();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    const removeAttachment = vi.fn(async () => { storedAttachment = null; });
    await runClaudeUnifiedTerminalSession({
      ...baseOptions(createAdapter(), abortController),
      createController: undefined,
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      launchCurrentTerminalProcess: async () => ({
        whenExited: new Promise<never>(() => undefined),
        terminate: async () => { throw new Error('owned-child-cleanup-unverified'); },
      }),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = { version: 3, lifecycle: 'borrowed', sessionId, attachmentId, handle: { ...handle, attachmentId }, terminal, updatedAt: 1 };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: removeAttachment,
      onTerminalHostReady: () => { abortController.abort(); },
    });
    expect(storedAttachment).toMatchObject({ version: 3, lifecycle: 'borrowed', handle: existingHandle });
    expect(removeAttachment).not.toHaveBeenCalled();
    logger.flushSync();
    expect(await readFile(logger.logFilePath, 'utf8')).toContain('owned-child-cleanup-unverified');
  });
  it('retains borrowed-terminal cleanup failures in the default session file log', async () => {
    logger.infoFile('Borrowed terminal cleanup regression started');
    const abortController = new AbortController();
    const adapter = createAdapter();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      createController: undefined,
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      // Process termination and attachment-file writes are external boundaries.
      launchCurrentTerminalProcess: async () => ({
        whenExited: new Promise<never>(() => undefined),
        terminate: async () => undefined,
      }),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 3, lifecycle: 'borrowed', sessionId, attachmentId,
          handle: { ...handle, attachmentId }, terminal, updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { throw new Error('cleanup-attachment-boundary-failed'); },
      onTerminalHostReady: () => { abortController.abort(); },
    });
    logger.flushSync();
    const log = await readFile(logger.logFilePath, 'utf8');
    expect(log).toContain('descriptor_retirement_failed');
    expect(storedAttachment).toMatchObject({
      version: 3,
      lifecycle: 'borrowed',
      attachmentId: existingHandle.attachmentId,
      handle: existingHandle,
    });
  });

  it('launches Claude in a borrowed terminal and stops the child without disposing the pane', async () => {
    const abortController = new AbortController();
    const createOrAttachHost = vi.fn(async () => existingHandle);
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ createOrAttachHost, dispose });
    const terminate = vi.fn(async () => undefined);
    const launchBorrowedProcess = vi.fn(async () => ({
      whenExited: new Promise<never>(() => undefined),
      terminate,
    }));
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: existingHandle, lifecycle: 'borrowed' },
      launchCurrentTerminalProcess: launchBorrowedProcess,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, lifecycle, terminal }) => {
        expect(lifecycle).toBe('borrowed');
        storedAttachment = {
          version: 3,
          lifecycle: 'borrowed',
          sessionId,
          attachmentId,
          handle: { ...handle, attachmentId },
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: async ({ lifecycle, stopTerminalHostForExplicitStop }) => {
        expect(lifecycle).toBe('borrowed');
        await stopTerminalHostForExplicitStop();
        abortController.abort();
      },
    });

    expect(launchBorrowedProcess).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace/project',
      spawn: expect.objectContaining({
        spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'],
      }),
    }));
    expect(createOrAttachHost).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(storedAttachment).toBeNull();
  });

  it('launches Claude in a daemon-owned current terminal and destroys that exact host on explicit stop', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    const terminate = vi.fn(async () => undefined);
    const launchCurrentTerminalProcess = vi.fn(async () => ({
      whenExited: new Promise<never>(() => undefined),
      terminate,
    }));
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: existingHandle, lifecycle: 'owned' },
      launchCurrentTerminalProcess,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, lifecycle, terminal }) => {
        expect(lifecycle).toBe('owned');
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: { ...handle, attachmentId },
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: async ({ lifecycle, stopTerminalHostForExplicitStop }) => {
        expect(lifecycle).toBe('owned');
        await stopTerminalHostForExplicitStop();
        abortController.abort();
      },
    });

    expect(launchCurrentTerminalProcess).toHaveBeenCalledOnce();
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('launches in the current terminal when its attachment exactly matches the daemon-bound saved host', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    const terminate = vi.fn(async () => undefined);
    const launchCurrentTerminalProcess = vi.fn(async () => ({
      whenExited: new Promise<never>(() => undefined),
      terminate,
    }));
    let storedAttachment: TerminalAttachmentInfo | null = existingAttachment;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: existingHandle, lifecycle: 'owned' },
      launchCurrentTerminalProcess,
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, lifecycle, terminal }) => {
        expect(lifecycle).toBe('owned');
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: { ...handle, attachmentId },
          terminal,
          updatedAt: 2,
        };
      },
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
        await stopTerminalHostForExplicitStop();
        abortController.abort();
      },
    });

    expect(launchCurrentTerminalProcess).toHaveBeenCalledOnce();
    expect(adapter.adoptExistingHost).toBeUndefined();
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('does not launch in a current terminal whose attachment differs from the saved live host', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter();
    const launchCurrentTerminalProcess = vi.fn();
    const mismatchedHandle: TerminalHostHandle = {
      ...existingHandle,
      attachmentId: 'attachment-different' as TerminalAttachmentId,
    };

    await expect(runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      currentTerminalHost: { handle: mismatchedHandle, lifecycle: 'owned' },
      launchCurrentTerminalProcess,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
    })).rejects.toMatchObject({ reason: 'live_attachment_adoption_unavailable' });

    expect(launchCurrentTerminalProcess).not.toHaveBeenCalled();
    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('can stop the exact acquired host while startup metadata publication is still in progress', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter();
    let storedAttachment: TerminalAttachmentInfo | null = null;
    let stopOwnedHost: (() => Promise<void>) | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      createController: undefined,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2, sessionId, attachmentId,
          handle: { ...handle, attachmentId }, terminal, updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => { storedAttachment = null; },
      onTerminalHostReady: ({ stopTerminalHostForExplicitStop }) => {
        stopOwnedHost = stopTerminalHostForExplicitStop;
      },
      // The API publication boundary can remain pending during startup. Stop must already
      // own the persisted attachment without waiting for this or provider initialization.
      publishTerminalHostMetadata: async () => {
        await requestClaudeExplicitRunnerStop({
          unifiedTerminalEnabled: true,
          stopTerminalHostForExplicitStop: stopOwnedHost,
          requestTermination: () => abortController.abort(),
          whenTerminated: Promise.resolve(),
        });
      },
    });

    expect(storedAttachment).toBeNull();
    expect(adapter.dispose).toHaveBeenCalledExactlyOnceWith(existingHandle);
    expect(adapter.injectUserPrompt).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(true);
  });

  it('publishes the host attachment before controller startup completes', async () => {
    const abortController = new AbortController();
    const adapter = createAdapter();
    let controllerRunStarted = false;
    let resolveControllerRun: (() => void) | null = null;
    const controllerRun = new Promise<void>((resolve) => {
      resolveControllerRun = resolve;
    });
    const publishTerminalHostMetadata = vi.fn(async () => {
      expect(controllerRunStarted).toBe(false);
      resolveControllerRun?.();
    });

    const runPromise = runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async () => undefined,
      publishTerminalHostMetadata,
      createController: async () => ({
        run: async () => {
          controllerRunStarted = true;
          await controllerRun;
          abortController.abort();
        },
        dispose: async () => undefined,
      }),
    });
    await runPromise;

    expect(publishTerminalHostMetadata).toHaveBeenCalledTimes(1);
    expect(publishTerminalHostMetadata).toHaveBeenCalledWith({
      mode: 'tmux',
      tmux: { target: 'happier-adopted-resume:%1' },
    });
  });

  it('destroys the exact owned host once when explicit runner stop is requested', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async ({ stopTerminalHostForExplicitStop }) => {
        try {
          expect(stopTerminalHostForExplicitStop).toBeTypeOf('function');
          await stopTerminalHostForExplicitStop();
          await stopTerminalHostForExplicitStop();
        } finally {
          abortController.abort();
        }
      },
    });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(existingHandle);
    expect(storedAttachment).toBeNull();
  });

  it('preserves the owned host when the runner wrapper exits without explicit stop', async () => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async () => {
        abortController.abort();
      },
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(storedAttachment).not.toBeNull();
  });

  it('preserves the owned host when the runner receives a process signal', async () => {
    const abortController = new AbortController();
    const processSignals = new EventEmitter();
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({ dispose });
    let storedAttachment: TerminalAttachmentInfo | null = null;

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      processSignals,
      persistTerminalHostAttachmentInfo: async ({ sessionId, attachmentId, handle, terminal }) => {
        storedAttachment = {
          version: 2,
          sessionId,
          attachmentId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          terminal,
          updatedAt: 1,
        };
      },
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo: async () => {
        storedAttachment = null;
      },
      onTerminalHostReady: async () => {
        processSignals.emit('SIGTERM');
      },
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(storedAttachment).not.toBeNull();
  });

  it('does not report a provider launch when it adopts the exact live terminal attachment', async () => {
    const abortController = new AbortController();
    const onProviderLaunchStarting = vi.fn(async () => undefined);
    const adoptExistingHost = vi.fn(async () => {
      abortController.abort();
      return existingHandle;
    });
    const createOrAttachHost = vi.fn(async () => existingHandle);
    const adapter = createAdapter({ adoptExistingHost, createOrAttachHost });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      expectedExistingTerminalHostAttachmentId: attachmentId,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
      onProviderLaunchStarting,
    });

    expect(adoptExistingHost).toHaveBeenCalledWith(existingHandle);
    expect(createOrAttachHost).not.toHaveBeenCalled();
    expect(onProviderLaunchStarting).not.toHaveBeenCalled();
  });

  it('reports one provider launch immediately before a fresh create with spawn argv', async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    const cleanupUnreadArtifacts = vi.fn(async () => undefined);
    const onProviderLaunchStarting = vi.fn(async () => {
      calls.push('launch_starting');
    });
    const createOrAttachHost = vi.fn(async (options) => {
      calls.push(`create:${options.spawnArgv.join(' ')}`);
      abortController.abort();
      return existingHandle;
    });
    const adapter = createAdapter({ createOrAttachHost });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      buildSpawn: async () => ({
        spawnArgv: ['/bin/claude', '--resume', 'claude-resume-id'],
        spawnEnv: {},
        launchSpecPath: '/synthetic/launch.json',
        cleanupUnreadArtifacts,
      }),
      onProviderLaunchStarting,
    });

    expect(onProviderLaunchStarting).toHaveBeenCalledTimes(1);
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
    expect(cleanupUnreadArtifacts).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'launch_starting',
      'create:/bin/claude --resume claude-resume-id',
    ]);
  });

  it('retires a positively dead legacy attachment before creating a fresh host', async () => {
    const abortController = new AbortController();
    const legacyAttachment: TerminalAttachmentInfo = {
      version: 1,
      sessionId: 'happy-adopted-resume',
      terminal: {
        mode: 'tmux',
        tmux: { target: 'happier-legacy:legacy-window', tmpDir: '/tmp/happier-tmux' },
      },
      updatedAt: 1,
    };
    let storedAttachment: TerminalAttachmentInfo | null = legacyAttachment;
    const createOrAttachHost = vi.fn(async () => {
      abortController.abort();
      return existingHandle;
    });
    const dispose = vi.fn(async () => undefined);
    const adapter = createAdapter({
      createOrAttachHost,
      dispose,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
    });
    const removeTerminalHostAttachmentInfo = vi.fn(async (input: Readonly<{
      expectedLegacyAttachment?: Extract<TerminalAttachmentInfo, Readonly<{ version: 1 }>>;
    }>) => {
      expect(input.expectedLegacyAttachment).toEqual(legacyAttachment);
      storedAttachment = null;
    });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      readTerminalHostAttachmentInfo: async () => storedAttachment,
      removeTerminalHostAttachmentInfo,
    });

    expect(removeTerminalHostAttachmentInfo).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
  });

  it('reports one provider launch immediately before confirmed-dead adoption fallback creates', async () => {
    const abortController = new AbortController();
    const calls: string[] = [];
    const onProviderLaunchStarting = vi.fn(async () => {
      calls.push('launch_starting');
    });
    const createOrAttachHost = vi.fn(async (options) => {
      calls.push(`create:${options.spawnArgv.join(' ')}`);
      abortController.abort();
      return existingHandle;
    });
    const adapter = createAdapter({
      adoptExistingHost: vi.fn(async () => {
        throw new Error('adoption failed after the host exited');
      }),
      createOrAttachHost,
      evaluateLiveness: vi.fn()
        .mockResolvedValueOnce({ paneAlive: true, observedAt: 1 })
        .mockResolvedValueOnce({ paneAlive: false, paneDead: true, observedAt: 2 }),
    });

    await runClaudeUnifiedTerminalSession({
      ...baseOptions(adapter, abortController),
      expectedExistingTerminalHostAttachmentId: attachmentId,
      readTerminalHostAttachmentInfo: async () => existingAttachment,
      removeTerminalHostAttachmentInfo: vi.fn(async () => undefined),
      onProviderLaunchStarting,
    });

    expect(onProviderLaunchStarting).toHaveBeenCalledTimes(1);
    expect(createOrAttachHost).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      'launch_starting',
      'create:/bin/claude --resume claude-resume-id',
    ]);
  });

  it.each(['not_started', 'unconfirmed'] as const)('preserves private launch inputs according to real tmux creation disposition (%s)', async (disposition) => {
    const abortController = new AbortController();
    // Replace only the OS tmux client. Host creation, immutable-identity parsing,
    // private launch materialization and the outer startup catch remain real.
    const spawnBoundary = vi.spyOn(childProcess, 'spawn');
    spawnBoundary.mockImplementation(((command: string, args: readonly string[]) => {
      if (command !== 'tmux') throw new Error('Unexpected fixture process');
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr });
      queueMicrotask(() => {
        if (args.includes('new-session')) {
          if (disposition === 'not_started') {
            stderr.emit('data', 'duplicate session: happier-fresh-resume');
            child.emit('close', 1);
          } else {
            stdout.emit('data', '12345\tmalformed-window-id\n');
            child.emit('close', 0);
          }
        } else {
          stdout.emit('data', 'happier-fixture\n');
          child.emit('close', 0);
        }
      });
      return child;
    }) as unknown as typeof childProcess.spawn);
    const adapter = createTmuxTerminalHostAdapter({ tmux: new TmuxUtilities() });
    let launchSpecPath: string | undefined;
    let mcpConfigPath: string | undefined;

    try {
      await expect(runClaudeUnifiedTerminalSession({
        ...baseOptions(adapter, abortController),
        happierMcpConfigJson: JSON.stringify({
          mcpServers: {
            fixture: {
              command: 'synthetic-mcp-server',
              env: { TOKEN: 'synthetic-pre-handoff-marker' },
            },
          },
        }),
        buildSpawn: async (params) => {
          const spawn = await buildClaudeUnifiedTerminalSpawn({
            ...params,
            deps: {
              resolveClaudeCliPath: () => '/synthetic/claude',
              isClaudeCliJavaScriptFile: () => false,
              ensureClaudeJsRuntimeExecutable: async () => '/synthetic/runtime',
              terminalLaunchSpecRunnerPath: '/synthetic/terminal-launch-spec-runner.cjs',
              resolveCommandInvocation: ({ command, args }) => ({ command, args: [...args] }),
            },
          });
          launchSpecPath = spawn.launchSpecPath;
          const launchSpec = JSON.parse(await readFile(launchSpecPath!, 'utf8')) as { args?: string[] };
          const mcpConfigIndex = launchSpec.args?.indexOf('--mcp-config') ?? -1;
          mcpConfigPath = launchSpec.args?.[mcpConfigIndex + 1];
          expect(JSON.stringify(launchSpec.args)).not.toContain('synthetic-pre-handoff-marker');
          await expect(readFile(mcpConfigPath!, 'utf8')).resolves.toContain('synthetic-pre-handoff-marker');
          return spawn;
        },
      })).rejects.toThrow();

      expect(launchSpecPath).toBeTruthy();
      expect(mcpConfigPath).toBeTruthy();
      if (disposition === 'unconfirmed') {
        await expect(stat(launchSpecPath!)).resolves.toBeDefined();
        await expect(stat(mcpConfigPath!)).resolves.toBeDefined();
      } else {
        await expect(stat(launchSpecPath!)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(mcpConfigPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      spawnBoundary.mockRestore();
      if (mcpConfigPath) await unlink(mcpConfigPath).catch(() => undefined);
      if (launchSpecPath) await unlink(launchSpecPath).catch(() => undefined);
    }
  });
});
