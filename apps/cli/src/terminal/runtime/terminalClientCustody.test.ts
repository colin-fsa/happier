import { afterEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

const os = vi.hoisted(() => ({
  census: vi.fn(async () => [{ pid: process.pid, ppid: process.ppid, name: 'launcher', cmd: '' },
    { pid: process.pid + 1, ppid: process.pid, name: 'native', cmd: '' }]),
  creationDate: '2026-10-02T12:00:00.0000000Z',
}));

// Windows OS census and CIM output are unavailable on the Linux test host;
// keep run-state, fingerprint parsing/matching and custody policy real.
vi.mock('ps-list', () => ({ default: os.census }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn((command: string) => {
    if (command !== 'powershell.exe') throw new Error('Unexpected process-instance OS probe');
    return { pid: 1, status: 0, signal: null, output: [null, os.creationDate, ''],
      stdout: os.creationDate, stderr: '' };
  }),
}));

import { proveTerminalClientCustody } from './terminalClientCustody';
import { logger } from '@/ui/logger';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

describe('native terminal client invocation custody', () => {
  it.each(['cmd', 'bat', 'exe'] as const)('admits the actually launched Windows %s invocation and rejects a different native target', async extension => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    const invocation = { command: `C:/provider/codex.${extension}`,
      args: ['--remote', 'tcp://127.0.0.1:65500', 'resume', 'exact-native-session'] };
    const env = { COMSPEC: 'C:/per-target/cmd.exe' };
    const actual = resolveWindowsCommandInvocation({ ...invocation, env, resolveCommandOnPath: false });
    const launcher = { pid: process.pid, processInstanceFingerprint: `win32-cim:${os.creationDate}` };
    const processes = { shellPid: process.ppid, foregroundProcesses: [
      { pid: process.pid, argv: [process.execPath, 'terminal_launch_spec_runner.cjs'] },
      { pid: process.pid + 1, argv: [actual.command, ...actual.args] },
    ] };
    expect(await proveTerminalClientCustody({ launcher, processes, invocation, env })).toBe(true);
    for (const args of [
      ['--remote', 'tcp://127.0.0.1:65501', 'resume', 'exact-native-session'],
      ['--remote', 'tcp://127.0.0.1:65500', 'resume', 'different-native-session'],
    ]) {
      // File logging is the external diagnostic output, not a custody-policy mock.
      const rejected = vi.spyOn(logger, 'infoFile');
      expect(await proveTerminalClientCustody({ launcher, processes, invocation: { ...invocation, args }, env })).toBe(false);
      expect(rejected).toHaveBeenLastCalledWith('[terminal] Native client custody refused', {
        reason: 'native_invocation_not_observed',
        launcherPid: launcher.pid, shellPid: processes.shellPid,
        expectedExecutable: extension === 'exe' ? 'codex.exe' : 'cmd.exe',
        expectedArgvLength: actual.args.length + 1,
        foreground: processes.foregroundProcesses.map(item => ({ pid: item.pid,
          executable: item.pid === launcher.pid ? basename(process.execPath) : extension === 'exe' ? 'codex.exe' : 'cmd.exe',
          argvLength: item.argv.length })),
      });
      expect(JSON.stringify(rejected.mock.calls)).not.toContain('different-native-session');
      expect(JSON.stringify(rejected.mock.calls)).not.toContain('65501');
    }
  });

  it.skipIf(process.platform !== 'linux')('preserves exact Linux executable and argv admission', async () => {
    const fingerprint = readProcessInstanceFingerprintSync(process.pid);
    if (!fingerprint) throw new Error('Test process has no OS-instance identity');
    const invocation = { command: process.execPath, args: ['native-client', 'exact-native-session'] };
    const launcher = { pid: process.pid, processInstanceFingerprint: fingerprint };
    const processes = { shellPid: process.ppid, foregroundProcesses: [
      { pid: process.pid, argv: [process.execPath, 'terminal_launch_spec_runner.cjs'] },
      { pid: process.pid + 1, argv: [invocation.command, ...invocation.args] },
    ] };
    expect(await proveTerminalClientCustody({ launcher, processes, invocation, env: {} })).toBe(true);
    expect(await proveTerminalClientCustody({ launcher, processes,
      invocation: { ...invocation, args: ['native-client', 'different-native-session'] }, env: {} })).toBe(false);
  });
});
