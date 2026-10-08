import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  findUnmatchedSourcePaths,
  resolveWorkspaceSourceImpacts,
  resolveNotesOnlySourceCi,
} from './classify-source-ci-paths.mjs';

test('notes-only selection requires unchanged source with a successful full baseline and valid projections', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'happier-notes-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'ci@example.test');
  mkdirSync(join(root, 'apps/ui'), { recursive: true });
  writeFileSync(join(root, 'apps/ui/package.json'), JSON.stringify({ version: '0.2.16' }));
  const notes = '## Release 2026-10-08.1 - 2026-10-08\n\n<!-- happier-release-note-projections:v1\n' + JSON.stringify({ expo: { message: 'Approved update.' }, appStore: { whatsNew: 'Approved update.' }, playStore: { whatsNew: 'Approved update.' } }) + '\n-->\n\nApproved update.\n';
  writeFileSync(join(root, 'apps/ui/CHANGELOG.md'), notes);
  git('add', 'apps/ui/package.json', 'apps/ui/CHANGELOG.md');
  git('commit', '-m', 'baseline');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'apps/ui/CHANGELOG.md'), notes + '\nAnother correction.\n');
  git('add', 'apps/ui/CHANGELOG.md');
  git('commit', '-m', 'notes');
  const sourceSha = git('rev-parse', 'HEAD');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const selections = Object.fromEntries(['run_ui', 'run_server', 'run_cli', 'run_stack', 'run_ui_e2e', 'run_server_db_contract', 'run_release_contracts', 'run_installers_smoke', 'run_binary_smoke', 'run_cli_daemon_e2e', 'run_e2e_core', 'run_typecheck'].map((id) => [id, 'false']));
  const summary = { schemaVersion: 1, runId: '42', sourceSha: baseSha, failures: [], lanes: ['ci_plan', 'trusted_ref_guard', 'ui-unit', 'ui-integration', 'ui', 'shared-packages-unit', 'server', 'cli', 'stack', 'typecheck', 'e2e-core'].map((id) => ({ id, result: 'success', outputs: id === 'ci_plan' ? selections : {} })) };
  const run = { id: 42, path: '.github/workflows/tests.yml', head_sha: baseSha, head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } };
  // GitHub is the genuine external boundary; Git, projection and CI admission remain real.
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env node\n' + `const fs = require('node:fs'); const args = process.argv.slice(2);\nif (args[0] === 'api') console.log(JSON.stringify(args[1].includes('workflows') ? {workflow_runs:[${JSON.stringify(run)}]} : ${JSON.stringify(run)}));\nelse fs.writeFileSync(args[args.indexOf('--dir')+1]+'/ci-summary.json', ${JSON.stringify(JSON.stringify(summary))});\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const input = { repoRoot: root, repository: 'happier-dev/happier', sourceBranch: 'dev', baseSha, sourceSha };
  assert.deepEqual(await resolveNotesOnlySourceCi(input), { notesOnly: true, baseSha, baseRunId: '42' });
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./classify-source-ci-paths.mjs', import.meta.url)), '--notes-only'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: input.repository, CI_BASE_SHA: baseSha, CI_SOURCE_SHA: sourceSha, CI_SOURCE_BRANCH: 'dev' },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^notes_only=true\n/);
  assert.match(cli.stdout, new RegExp(`notes_base_sha=${baseSha}`));

  const missingLane = structuredClone(summary);
  missingLane.lanes = missingLane.lanes.filter((lane) => lane.id !== 'cli');
  const ghFixture = join(bin, 'gh');
  const workingFixture = (await import('node:fs')).readFileSync(ghFixture, 'utf8');
  writeFileSync(ghFixture, workingFixture.replace(JSON.stringify(JSON.stringify(summary)), JSON.stringify(JSON.stringify(missingLane))));
  assert.equal((await resolveNotesOnlySourceCi(input)).notesOnly, false);
  writeFileSync(ghFixture, workingFixture);

  writeFileSync(join(root, 'apps/ui/package.json'), JSON.stringify({ version: '0.2.17' }));
  git('add', 'apps/ui/package.json'); git('commit', '-m', 'version');
  assert.equal((await resolveNotesOnlySourceCi({ ...input, sourceSha: git('rev-parse', 'HEAD') })).notesOnly, false);
  writeFileSync(join(root, 'apps/ui/changelog.json'), '{}');
  git('add', 'apps/ui/changelog.json'); git('commit', '-m', 'generated runtime');
  assert.equal((await resolveNotesOnlySourceCi({ ...input, sourceSha: git('rev-parse', 'HEAD') })).notesOnly, false);

  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho \'{"workflow_runs":[]}\'\n');
  assert.equal((await resolveNotesOnlySourceCi(input)).notesOnly, false);
  writeFileSync(join(root, 'apps/ui/CHANGELOG.md'), notes.replace('Approved update.', ''));
  git('add', 'apps/ui/CHANGELOG.md'); git('commit', '-m', 'invalid notes');
  const invalidSha = git('rev-parse', 'HEAD');
  const versionSha = git('rev-parse', 'HEAD^');
  await assert.rejects(resolveNotesOnlySourceCi({ ...input, sourceSha: invalidSha, baseSha: versionSha }), /projection|message/);
});

test('unknown executable source fails closed while known source and documentation stay selective', () => {
  assert.deepEqual(findUnmatchedSourcePaths({
    changedPaths: [
      'apps/ui/sources/example.ts',
      'scripts/postinstall/shouldRunPostinstall.cjs',
      'docs/ci.md',
    ],
    classifiedPaths: ['apps/ui/sources/example.ts'],
    documentationPaths: ['docs/ci.md'],
  }), ['scripts/postinstall/shouldRunPostinstall.cjs']);

  assert.deepEqual(findUnmatchedSourcePaths({
    changedPaths: ['apps/ui/sources/example.ts', 'docs/ci.md'],
    classifiedPaths: ['apps/ui/sources/example.ts'],
    documentationPaths: ['docs/ci.md'],
  }), []);

  assert.deepEqual(findUnmatchedSourcePaths({
    changedPaths: ['README.md', 'docs/ci.md'],
    classifiedPaths: [],
    documentationPaths: ['README.md', 'docs/ci.md'],
  }), []);
});

test('workspace dependency closure selects only product consumers of changed packages', () => {
  const manifests = [
    { directory: 'packages/protocol', name: '@happier-dev/protocol', dependencies: [] },
    { directory: 'packages/ui-only', name: '@happier-dev/ui-only', dependencies: ['@happier-dev/protocol'] },
    { directory: 'packages/cli-only', name: '@happier-dev/cli-only', dependencies: [] },
    { directory: 'apps/ui', name: '@happier-dev/app', dependencies: ['@happier-dev/ui-only'] },
    { directory: 'apps/server', name: '@happier-dev/server', dependencies: ['@happier-dev/protocol'] },
    { directory: 'apps/cli', name: '@happier-dev/cli', dependencies: ['@happier-dev/cli-only'] },
    { directory: 'apps/stack', name: '@happier-dev/stack', dependencies: ['@happier-dev/cli-only'] },
  ];

  assert.deepEqual(resolveWorkspaceSourceImpacts({
    changedPaths: ['packages/ui-only/src/render.ts'],
    manifests,
  }), {
    ui: true,
    server: false,
    cli: false,
    stack: false,
    sharedPackages: true,
    unknownWorkspacePaths: [],
  });

  assert.deepEqual(resolveWorkspaceSourceImpacts({
    changedPaths: ['packages/protocol/src/message.ts'],
    manifests,
  }), {
    ui: true,
    server: true,
    cli: false,
    stack: false,
    sharedPackages: true,
    unknownWorkspacePaths: [],
  });
});

test('workspace dependency closure fails closed for a new unmapped package directory', () => {
  assert.deepEqual(resolveWorkspaceSourceImpacts({
    changedPaths: ['packages/new-runtime/src/index.ts'],
    manifests: [
      { directory: 'apps/ui', name: '@happier-dev/app', dependencies: [] },
      { directory: 'apps/server', name: '@happier-dev/server', dependencies: [] },
      { directory: 'apps/cli', name: '@happier-dev/cli', dependencies: [] },
      { directory: 'apps/stack', name: '@happier-dev/stack', dependencies: [] },
    ],
  }), {
    ui: false,
    server: false,
    cli: false,
    stack: false,
    sharedPackages: false,
    unknownWorkspacePaths: ['packages/new-runtime/src/index.ts'],
  });
});
