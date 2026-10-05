import { chmod, readFile, stat, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Instrument only the external write boundary; all owned filesystem cleanup stays real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

import { createHerdrLaunchSpec } from './launchSpec';

describe('Herdr managed launch', () => {
  it.skipIf(process.platform === 'win32')('retains non-creation and incomplete cleanup evidence after a partial handoff write', async () => {
    let specPath = '';
    const originalWrite = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile;
    // Filesystem writes can fail after producing bytes; preserve real owned filesystem IO.
    const write = vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      specPath = String(args[0]);
      await originalWrite(...args);
      await chmod(dirname(specPath), 0o500);
      throw Object.assign(new Error('Partial filesystem write failed'), { code: 'EIO' });
    });
    try {
      await expect(createHerdrLaunchSpec({
        workingDirectory: tmpdir(), spawnArgv: ['/managed/happier'], spawnEnv: {},
      })).rejects.toMatchObject({
        launchDisposition: 'not_started', cleanupIncomplete: true,
        errors: [expect.objectContaining({ code: 'EIO' }), expect.objectContaining({ code: 'EACCES' })],
      });
      await expect(readFile(specPath, 'utf8')).resolves.toContain('/managed/happier');
    } finally {
      write.mockImplementation(originalWrite);
      if (specPath) {
        await chmod(dirname(specPath), 0o700);
        await unlink(specPath);
        await rmdir(dirname(specPath));
      }
    }
  });
  it.skipIf(process.platform === 'win32')('reports failure to remove an unread launch handoff instead of silently leaving secrets behind', async () => {
    const launch = await createHerdrLaunchSpec({
      workingDirectory: '/tmp', spawnArgv: ['/managed/happier'], spawnEnv: { TEST_SECRET: 'secret' },
    });
    try {
      await chmod(dirname(launch.specPath), 0o500);
      await expect(launch.discard()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(dirname(launch.specPath), 0o700);
      await launch.discard();
    }
    await expect(launch.discard()).resolves.toBeUndefined();
  });

  it('reuses the isolated terminal launch runner so Herdr native hooks cannot override Happier resume', async () => {
    const launch = await createHerdrLaunchSpec({
      workingDirectory: '/tmp',
      spawnArgv: ['/managed/claude', '--model', 'sonnet'],
      spawnEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'test-key', HERDR_ENV: '1', REMOVE_ME: 'secret' },
      unsetEnvKeys: ['REMOVE_ME'],
    });
    try {
      expect(launch.argv[1]).toContain('terminal_launch_spec_runner.cjs');
      const spec = JSON.parse(await readFile(launch.specPath, 'utf8')) as Record<string, unknown>;
      expect(spec).toMatchObject({
        command: '/managed/claude', args: ['--model', 'sonnet'], cwd: '/tmp',
        env: { PATH: '/bin', ANTHROPIC_API_KEY: 'test-key' },
        envPassthroughKeys: expect.arrayContaining([
          'HERDR_ENV',
          'HERDR_SOCKET_PATH',
          'HERDR_PANE_ID',
        ]),
      });
      expect(spec.env).not.toHaveProperty('HERDR_ENV');
      expect(spec.env).not.toHaveProperty('REMOVE_ME');
      expect((await stat(launch.specPath)).mode & 0o777).toBe(0o600);
    } finally {
      await launch.discard();
    }
  });
});
