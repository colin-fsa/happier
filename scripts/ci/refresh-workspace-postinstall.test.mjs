import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const command = new URL('./refresh-workspace-postinstall.mjs', import.meta.url);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci02-postinstall-'));
  const make = (dir, name, postinstall) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, scripts: postinstall ? { postinstall: 'node setup.cjs' } : {}, ...(dir === '.' ? { workspaces: ['apps/*', 'packages/*'] } : {}) }));
    writeFileSync(join(root, dir, 'setup.cjs'), "require('node:fs').writeFileSync('setup-complete', 'current'); if (process.env.FAIL_WORKSPACE === require('./package.json').name) process.exit(7);");
  };
  make('.', 'root', true);
  make('apps/example', 'app', true);
  make('packages/library', 'library', true);
  make('packages/ordinary', 'ordinary', false);
  // Yarn is the external process boundary. This shim executes each fixture's
  // real postinstall in its workspace instead of installing dependencies.
  const yarn = join(root, 'yarn.cjs');
  writeFileSync(yarn, `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    const args = process.argv.slice(2); let cwd = process.cwd();
    if (args[0] === 'workspace') {
      const dirs = ['apps/example','packages/library','packages/ordinary'];
      cwd = dirs.map(d=>path.join(cwd,d)).find(d=>JSON.parse(fs.readFileSync(path.join(d,'package.json'))).name===args[1]);
    }
    const result = cp.spawnSync(process.execPath, ['setup.cjs'], { cwd, stdio:'inherit' });
    process.exit(result.status ?? 1);
  `);
  return { root, run: (...args) => spawnSync(process.execPath, [command.pathname, ...args], { cwd: root, env: { ...process.env, npm_execpath: yarn }, encoding: 'utf8' }) };
}

test('cache-hit setup refreshes every declared workspace owner and the root', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    for (const dir of ['.', 'apps/example', 'packages/library']) assert.equal(existsSync(join(f.root, dir, 'setup-complete')), true, dir);
    assert.equal(existsSync(join(f.root, 'packages/ordinary/setup-complete')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('cache-hit setup refreshes a workspace dependency before its dependents', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci02-postinstall-order-'));
  const make = (dir, name, extra = {}) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, scripts: { postinstall: 'node setup.cjs' }, ...extra }));
  };
  make('.', 'root', { workspaces: ['packages/*'] });
  // `agents` sorts before `protocol` but builds against protocol's setup output.
  make('packages/agents', 'agents', { dependencies: { protocol: '0.0.0' } });
  make('packages/protocol', 'protocol');
  writeFileSync(join(root, 'setup.cjs'), '');
  writeFileSync(join(root, 'packages/protocol/setup.cjs'), "require('node:fs').writeFileSync('setup-complete', 'built');");
  writeFileSync(join(root, 'packages/agents/setup.cjs'), "if (!require('node:fs').existsSync('../protocol/setup-complete')) process.exit(3); require('node:fs').writeFileSync('setup-complete', 'built');");
  const yarn = join(root, 'yarn.cjs');
  writeFileSync(yarn, `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    const args = process.argv.slice(2); let cwd = process.cwd();
    if (args[0] === 'workspace') cwd = path.join(cwd, 'packages', args[1]);
    process.exit(cp.spawnSync(process.execPath, ['setup.cjs'], { cwd, stdio: 'inherit' }).status ?? 1);
  `);
  try {
    const result = spawnSync(process.execPath, [command.pathname], { cwd: root, env: { ...process.env, npm_execpath: yarn }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'packages/agents/setup-complete')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ignore-scripts cache verification does not execute workspace code', () => {
  const f = fixture();
  try {
    const result = f.run('--ignore-scripts');
    assert.equal(result.status, 0, result.stderr);
    for (const dir of ['.', 'apps/example', 'packages/library']) assert.equal(existsSync(join(f.root, dir, 'setup-complete')), false, dir);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
