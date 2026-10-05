import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

function createRunnerScriptHarness() {
  const scriptPath = resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs');
  const source = readFileSync(scriptPath, 'utf8').replace(/^#!.*\n/, '');
  const scriptRequire = createRequire(scriptPath);
  const child = new EventEmitter();
  const spawn = vi.fn(() => child);
  const fakeProcess = Object.assign(new EventEmitter(), {
    argv: ['node', scriptPath],
    env: {},
    exit: vi.fn(),
    cwd: vi.fn(() => '/tmp/workspace'),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  });
  const module = { exports: {} as Record<string, unknown> };
  const fakeRequire = Object.assign((id: string) => {
    if (id === 'node:child_process') return { spawn };
    if (id === 'node:fs') return require(id);
    if (id === 'node:fs/promises') return require(id);
    if (id === 'node:os') return require(id);
    if (id === 'node:path') return require(id);
    if (id === './process_tree.cjs') return scriptRequire(id);
    throw new Error(`unexpected require: ${id}`);
  }, { main: {} });

  vm.runInNewContext(source, {
    console,
    module,
    exports: module.exports,
    process: fakeProcess,
    require: fakeRequire,
  });

  return { child, fakeProcess, module, spawn };
}

describe('terminal_launch_spec_runner.cjs', () => {
  it('keeps a genuine native spawn receipt when Node reports a later process operation error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const spawnResultPath = join(directory, 'native-startup.json');
    const { child, module } = createRunnerScriptHarness();
    const runLaunchSpec = module.exports.runLaunchSpec as (spec: {
      command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
      diagnostics: { logsDir: string; sessionExitDir: string; spawnResultPath: string };
    }) => Promise<number>;
    try {
      const result = runLaunchSpec({ command: 'native', args: [], cwd: directory, env: {},
        diagnostics: { logsDir: directory, sessionExitDir: directory, spawnResultPath } });
      const failed = expect(result).rejects.toThrow('native operation failed after startup');
      child.emit('spawn');
      child.emit('error', new Error('native operation failed after startup'));
      await failed;
      expect(JSON.parse(await readFile(spawnResultPath, 'utf8'))).toEqual({ status: 'spawned' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reports unexpected launch-directory content when consuming the handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-handoff-cleanup-'));
    const directory = await mkdtemp(join(root, 'happier-terminal-launch-'));
    const specPath = join(directory, 'launch.json');
    const unexpected = join(directory, 'unexpected');
    await writeFile(specPath, JSON.stringify({
      command: 'native', args: [], cwd: root, env: {},
      diagnostics: { logsDir: root, sessionExitDir: root },
    }));
    await writeFile(unexpected, 'retained');
    try {
      const scriptRequire = createRequire(resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs'));
      const { readLaunchSpecFile } = scriptRequire('./terminal_launch_spec_runner.cjs') as {
        readLaunchSpecFile(path: string): Promise<unknown>;
      };
      await readLaunchSpecFile(specPath);
      await expect(readFile(unexpected, 'utf8')).resolves.toBe('retained');
      await expect(readFile(join(root, 'terminal-launch-cleanup.log'), 'utf8')).resolves.toContain('terminal_launch_artifact_cleanup_incomplete:launch_handoff');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['spawned', 'failed'] as const)('reports incomplete artifact cleanup without masking native %s outcome', async (status) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-launcher-cleanup-fixture-'));
    const configDir = join(directory, 'happier-claude-mcp-config-private');
    const configPath = join(configDir, 'happier-claude-mcp-config.test.json');
    const unexpected = join(configDir, 'unexpected');
    const specPath = join(directory, 'launch.json');
    await mkdir(configDir);
    await writeFile(configPath, '{}');
    await writeFile(unexpected, 'retained');
    await writeFile(specPath, JSON.stringify({
      command: status === 'spawned' ? process.execPath : join(directory, 'missing-native'),
      args: status === 'spawned' ? ['-e', 'process.exit(0)'] : [],
      cwd: directory, env: {}, cleanupPaths: [configPath],
      diagnostics: { sessionId: 'fixture', logsDir: directory, sessionExitDir: directory },
    }));
    try {
      const child = spawn(process.execPath, [resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs'), specPath], { stdio: 'ignore' });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      });
      if (status === 'spawned') expect(code).toBe(0);
      else expect(code).not.toBe(0);
      await expect(readFile(unexpected, 'utf8')).resolves.toBe('retained');
      await expect(readFile(join(directory, 'terminal-launch-cleanup.log'), 'utf8')).resolves.toContain('terminal_launch_artifact_cleanup_incomplete');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['spawned', 'failed'] as const)('reports actual native %s through the hosted launch diagnostics boundary', async (status) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const specPath = join(directory, 'launch.json');
    const spawnResultPath = join(directory, 'native-startup.json');
    await writeFile(spawnResultPath, JSON.stringify({ status: 'pending' }));
    await writeFile(specPath, JSON.stringify({
      command: status === 'spawned' ? process.execPath : join(directory, 'missing-native'),
      args: status === 'spawned' ? ['-e', 'process.exit(0)'] : [],
      cwd: directory, env: {}, inheritStderr: true,
      diagnostics: { sessionId: 'fixture', logsDir: directory, sessionExitDir: directory, spawnResultPath },
    }));
    try {
      const child = spawn(process.execPath, [resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs'), specPath], { stdio: 'ignore' });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      });
      if (status === 'spawned') expect(code).toBe(0);
      else expect(code).not.toBe(0);
      expect(JSON.parse(await readFile(spawnResultPath, 'utf8'))).toEqual({ status });
      await expect(readFile(join(directory, 'terminal-launch-cleanup.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('preserves inherited native stderr instead of changing its terminal identity', async () => {
    const { child, module, spawn } = createRunnerScriptHarness();
    const runLaunchSpec = module.exports.runLaunchSpec as (spec: {
      command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; inheritStderr: boolean;
    }) => Promise<number>;
    const directory = await mkdtemp(join(tmpdir(), 'happier-native-stderr-'));
    const specPath = join(directory, 'launch.json');
    const readLaunchSpecFile = module.exports.readLaunchSpecFile as (path: string) => Promise<Parameters<typeof runLaunchSpec>[0]>;
    await writeFile(specPath, JSON.stringify({ command: 'native', args: [], cwd: directory, env: {}, inheritStderr: true }));
    try {
      const result = runLaunchSpec(await readLaunchSpecFile(specPath));
      expect(spawn).toHaveBeenCalledWith('native', [], expect.objectContaining({ stdio: ['inherit', 'inherit', 'inherit'] }));
      child.emit('close', 0, null);
      await result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('forwards Windows verbatim argument handling to the child process', async () => {
    const { child, module, spawn } = createRunnerScriptHarness();
    const runLaunchSpec = module.exports.runLaunchSpec as (spec: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      windowsVerbatimArguments?: boolean;
    }) => Promise<number>;

    const result = runLaunchSpec({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd"'],
      cwd: 'C:\\workspace',
      env: {},
      windowsVerbatimArguments: true,
    });

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      expect.any(Array),
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
    child.emit('close', 0, null);
    await expect(result).resolves.toBe(0);
  });

  it('ignores terminal interrupt signals while the child is alive', async () => {
    const { child, fakeProcess, module } = createRunnerScriptHarness();
    const runLaunchSpec = module.exports.runLaunchSpec as (spec: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }) => Promise<number>;

    const result = runLaunchSpec({ command: 'child', args: [], cwd: '/tmp/workspace', env: {} });

    expect(fakeProcess.listenerCount('SIGINT')).toBe(1);
    expect(fakeProcess.listenerCount('SIGQUIT')).toBe(1);
    expect(fakeProcess.listenerCount('SIGTSTP')).toBe(0);
    fakeProcess.emit('SIGINT');
    child.emit('close', 0, null);

    await expect(result).resolves.toBe(0);
    expect(fakeProcess.listenerCount('SIGINT')).toBe(0);
    expect(fakeProcess.listenerCount('SIGQUIT')).toBe(0);
    expect(fakeProcess.listenerCount('SIGTSTP')).toBe(0);
  });
});
