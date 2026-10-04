import { execFile } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { withTempDir } from '../src/testkit/fs/tempDir';

const execFileAsync = promisify(execFile);
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('loads both process owners from a detached compiled executable without runtime sidecars', async () => {
  await withTempDir('happier-detached-process-owners-', async (root) => {
    const buildDir = join(root, 'build');
    const runnerDir = join(root, 'runner');
    const unrelatedCwd = join(root, 'unrelated-cwd');
    const homeDir = join(root, 'home');
    await Promise.all([buildDir, runnerDir, unrelatedCwd, homeDir].map((dir) => mkdir(dir)));

    const entrypoint = join(buildDir, 'probe.ts');
    await writeFile(entrypoint, [
      `import { isPidAliveBySignal } from ${JSON.stringify(join(cliRoot, 'src/daemon/processRunState.ts'))};`,
      `import { killProcessTree } from ${JSON.stringify(join(cliRoot, 'src/agent/runtime/process/killProcessTree.ts'))};`,
      'await killProcessTree({});',
      'process.stdout.write(JSON.stringify({ alive: isPidAliveBySignal(process.pid) }));',
      'process.exit(0);',
    ].join('\n'));

    const executableName = process.platform === 'win32' ? 'happier.exe' : 'happier';
    const builtExecutable = join(buildDir, executableName);
    await execFileAsync('bun', [
      'build', '--compile', '--no-cache',
      '--tsconfig-override', join(cliRoot, 'tsconfig.json'),
      entrypoint, '--outfile', builtExecutable,
    ], { cwd: cliRoot });

    // Windows payload promotion executes a copied binary outside the source payload so
    // its executable does not lock the directory being atomically promoted.
    const detachedExecutable = join(runnerDir, executableName);
    await copyFile(builtExecutable, detachedExecutable);
    const { stdout } = await execFileAsync(detachedExecutable, [], {
      cwd: unrelatedCwd,
      env: { ...process.env, HAPPIER_HOME_DIR: homeDir },
    });
    expect(JSON.parse(stdout)).toEqual({ alive: true });
  });
});
