import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChangedPaths, deriveVersionedComponentChanges } from '../pipeline/release/component-registry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

for (const scenario of [
  { targets: 'ui', force: false, cli: false, server: false, ui: true, relay: false, devBox: false },
  { targets: 'cli', force: false, cli: true, server: false, ui: false, relay: false, devBox: true },
  { targets: 'server', force: false, cli: false, server: true, ui: false, relay: true, devBox: false },
  { targets: 'server_runner', force: false, cli: false, server: true, ui: false, relay: true, devBox: false },
  { targets: 'ui', force: true, cli: false, server: false, ui: true, relay: false, devBox: false },
]) {
  test(`materialized ${scenario.targets} release bounds artifact work to its selected products (force=${scenario.force})`, () => {
    const output = execFileSync(process.execPath, [
      resolve(repoRoot, 'scripts/pipeline/release/resolve-bump-plan.mjs'),
      '--environment', 'preview', '--bump-preset', 'none', '--require-materialized',
      '--deploy-targets', scenario.targets, ...(scenario.force ? ['--force-deploy', 'true'] : []),
      '--changed-ui', 'true', '--changed-cli', 'true', '--changed-stack', 'true',
      '--changed-server', 'true', '--changed-website', 'true', '--changed-shared', 'true',
    ], { cwd: repoRoot, encoding: 'utf8' });
    const plan = JSON.parse(output);
    assert.equal(plan.publish_cli_binaries, scenario.cli);
    assert.equal(plan.publish_server_runtime, scenario.server);
    assert.equal(plan.publish_ui_web, scenario.ui);
    assert.equal(plan.publish_docker_relay, scenario.relay);
    assert.equal(plan.publish_docker_dev_box, scenario.devBox);
    for (const component of ['app', 'cli', 'stack', 'server', 'website']) {
      assert.equal(plan[`bump_${component}`], 'none');
    }
    assert.equal(plan.should_bump, false);
  });
}

test('unchanged server deployment retains its artifacts until a selected force-deploy', () => {
  const args = [
    resolve(repoRoot, 'scripts/pipeline/release/resolve-bump-plan.mjs'),
    '--environment', 'preview', '--bump-preset', 'none', '--require-materialized',
    '--deploy-targets', 'server', '--changed-ui', 'true', '--changed-cli', 'true',
    '--changed-stack', 'true', '--changed-server', 'false', '--changed-website', 'false',
    '--changed-shared', 'false', '--versioned-server-changed', 'false',
  ];
  for (const force of [false, true]) {
    const output = execFileSync(process.execPath, [...args, '--force-deploy', String(force)], { cwd: repoRoot, encoding: 'utf8' });
    const plan = JSON.parse(output);
    assert.equal(plan.publish_server_runtime, force);
    assert.equal(plan.publish_docker_relay, force);
    assert.equal(plan.publish_cli_binaries, false);
    assert.equal(plan.publish_ui_web, false);
  }
});

test('shared protocol changes inform the component map without expanding an explicit UI scope', () => {
  const changed = deriveVersionedComponentChanges(classifyChangedPaths(['packages/protocol/src/index.ts']));
  assert.deepEqual({ ...changed }, { app: true, cli: true, stack: true, server: true });
  const output = execFileSync(process.execPath, [
    resolve(repoRoot, 'scripts/pipeline/release/resolve-bump-plan.mjs'),
    '--environment', 'preview', '--bump-preset', 'none', '--require-materialized',
    '--deploy-targets', 'ui', '--changed-ui', String(changed.app),
    '--changed-cli', String(changed.cli), '--changed-stack', String(changed.stack),
    '--changed-server', String(changed.server), '--changed-website', 'false', '--changed-shared', 'true',
  ], { cwd: repoRoot, encoding: 'utf8' });
  const plan = JSON.parse(output);
  assert.equal(plan.publish_ui_web, true);
  assert.equal(plan.publish_cli, false);
  assert.equal(plan.publish_stack, false);
  assert.equal(plan.publish_server, false);
  assert.equal(plan.publish_cli_binaries, false);
  assert.equal(plan.publish_server_runtime, false);
  assert.equal(plan.publish_docker_relay, false);
  assert.equal(plan.publish_docker_dev_box, false);
});

test('resolve-bump-plan computes bump + publish flags from changed components and deploy_targets', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'none',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,server,cli,stack',
      '--changed-ui',
      'true',
      '--changed-cli',
      'false',
      '--changed-stack',
      'true',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    publish_cli: true,
    publish_stack: true,
    publish_server: false,
    publish_cli_binaries: true,
    publish_server_runtime: false,
    publish_ui_web: true,
    publish_docker_relay: false,
    publish_docker_dev_box: true,
    bump_app: 'patch',
    bump_cli: 'none',
    bump_stack: 'patch',
    bump_server: 'none',
    bump_website: 'none',
    should_bump: true,
  });
});

test('resolve-bump-plan only publishes server runner when deploy_targets includes server_runner', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'server',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'true',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.publish_server, false);

  const out2 = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'server_runner',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'true',
      '--changed-website',
      'false',
      '--changed-shared',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const parsed2 = JSON.parse(out2);
  assert.equal(parsed2.publish_server, true);
});

test('resolve-bump-plan honors per-component versioned change inputs over global shared fanout', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment',
      'preview',
      '--bump-preset',
      'patch',
      '--bump-app-override',
      'preset',
      '--bump-cli-override',
      'preset',
      '--bump-stack-override',
      'preset',
      '--deploy-targets',
      'ui,cli,stack,server_runner',
      '--changed-ui',
      'false',
      '--changed-cli',
      'false',
      '--changed-stack',
      'false',
      '--changed-server',
      'false',
      '--changed-website',
      'false',
      '--changed-shared',
      'true',
      '--versioned-app-changed',
      'false',
      '--versioned-cli-changed',
      'true',
      '--versioned-stack-changed',
      'false',
      '--versioned-server-changed',
      'false',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, {
    publish_cli: true,
    publish_stack: true,
    publish_server: true,
    publish_cli_binaries: true,
    publish_server_runtime: true,
    publish_ui_web: true,
    publish_docker_relay: true,
    publish_docker_dev_box: true,
    bump_app: 'none',
    bump_cli: 'patch',
    bump_stack: 'none',
    bump_server: 'none',
    bump_website: 'none',
    should_bump: true,
  });
});

test('resolve-bump-plan rejects an automatic bump when called by the final release admission path', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment', 'preview',
      '--bump-preset', 'patch',
      '--changed-ui', 'true',
      '--changed-cli', 'false',
      '--changed-stack', 'false',
      '--changed-server', 'false',
      '--changed-website', 'false',
      '--changed-shared', 'false',
      '--require-materialized',
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Materialize and commit changelog and version updates, then rerun with --bump none\./);
});

test('resolve-bump-plan admits an exact verified resume version after production branch promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-bump-plan-git-'));
  try {
    const packageJson = readFileSync(resolve(repoRoot, 'apps', 'cli', 'package.json'), 'utf8');
    const packageVersion = JSON.parse(packageJson).version;
    const gitStub = join(root, 'git');
    writeFileSync(
      gitStub,
      '#!/usr/bin/env node\n' +
        'if (process.argv[2] !== "show" || process.argv[3] !== "origin/main:apps/cli/package.json") process.exit(2);\n' +
        'process.stdout.write(process.env.HAPPIER_TEST_MAIN_CLI_PACKAGE_JSON || "");\n',
      { mode: 0o700 },
    );
    const fixtureEnv = {
      ...process.env,
      PATH: `${root}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      HAPPIER_TEST_MAIN_CLI_PACKAGE_JSON: packageJson,
    };
    const commonArgs = [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'resolve-bump-plan.mjs'),
      '--environment', 'production',
      '--bump-preset', 'none',
      '--deploy-targets', 'cli',
      '--changed-ui', 'false',
      '--changed-cli', 'false',
      '--changed-stack', 'false',
      '--changed-server', 'false',
      '--changed-website', 'false',
      '--changed-shared', 'false',
      '--require-materialized',
    ];

    const withoutResume = spawnSync(process.execPath, commonArgs, {
      cwd: repoRoot,
      env: fixtureEnv,
      encoding: 'utf8',
    });
    assert.equal(withoutResume.status, 1);
    assert.match(withoutResume.stderr, /Refusing production deploy_targets includes cli without a version change/);

    const wrongResume = spawnSync(process.execPath, [...commonArgs, '--resume-cli-version', '0.0.0-wrong'], {
      cwd: repoRoot,
      env: fixtureEnv,
      encoding: 'utf8',
    });
    assert.equal(wrongResume.status, 1);

    const withResume = spawnSync(process.execPath, [...commonArgs, '--resume-cli-version', packageVersion], {
      cwd: repoRoot,
      env: fixtureEnv,
      encoding: 'utf8',
    });
    assert.equal(withResume.status, 0, withResume.stderr);
    assert.equal(JSON.parse(withResume.stdout).publish_cli, true);
    assert.equal(JSON.parse(withResume.stdout).bump_cli, 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
