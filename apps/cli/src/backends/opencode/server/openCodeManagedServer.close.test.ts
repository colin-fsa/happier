import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const resolveWindowsCommandInvocationMock = vi.fn((
  { command, args }: { command: string; args: readonly string[] },
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => ({
  command,
  args: [...args],
}));
const resolveOpenCodeCliLaunchSpecMock = vi.fn(() => ({ command: 'opencode', args: [], apiGeneration: 'auto' as const }));
const resolveOpenCodeManagedServerChildEnvMock = vi.fn(() => ({ PATH: process.env.PATH ?? '' }));
const resolveOpenCodeManagedServerTrackedPidMock = vi.fn(async ({ spawnPid }: { spawnPid: number }) => spawnPid);
const waitForOpenCodeServerHealthMock = vi.fn(async () => {});
const MOCK_LOG_PATH = '/tmp/happier-fake-managed-server.log';
const logCaptureCloseMock = vi.fn(async () => {});
const createOpenCodeManagedServerLogCaptureMock = vi.fn(() => ({
  logPath: MOCK_LOG_PATH,
  write: vi.fn(),
  recordTrackedPid: vi.fn(),
  recordNote: vi.fn(),
  close: logCaptureCloseMock,
}));
const pruneOpenCodeManagedServerLogsMock = vi.fn(async () => {});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

vi.mock('@happier-dev/cli-common/process', () => ({
  resolveWindowsCommandInvocation: resolveWindowsCommandInvocationMock,
}));

vi.mock('@/backends/opencode/utils/resolveOpenCodeCliCommand', () => ({
  resolveOpenCodeCliLaunchSpec: resolveOpenCodeCliLaunchSpecMock,
}));

vi.mock('./openCodeManagedServerEnv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openCodeManagedServerEnv')>()),
  resolveOpenCodeManagedServerChildEnv: resolveOpenCodeManagedServerChildEnvMock,
}));

vi.mock('./resolveOpenCodeManagedServerTrackedPid', () => ({
  resolveOpenCodeManagedServerTrackedPid: resolveOpenCodeManagedServerTrackedPidMock,
}));

vi.mock('./waitForOpenCodeServerHealth', () => ({
  waitForOpenCodeServerHealth: waitForOpenCodeServerHealthMock,
}));

vi.mock('./managedServerLogs', () => ({
  createOpenCodeManagedServerLogCapture: createOpenCodeManagedServerLogCaptureMock,
  pruneOpenCodeManagedServerLogs: pruneOpenCodeManagedServerLogsMock,
}));

function createManagedServerProcessHarness(): {
  proc: EventEmitter & {
    pid: number;
    stdout: EventEmitter & { resume: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { resume: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
} {
  const stdout = new EventEmitter() as EventEmitter & { resume: ReturnType<typeof vi.fn> };
  stdout.resume = vi.fn();

  const stderr = new EventEmitter() as EventEmitter & { resume: ReturnType<typeof vi.fn> };
  stderr.resume = vi.fn();

  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  proc.pid = 43111;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  proc.unref = vi.fn();

  return { proc };
}

describe('startManagedOpenCodeServer Windows launch cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
    resolveWindowsCommandInvocationMock.mockReset();
    resolveWindowsCommandInvocationMock.mockImplementation((
      { command, args }: { command: string; args: readonly string[] },
    ): { command: string; args: string[]; windowsVerbatimArguments?: boolean } => ({
      command,
      args: [...args],
    }));
    resolveOpenCodeCliLaunchSpecMock.mockClear();
    resolveOpenCodeManagedServerChildEnvMock.mockClear();
    resolveOpenCodeManagedServerTrackedPidMock.mockReset();
    resolveOpenCodeManagedServerTrackedPidMock.mockImplementation(async ({ spawnPid }: { spawnPid: number }) => spawnPid);
    waitForOpenCodeServerHealthMock.mockReset();
    waitForOpenCodeServerHealthMock.mockResolvedValue(undefined);
  });

  it('wraps Windows shell shims before spawning the managed server and tracks the real server pid', async () => {
    const { proc } = createManagedServerProcessHarness();
    spawnMock.mockReturnValue(proc);
    const callOrder: string[] = [];
    let trackedPidAlive = true;
    const realKill = process.kill.bind(process);
    // The OS boundary models the tracked native PID; the termination owner stays real.
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (Math.abs(pid) !== 48123) return realKill(pid, signal);
      if (signal === 0 && !trackedPidAlive) throw Object.assign(new Error('Process exited'), { code: 'ESRCH' });
      if (signal !== 0) trackedPidAlive = false;
      return true;
    });
    resolveOpenCodeManagedServerTrackedPidMock.mockResolvedValue(48123);
    resolveOpenCodeManagedServerTrackedPidMock.mockImplementation(async ({ spawnPid }: { spawnPid: number }) => {
      callOrder.push('resolveTrackedPid');
      return spawnPid === 43111 ? 48123 : spawnPid;
    });
    waitForOpenCodeServerHealthMock.mockImplementation(async () => {
      callOrder.push('health');
    });
    resolveOpenCodeCliLaunchSpecMock.mockReturnValue({
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      args: [],
      apiGeneration: 'auto',
    });
    resolveWindowsCommandInvocationMock.mockReturnValue({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD serve --hostname=127.0.0.1 --port=43111"'],
      windowsVerbatimArguments: true,
    });

    const { startManagedOpenCodeServer } = await import('./openCodeManagedServer');
    const onSpawned = vi.fn(() => {
      callOrder.push('onSpawned');
    });
    const started = await startManagedOpenCodeServer({ port: 43111, timeoutMs: 25, onSpawned });

    expect(resolveWindowsCommandInvocationMock).toHaveBeenCalledWith(expect.objectContaining({
      command: 'C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD',
      args: ['serve', '--hostname=127.0.0.1', '--port=43111'],
    }));
    expect(resolveOpenCodeManagedServerTrackedPidMock).toHaveBeenCalledWith(expect.objectContaining({
      spawnPid: 43111,
      baseUrl: 'http://127.0.0.1:43111',
      invocationCommand: 'C:\\Windows\\System32\\cmd.exe',
    }));
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Users\\natan\\AppData\\Roaming\\npm\\opencode.CMD serve --hostname=127.0.0.1 --port=43111"'],
      expect.objectContaining({ detached: true, windowsVerbatimArguments: true }),
    );
    expect(started.pid).toBe(48123);
    expect(started.logPath).toBe(MOCK_LOG_PATH);
    expect(onSpawned).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:43111',
      pid: 48123,
      logPath: MOCK_LOG_PATH,
      apiGeneration: 'auto',
    }));
    expect(callOrder).toEqual(['health', 'resolveTrackedPid', 'onSpawned']);

    await started.close();
    expect(trackedPidAlive).toBe(false);
  });
});
