import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareBinarySmokeArtifact, usesPreparedBinarySmokeArtifacts } from './testkit/core/build_binary_smoke_artifact.mjs';

function formatSpawnSyncResult(result) {
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const error = result.error ? String(result.error.stack || result.error.message || result.error) : '';
  const status = typeof result.status === 'number' ? String(result.status) : '<null>';
  const signal = result.signal ? String(result.signal) : '<null>';
  return [
    `status=${status}`,
    `signal=${signal}`,
    error ? `error=${error}` : '',
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function commandExists(cmd) {
  return spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function currentTarget() {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : '';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!os || !arch) return '';
  return `${os}-${arch}`;
}

test('compiled hstack binary runs self-host help outside repo checkout', async (t) => {
  if (!usesPreparedBinarySmokeArtifacts() && !commandExists('bun')) {
    t.skip('bun is required for compiled binary smoke tests');
    return;
  }
  const target = currentTarget();
  if (!target) {
    t.skip(`unsupported platform for smoke test: ${process.platform}-${process.arch}`);
    return;
  }

  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const version = usesPreparedBinarySmokeArtifacts()
    ? JSON.parse(await readFile(join(repoRoot, 'apps/stack/package.json'), 'utf8')).version
    : `0.0.0-smoke.${Date.now()}`;
  const artifact = join(repoRoot, 'dist', 'release-assets', 'stack', `hstack-v${version}-${target}.tar.gz`);
  await prepareBinarySmokeArtifact({
    artifactPath: artifact,
    build: () => {
      const build = spawnSync(
        process.execPath,
        [
          'scripts/pipeline/release/build-hstack-binaries.mjs',
          '--channel=preview',
          `--version=${version}`,
          `--targets=${target}`,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          env: {
            ...process.env,
          },
          // If this ever hangs on CI, fail with a clear timeout rather than blocking the entire suite.
          timeout: 15 * 60 * 1000,
          maxBuffer: 50 * 1024 * 1024,
        }
      );
      assert.equal(build.status, 0, formatSpawnSyncResult(build));
    },
  });
  const extractDir = await mkdtemp(join(tmpdir(), 'hstack-binary-smoke-'));
  t.after(() => {
    spawnSync('bash', ['-lc', `rm -rf "${extractDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
  });
  const untar = spawnSync('tar', ['-xzf', artifact, '-C', extractDir], { encoding: 'utf-8' });
  assert.equal(untar.status, 0, untar.stderr);

  const entries = await readdir(extractDir);
  assert.ok(entries.length > 0, 'expected extracted artifact directory');
  const binaryPath = join(extractDir, entries[0], 'hstack');

  const help = spawnSync(binaryPath, ['self-host', '--help'], {
    cwd: '/tmp',
    encoding: 'utf-8',
    env: {
      ...process.env,
      HAPPIER_NONINTERACTIVE: '1',
    },
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /hstack self-host install/);
  assert.match(help.stdout, /works without a repository checkout/);
});
