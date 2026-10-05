import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { bundleInstalledPackageWithRuntimeDependencies } from '@happier-dev/cli-common/workspaces';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import { launchOwnedTerminalProcess } from './ownedTerminalProcess';
import { createUnreadTerminalArtifactsCleanup, prepareOwnedTerminalSpawn } from './terminalLaunchSpec';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';

describe('launchOwnedTerminalProcess', () => {
  it('exposes exact launcher identity only after native startup while preserving its own child lifetime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-custody-'));
    const nativeIdentityPath = join(directory, 'native.json');
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(nativeIdentityPath)},JSON.stringify({pid:process.pid,launcherPid:process.ppid}));setInterval(()=>{},1000)`],
      cwd: directory, env: { PATH: process.env.PATH ?? '' } });
    let launcher: ReturnType<typeof spawn> | undefined;
    // Instrument only actual OS process creation; launcher IPC and child execution stay real.
    const spawnProcess = ((...args: Parameters<typeof spawn>) => {
      launcher = spawn(...args);
      return launcher;
    }) as typeof spawn;
    try {
      const launched = await launchOwnedTerminalProcess({ spawn: prepared, cwd: directory, spawnProcess });
      const fingerprint = readProcessInstanceFingerprintSync(launcher!.pid!);
      expect(fingerprint).toBeTruthy();
      expect(launched).toMatchObject({ launcherIdentity: { pid: launcher!.pid, processInstanceFingerprint: fingerprint } });
      let native!: { pid: number; launcherPid: number };
      await vi.waitFor(async () => { native = JSON.parse(await readFile(nativeIdentityPath, 'utf8')); });
      expect(native.launcherPid).toBe(launcher!.pid);
      expect(native.pid).not.toBe(launcher!.pid);
      await launched.terminate();
      await launched.whenExited;
      expect(isPidAlive(native.pid)).toBe(false);
    } finally {
      if (launcher) await killProcessTree(launcher);
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retries failed physical termination while coalescing each attempt and retaining successful completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-termination-retry-'));
    const prepared = await prepareOwnedTerminalSpawn({ command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory, env: { PATH: process.env.PATH ?? '' } });
    const failure = new Error('physical termination temporarily unavailable');
    let rejectFirst!: (error: Error) => void;
    const firstBoundary = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    let releaseSecond!: () => void;
    const secondBoundary = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let attempts = 0;
    let launcherPid: number | undefined;
    try {
      const launched = await launchOwnedTerminalProcess({ spawn: prepared, cwd: directory,
        terminateProcess: async (child) => {
          launcherPid = child.pid;
          attempts += 1;
          if (attempts === 1) return firstBoundary;
          await secondBoundary;
          await killProcessTree(child);
        } });
      const first = launched.terminate();
      const firstNeighbor = launched.terminate();
      expect(firstNeighbor).toBe(first);
      const failureObserved = expect(first).rejects.toBe(failure);
      rejectFirst(failure);
      await failureObserved;
      expect(isPidAlive(launcherPid!)).toBe(true);
      const retry = launched.terminate();
      expect(launched.terminate()).toBe(retry);
      releaseSecond();
      await expect(retry).resolves.toBeUndefined();
      await expect(waitForProcessExit(launcherPid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await launched.whenExited;
      expect(launched.terminate()).toBe(retry);
      expect(attempts).toBe(2);
    } finally {
      releaseSecond();
      if (launcherPid) await killProcessTree({ pid: launcherPid });
      await prepared.cleanupUnreadArtifacts?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const bunAvailable = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  it.each([
    { controllerRuntime: process.execPath, launcherRuntime: process.execPath, lifetime: true },
    ...(bunAvailable ? [
      { controllerRuntime: 'bun', launcherRuntime: process.execPath, lifetime: true },
      { controllerRuntime: process.execPath, launcherRuntime: 'bun', lifetime: true },
      { controllerRuntime: 'bun', launcherRuntime: 'bun', lifetime: true },
    ] : []),
    { controllerRuntime: process.execPath, launcherRuntime: process.execPath, lifetime: false },
  ])('handles controller loss with controller=$controllerRuntime launcher=$launcherRuntime lifetime=$lifetime, preserving unrelated shell', async ({ controllerRuntime, launcherRuntime, lifetime }) => {
    if (process.platform === 'win32') return; // SIGKILL controller-loss proof is POSIX-specific.
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-lifetime-'));
    const readyPath = join(directory, 'ready.json');
    const specPath = join(directory, 'launch.json');
    // Isolated development assets exercise the real sidecar dependency owner, without
    // repository-hoisted node_modules hiding a missing ps-list runtime dependency.
    const scriptsDirectory = join(directory, 'scripts');
    await mkdir(scriptsDirectory);
    for (const filename of ['terminal_launch_spec_runner.cjs', 'process_tree.cjs']) {
      await cp(resolve('scripts', filename), join(scriptsDirectory, filename));
    }
    bundleInstalledPackageWithRuntimeDependencies({
      packageName: 'ps-list',
      resolveFromPackageJsonPath: resolve('package.json'),
      destNodeModulesDir: join(directory, 'node_modules'),
    });
    const runnerPath = join(scriptsDirectory, 'terminal_launch_spec_runner.cjs');
    const ownerUrl = pathToFileURL(resolve('src/terminal/runtime/ownedTerminalProcess.ts')).href;
    const descendant = 'process.send(process.pid); setInterval(() => {}, 1000);';
    const provider = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', pid => require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ launcher: process.ppid, provider: process.pid, descendant: pid })));
      process.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); child.kill('SIGTERM'); });
      setInterval(() => {}, 1000);
    `;
    await writeFile(specPath, JSON.stringify({ command: process.execPath, args: ['-e', provider], cwd: directory, env: { PATH: process.env.PATH ?? '' } }));
    const source = lifetime ? `
      const { launchOwnedTerminalProcess } = await import(${JSON.stringify(ownerUrl)});
      const launched = await launchOwnedTerminalProcess({ spawn: { spawnArgv: [${JSON.stringify(launcherRuntime)}, ${JSON.stringify(runnerPath)}, ${JSON.stringify(specPath)}], spawnEnv: process.env }, cwd: ${JSON.stringify(directory)} });
      await launched.whenExited;
    ` : `
      const { spawn } = await import('node:child_process');
      const launcher = spawn(${JSON.stringify(launcherRuntime)}, [${JSON.stringify(runnerPath)}, ${JSON.stringify(specPath)}], { stdio: 'ignore' });
      await new Promise(resolve => launcher.once('exit', resolve));
    `;
    const runtimeArgs = controllerRuntime === 'bun' ? ['-e', source] : ['--import', 'tsx', '--input-type=module', '-e', source];
    const controller = spawn(controllerRuntime, runtimeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    let controllerStderr = '';
    controller.stderr?.on('data', (chunk: Buffer) => { controllerStderr += chunk.toString(); });
    const sentinel = spawn('/bin/sh', ['-c', 'sleep 600'], { stdio: 'ignore' });
    let tree: { launcher: number; provider: number; descendant: number } | undefined;
    try {
      await vi.waitFor(async () => {
        try {
          tree = JSON.parse(await readFile(readyPath, 'utf8'));
        } catch (error) {
          const handoffPending = await stat(specPath).then(() => true, (failure: NodeJS.ErrnoException) => failure.code !== 'ENOENT');
          throw new Error(`Provider tree not ready (controller exit=${controller.exitCode}; handoffPending=${handoffPending}; stderr=${controllerStderr})`, { cause: error });
        }
      }, { timeout: 10_000 });
      expect(isPidAlive(tree!.descendant)).toBe(true);
      controller.kill('SIGKILL');
      await expect(waitForProcessExit(controller.pid!, { timeoutMs: 10_000 })).resolves.toBe(true);
      if (lifetime) {
        await expect(waitForProcessExit(tree!.provider, { timeoutMs: 3_000 })).resolves.toBe(true);
        await expect(waitForProcessExit(tree!.descendant, { timeoutMs: 3_000 })).resolves.toBe(true);
      } else {
        // Independent recoverable hosts must outlive the process which originally opened them.
        await expect(waitForProcessExit(tree!.provider, { timeoutMs: 3_000 })).resolves.toBe(false);
        expect(isPidAlive(tree!.descendant)).toBe(true);
      }
      expect(isPidAlive(sentinel.pid!)).toBe(true);
    } finally {
      if (tree) await killProcessTree({ pid: tree.launcher });
      await killProcessTree(controller);
      await killProcessTree(sentinel);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('observes a normal provider close while the same-pane controller remains alive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-borrowed-normal-close-'));
    const specPath = join(directory, 'launch.json');
    await writeFile(specPath, JSON.stringify({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory, env: {} }));
    try {
      const launched = await launchOwnedTerminalProcess({
        spawn: { spawnArgv: [process.execPath, resolve('scripts/terminal_launch_spec_runner.cjs'), specPath], spawnEnv: {} },
        cwd: directory,
      });
      await expect(launched.whenExited).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('does not acknowledge startup when the native executable cannot spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-missing-native-'));
    const specPath = join(directory, 'launch.json');
    await writeFile(specPath, JSON.stringify({ command: join(directory, 'missing-native'), args: [], cwd: directory, env: {} }));
    try {
      await expect(launchOwnedTerminalProcess({
        spawn: { spawnArgv: [process.execPath, resolve('scripts/terminal_launch_spec_runner.cjs'), specPath], spawnEnv: {} },
        cwd: directory,
      })).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('runs the existing launch argv in the current terminal and terminates only its process tree', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null as number | null });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('message', { type: 'terminal-native-spawned' }));
      return child;
    });
    const terminateProcess = vi.fn(async () => undefined);

    const launched = await launchOwnedTerminalProcess({
      spawn: {
        spawnArgv: ['/managed/node', '/happier/terminal_launch_spec_runner.cjs', '/tmp/launch.json'],
        spawnEnv: { PATH: '/bin', TERM: 'xterm-256color' },
      },
      cwd: '/workspace/project',
      spawnProcess: spawnProcess as never,
      terminateProcess,
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      '/managed/node',
      ['/happier/terminal_launch_spec_runner.cjs', '/tmp/launch.json'],
      expect.objectContaining({
        cwd: '/workspace/project',
        env: { PATH: '/bin', TERM: 'xterm-256color' },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      }),
    );

    child.emit('exit', 0, null);
    await expect(launched.whenExited).resolves.toEqual({ code: 0, signal: null });
    await launched.terminate();
    await launched.terminate();
    expect(terminateProcess).toHaveBeenCalledOnce();
    expect(terminateProcess).toHaveBeenCalledWith(child);
  });

  it('reports a spawn failure through startup without leaking an unhandled exit rejection', async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null as number | null });
    const failure = new Error('spawn failed');
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', failure));
      return child;
    });

    await expect(launchOwnedTerminalProcess({
      spawn: { spawnArgv: ['/missing/managed-node'], spawnEnv: { PATH: '/bin' } },
      cwd: '/workspace/project',
      spawnProcess: spawnProcess as never,
    })).rejects.toBe(failure);
  });

  it('retains the original OS spawn failure when private artifact cleanup is incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const launchSpecPath = join(directory, 'launch.json');
    await writeFile(launchSpecPath, '{}');
    await writeFile(join(directory, 'unexpected-entry'), 'retained');
    try {
      await expect(launchOwnedTerminalProcess({
        spawn: {
          spawnArgv: [join(directory, 'nonexistent-executable')],
          spawnEnv: {},
          cleanupUnreadArtifacts: createUnreadTerminalArtifactsCleanup({ launchSpecPath }),
        },
        cwd: directory,
      })).rejects.toMatchObject({
        name: 'AggregateError',
        cause: expect.objectContaining({ code: 'ENOENT' }),
        errors: [expect.objectContaining({ code: 'ENOENT' }), expect.any(AggregateError)],
      });
      await expect(readFile(join(directory, 'unexpected-entry'), 'utf8')).resolves.toBe('retained');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
