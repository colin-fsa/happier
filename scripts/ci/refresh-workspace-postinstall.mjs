import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { collectWorkspacePackageJsonPaths } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';
import { execYarn } from '../workspaces/execYarnCommand.mjs';

// Preserve install's explicit script opt-out, including untrusted-source jobs.
if (!process.argv.slice(2).includes('--ignore-scripts')) {
  const root = process.cwd();
  for (const path of await collectWorkspacePackageJsonPaths(root)) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.scripts?.postinstall) {
      execYarn(['workspace', manifest.name, 'run', 'postinstall'], { cwd: root, stdio: 'inherit' });
    }
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.scripts?.postinstall) {
    execYarn(['run', 'postinstall'], { cwd: root, stdio: 'inherit' });
  }
}
