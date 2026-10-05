import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureNohoistPeerLinks } from './ensureNohoistPeerLinks.mjs';

function createWorkspace(t) {
    const repoRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nohoist-peer-links-'));
    t.after(() => fs.rmSync(repoRootDir, { recursive: true, force: true }));
    const expoAppDir = path.join(repoRootDir, 'apps', 'ui');
    fs.mkdirSync(path.join(repoRootDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(expoAppDir, 'node_modules'), { recursive: true });
    return { repoRootDir, expoAppDir };
}

test('repairs a restored dangling peer link to the current workspace dependency', (t) => {
    const opts = createWorkspace(t);
    const target = path.join(opts.expoAppDir, 'node_modules', 'react');
    const obsoleteTarget = path.join(opts.repoRootDir, 'obsolete-react');
    const link = path.join(opts.repoRootDir, 'node_modules', 'react');
    fs.mkdirSync(target);
    fs.mkdirSync(obsoleteTarget);
    fs.symlinkSync(obsoleteTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
    fs.rmdirSync(obsoleteTarget);

    ensureNohoistPeerLinks(opts);

    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
    ensureNohoistPeerLinks(opts);
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
});

test('preserves existing directories and valid links while creating missing peer links', (t) => {
    const opts = createWorkspace(t);
    const rootModules = path.join(opts.repoRootDir, 'node_modules');
    for (const name of ['react', 'react-dom', 'react-native']) {
        fs.mkdirSync(path.join(opts.expoAppDir, 'node_modules', name));
    }
    const existingReact = path.join(rootModules, 'react');
    fs.mkdirSync(existingReact);
    fs.writeFileSync(path.join(existingReact, 'retained.txt'), 'existing dependency');
    const otherReactDom = path.join(opts.repoRootDir, 'other-react-dom');
    fs.mkdirSync(otherReactDom);
    fs.symlinkSync(otherReactDom, path.join(rootModules, 'react-dom'), process.platform === 'win32' ? 'junction' : 'dir');

    ensureNohoistPeerLinks(opts);

    assert.equal(fs.readFileSync(path.join(existingReact, 'retained.txt'), 'utf8'), 'existing dependency');
    assert.equal(fs.realpathSync(path.join(rootModules, 'react-dom')), fs.realpathSync(otherReactDom));
    assert.equal(fs.realpathSync(path.join(rootModules, 'react-native')), fs.realpathSync(path.join(opts.expoAppDir, 'node_modules', 'react-native')));
});
