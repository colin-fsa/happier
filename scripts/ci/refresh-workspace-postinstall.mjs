import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import { execYarn } from '../workspaces/execYarnCommand.mjs';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

// Yarn runs workspace lifecycle scripts after their workspace dependencies;
// a cache hit must keep that order because postinstalls compile against the
// outputs of the workspaces they depend on.
function orderByWorkspaceDependencies(manifests) {
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const ordered = [];
  const state = new Map();
  const visit = (manifest) => {
    if (state.get(manifest.name)) return;
    state.set(manifest.name, 'visiting');
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependencyName of Object.keys(manifest[field] ?? {})) {
        const dependency = byName.get(dependencyName);
        if (dependency && dependency !== manifest) visit(dependency);
      }
    }
    ordered.push(manifest);
  };
  for (const manifest of manifests) visit(manifest);
  return ordered;
}

// Preserve install's explicit script opt-out, including untrusted-source jobs.
if (!process.argv.slice(2).includes('--ignore-scripts')) {
  const root = process.cwd();
  const manifests = [];
  for (const path of await collectWorkspacePackageJsonPaths(root)) {
    manifests.push(JSON.parse(await readFile(path, 'utf8')));
  }
  for (const manifest of orderByWorkspaceDependencies(manifests)) {
    if (manifest.scripts?.postinstall) {
      execYarn(['workspace', manifest.name, 'run', 'postinstall'], { cwd: root, stdio: 'inherit' });
    }
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.scripts?.postinstall) {
    execYarn(['run', 'postinstall'], { cwd: root, stdio: 'inherit' });
  }
}
