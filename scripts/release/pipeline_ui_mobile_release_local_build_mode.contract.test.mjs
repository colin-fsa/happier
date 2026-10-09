import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('ui-mobile-release supports local EAS builds (delegates --build-mode local)', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'preview',
      '--action',
      'native',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--native-build-mode',
      'local',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, EXPO_TOKEN: 'test-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release:/);
  assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.match(out, /--build-mode"?\s+"?local\b/);
  assert.match(out, /--artifact-out\b/);
  assert.match(out, /\s--local\b/);
});

test('ui-mobile-release can delegate local Android builds to Dagger runtime', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'preview',
      '--action',
      'native',
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--native-build-mode',
      'local',
      '--native-local-runtime',
      'dagger',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, EXPO_TOKEN: 'test-token' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /--local-runtime"?\s+"?dagger\b/);
});

test('ui-mobile-release native_submit dry-run does not require local build artifacts to exist yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ui-mobile-release-dry-run-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Keep commandExists() deterministic by preventing bash from sourcing developer profiles.
  writeExecutable(path.join(binDir, 'bash'), ['#!/usr/bin/env sh', 'exec /bin/bash --noprofile --norc "$@"', ''].join('\n'));

  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'ui-mobile-release',
      '--environment',
      'preview',
      '--action',
      'native_submit',
      '--platform',
      'all',
      '--profile',
      'preview',
      '--native-build-mode',
      'local',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        EXPO_TOKEN: 'test-token',
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] ui-mobile release:/);
  assert.match(out, /scripts\/pipeline\/expo\/native-build\.mjs/);
  assert.match(out, /scripts\/pipeline\/expo\/submit\.mjs/);
  assert.match(out, /--path\b/);
});
