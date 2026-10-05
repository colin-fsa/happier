import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../../apps/stack/scripts/testkit/core/fake_bin_harness.mjs';

import {
  parseTrailingJsonObjectForTests,
  resolveSigningEnvForTests,
  prepareInstallersSmokeLocalBuildAssets,
} from '../pipeline/release-validation/executors/installers-smoke-local-build.mjs';

test('installer smoke signs downloaded producer bytes without building or altering the shared input', async (t) => {
  const fixture = await createTempFixture(t);
  const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const version = JSON.parse(await readFile(join(repoRoot, 'apps/cli/package.json'), 'utf8')).version;
  const assetsDir = fixture.path('producer');
  await mkdir(assetsDir);
  const archiveName = `happier-v${version}-${process.platform}-${process.arch}.tar.gz`;
  const checksumsName = `checksums-happier-v${version}.txt`;
  await writeFile(join(assetsDir, archiveName), 'producer bytes');
  await writeFile(join(assetsDir, checksumsName), 'producer checksums');
  // Minisign is an external process boundary. Native CI exercises real signing
  // and installer verification; this fixture proves custody without a rebuild.
  const { binDir } = writeFakeBin({ root: fixture.root, name: 'minisign', content: `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === '-G') { fs.writeFileSync(args[args.indexOf('-p')+1], 'public'); fs.writeFileSync(args[args.indexOf('-s')+1], 'private'); }
if (args[0] === '-S') fs.writeFileSync(args[args.indexOf('-x')+1], 'signature');
` });
  const prepared = await prepareInstallersSmokeLocalBuildAssets({
    repoRoot, platform: process.platform, releaseChannel: 'publicdev',
    baseEnv: buildStackHarnessEnv({ binDirs: [binDir], extraEnv: { HAPPIER_RELEASE_ASSETS_DIR: assetsDir } }),
    runCommand(command, args, options) {
      if (args.some((arg) => String(arg).endsWith('build-cli-binaries.mjs'))) throw new Error('unexpected CLI rebuild');
      // Canonical shared outputs are already present in this isolated worktree.
      if (args.some((arg) => String(arg).endsWith('buildSharedDeps.mjs'))) return '';
      return execFileSync(command, args, options);
    },
  });
  t.after(() => prepared.cleanup());
  assert.equal(prepared.installVersion, version);
  assert.equal(await readFile(join(prepared.assetsDir, archiveName), 'utf8'), 'producer bytes');
  assert.equal(await readFile(join(prepared.assetsDir, `${checksumsName}.minisig`), 'utf8'), 'signature');
  await assert.rejects(readFile(join(assetsDir, `${checksumsName}.minisig`)), { code: 'ENOENT' });
});

test('installers-smoke local-build parses the trailing build-cli JSON payload after tool chatter', () => {
  const parsed = parseTrailingJsonObjectForTests(`
yarn run v1.22.22
$ node scripts/pipeline/release/build-cli-binaries.mjs --channel preview --targets darwin-arm64
{
  "product": "happier",
  "channel": "preview",
  "version": "1.2.3-preview.4",
  "outDir": "/tmp/dist/release-assets/cli",
  "artifacts": [
    "happier-v1.2.3-preview.4-darwin-arm64.tar.gz"
  ],
  "checksums": "/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt",
  "signature": "/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt.minisig"
}`);

  assert.deepEqual(parsed, {
    product: 'happier',
    channel: 'preview',
    version: '1.2.3-preview.4',
    outDir: '/tmp/dist/release-assets/cli',
    artifacts: [
      'happier-v1.2.3-preview.4-darwin-arm64.tar.gz',
    ],
    checksums: '/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt',
    signature: '/tmp/dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt.minisig',
  });
});

test('installers-smoke local-build bootstrap still returns a minisign dir when GITHUB_PATH is set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installers-smoke-local-build-test-'));
  const repoRoot = join(root, 'repo');
  const scratchDir = join(root, 'scratch');
  const bootstrapDir = join(repoRoot, '.github', 'actions', 'bootstrap-minisign');
  const pathBinDir = join(root, 'path-bin');
  const minisignDir = join(root, 'bootstrapped-bin');
  const githubPathFile = join(root, 'github-path.txt');

  await mkdir(bootstrapDir, { recursive: true });
  await mkdir(scratchDir, { recursive: true });
  await mkdir(pathBinDir, { recursive: true });
  await mkdir(minisignDir, { recursive: true });

  const bashPath = join(pathBinDir, 'bash');
  await writeFile(
    bashPath,
    `#!/bin/bash
set -euo pipefail
exec /bin/bash "$@"
`,
    'utf8',
  );
  await chmod(bashPath, 0o755);

  const minisignPath = join(minisignDir, 'minisign');
  await writeFile(
    minisignPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-v" ]]; then
  exit 0
fi
echo "unexpected minisign args: $*" >&2
exit 1
`,
    'utf8',
  );
  await chmod(minisignPath, 0o755);

  const bootstrapPath = join(bootstrapDir, 'bootstrap-minisign.sh');
  await writeFile(
    bootstrapPath,
    `#!/usr/bin/env bash
set -euo pipefail
bin_dir=${JSON.stringify(minisignDir)}
if [[ -n "\${GITHUB_PATH:-}" ]]; then
  echo "$bin_dir" >> "$GITHUB_PATH"
else
  echo "$bin_dir"
fi
`,
    'utf8',
  );
  await chmod(bootstrapPath, 0o755);

  const signing = resolveSigningEnvForTests({
    repoRoot,
    scratchDir,
    baseEnv: {
      ...process.env,
      PATH: pathBinDir,
      GITHUB_PATH: githubPathFile,
    },
  });

  assert.deepEqual(signing.keyPathEntries, [minisignDir]);
  assert.match(signing.env.PATH ?? '', new RegExp(`^${minisignDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  await rm(root, { recursive: true, force: true });
});
