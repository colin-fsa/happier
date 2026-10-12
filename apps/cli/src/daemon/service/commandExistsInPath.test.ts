import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { writeTextFile } from '@/testkit/fs/fileHelpers';
import { withTempDir } from '@/testkit/fs/tempDir';
import { commandExistsInPath } from './commandExistsInPath.js';

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }));
// Filesystem metadata is the OS boundary; command resolution remains real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: statSyncMock };
});

describe('commandExistsInPath', () => {
  beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    statSyncMock.mockReset();
    statSyncMock.mockImplementation(fs.statSync);
  });

  it('does not mistake an unreadable command search for a missing command', () => {
    const error = Object.assign(new Error('cannot inspect command'), { code: 'EACCES' });
    statSyncMock.mockImplementation(() => { throw error; });
    expect(() => commandExistsInPath({ cmd: 'systemctl', envPath: '/unreadable', platform: 'linux' })).toThrow(error);
  });
  it('detects unix commands by exact filename', async () => {
    await withTempDir('happier-cli-cmd-', async (dir) => {
      await writeTextFile(join(dir, 'hello'), '#!/bin/sh\necho hi\n');
      expect(commandExistsInPath({ cmd: 'hello', envPath: dir, platform: 'linux' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'missing', envPath: dir, platform: 'linux' })).toBe(false);
    });
  });

  it('detects windows commands via PATHEXT fallbacks', async () => {
    await withTempDir('happier-cli-cmdwin-', async (dir) => {
      await writeTextFile(join(dir, 'schtasks.exe'), 'binary');
      expect(commandExistsInPath({ cmd: 'schtasks', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'schtasks.exe', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(true);
      expect(commandExistsInPath({ cmd: 'missing', envPath: dir, platform: 'win32', pathext: '.EXE;.CMD' })).toBe(false);
    });
  });
});
