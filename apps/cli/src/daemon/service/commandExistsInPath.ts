import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

function normalizePathList(envPath: string | undefined): string[] {
  return String(envPath ?? '')
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function commandExistsInPath(params: Readonly<{
  cmd: string;
  envPath: string | undefined;
  platform: NodeJS.Platform;
  pathext?: string | undefined;
}>): boolean {
  const cmd = String(params.cmd ?? '').trim();
  if (!cmd) return false;

  if (params.platform === 'win32') {
    return (
      resolveWindowsCommandOnPath(cmd, {
        PATH: params.envPath,
        PATHEXT: params.pathext,
      }) !== null
    );
  }

  const pathDirs = normalizePathList(params.envPath);
  if (pathDirs.length === 0) return false;

  for (const dir of pathDirs) {
    const full = join(dir, cmd);
    try {
      statSync(full);
      return true;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        continue;
      }
      throw error;
    }
  }

  return false;
}
