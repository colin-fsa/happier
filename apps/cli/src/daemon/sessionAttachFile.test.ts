import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { configuration as cleanupConfiguration } from '@/configuration';
import { logger as cleanupLogger } from '@/ui/logger';
import { createSessionAttachFile as createCleanupFixture } from './sessionAttachFile';

describe('createSessionAttachFile', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalAttachMaxAgeMs = process.env.HAPPIER_SESSION_ATTACH_FILE_MAX_AGE_MS;
  const originalPublicReleaseChannel = process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    if (originalAttachMaxAgeMs === undefined) {
      delete process.env.HAPPIER_SESSION_ATTACH_FILE_MAX_AGE_MS;
    } else {
      process.env.HAPPIER_SESSION_ATTACH_FILE_MAX_AGE_MS = originalAttachMaxAgeMs;
    }
    if (originalPublicReleaseChannel === undefined) {
      delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    } else {
      process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = originalPublicReleaseChannel;
    }
    vi.resetModules();
  });

  async function createHappyHomeFixture(): Promise<{ dir: string; baseDir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'happy-home-'));
    tempDirs.push(dir);
    process.env.HAPPIER_HOME_DIR = dir;
    return {
      dir,
      baseDir: resolve(join(dir, 'tmp', 'session-attach')),
    };
  }

  test('writes a 0600 attach file under HAPPIER_HOME_DIR and cleanup deletes it', async () => {
    const { baseDir } = await createHappyHomeFixture();

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');
    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: 'happy-session-1',
      payload: { v: 2, encryptionMode: 'e2ee', encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    expect(resolve(filePath).startsWith(baseDir + sep)).toBe(true);

    const raw = await readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({
      v: 2,
      encryptionMode: 'e2ee',
      encryptionKeyBase64: key,
      encryptionVariant: 'dataKey',
    });

    if (process.platform !== 'win32') {
      const dirStat = await stat(baseDir);
      expect(dirStat.mode & 0o777).toBe(0o700);
      const s = await stat(filePath);
      expect(s.mode & 0o077).toBe(0);
    }
    await cleanup();
    await cleanup();
    await expect(stat(filePath)).rejects.toBeTruthy();
  });

  test('reports an actual attach-file cleanup failure without deleting a replacement directory', async () => {
    const { dir } = await createHappyHomeFixture();
    const originalHome = cleanupConfiguration.happyHomeDir;
    Object.defineProperty(cleanupConfiguration, 'happyHomeDir', { value: dir });
    const signal = vi.spyOn(cleanupLogger, 'infoFile');
    const { filePath, cleanup } = await createCleanupFixture({
      happySessionId: 'cleanup-failure', payload: { v: 2, encryptionMode: 'plain' },
    });
    await unlink(filePath);
    await mkdir(filePath);
    try {
      await expect(cleanup()).rejects.toMatchObject({ syscall: 'unlink' });
      expect((await stat(filePath)).isDirectory()).toBe(true);
      expect(signal).toHaveBeenCalledWith('[daemon] Session attach-file cleanup incomplete (session_attach_cleanup_incomplete)');
    } finally {
      signal.mockRestore();
      Object.defineProperty(cleanupConfiguration, 'happyHomeDir', { value: originalHome });
    }
  });

  test('scopes session attach files by public release ring (dev lane)', async () => {
    const { baseDir } = await createHappyHomeFixture();
    process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = 'dev';

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(7), 'base64');
    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: 'happy-session-dev-1',
      payload: { v: 2, encryptionMode: 'e2ee', encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    const expectedBase = resolve(join(baseDir, '..', 'session-attach.dev'));
    expect(resolve(filePath).startsWith(expectedBase + sep)).toBe(true);
    await cleanup();
  });

  test('prevents path traversal in happySessionId (always stays within base dir)', async () => {
    const { dir, baseDir } = await createHappyHomeFixture();

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');

    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: '../evil',
      payload: { v: 2, encryptionMode: 'e2ee', encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    expect(resolve(filePath).startsWith(baseDir + sep)).toBe(true);
    expect(basename(filePath).startsWith('..')).toBe(false);

    await cleanup();
    await expect(stat(filePath)).rejects.toBeTruthy();

    // Ensure the base directory still exists (we didn't clobber parent dirs).
    await expect(stat(join(dir, 'tmp', 'session-attach'))).resolves.toBeTruthy();
  });

  test('prunes stale attach files in the base dir (best-effort)', async () => {
    const { dir, baseDir } = await createHappyHomeFixture();
    process.env.HAPPIER_SESSION_ATTACH_FILE_MAX_AGE_MS = '1';

    vi.resetModules();

    const { encodeBase64 } = await import('@/api/encryption');
    const { createSessionAttachFile } = await import('./sessionAttachFile');

    // Create a stale file under the base directory.
    const stalePath = join(baseDir, 'stale.json');
    await mkdir(baseDir, { recursive: true });
    await writeFile(stalePath, JSON.stringify({ v: 2, encryptionMode: 'plain' }), { mode: 0o600 });
    const old = Date.now() - 10_000;
    await utimes(stalePath, old / 1000, old / 1000);

    const key = encodeBase64(new Uint8Array(32).fill(5), 'base64');
    const { filePath, cleanup } = await createSessionAttachFile({
      happySessionId: 'happy-session-2',
      payload: { v: 2, encryptionMode: 'e2ee', encryptionKeyBase64: key, encryptionVariant: 'dataKey' },
    });

    await expect(stat(filePath)).resolves.toBeTruthy();
    await expect(stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await cleanup();
  });
});
