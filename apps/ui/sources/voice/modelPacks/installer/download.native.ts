import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { File as ExpoFile } from 'expo-file-system';
import { Platform } from 'react-native';

import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

import type { InstallerFs, Progress } from './types';
import { filePathParts } from './paths';
import { throwIfAborted } from './network';

// Model files are tens to hundreds of MB; whole-file reads exceed Android's per-app JS heap, so
// files are hashed through bounded reads.
const HASH_READ_CHUNK_BYTES = 1024 * 1024;

async function sha256FileHex(file: Pick<ExpoFile, 'open'>, signal: AbortSignal): Promise<string> {
  const hash = sha256.create();
  const handle = file.open();
  try {
    while (true) {
      throwIfAborted(signal);
      const chunk: Uint8Array = handle.readBytes(HASH_READ_CHUNK_BYTES);
      if (chunk.length === 0) break;
      hash.update(chunk);
      // `readBytes` is synchronous; yield between chunks so hashing does not block the JS thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    handle.close();
  }
  return bytesToHex(hash.digest());
}

async function downloadToFile(opts: {
  url: string;
  fileUri: string;
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  throwIfAborted(opts.signal);
  const { createDownloadResumable, FileSystemSessionType } = await import('expo-file-system/legacy');
  throwIfAborted(opts.signal);
  // Expo fetch queues native events without backpressure. Keep artifact bytes entirely native;
  // only numeric progress crosses into JS, followed by bounded disk reads for verification.
  const task = createDownloadResumable(opts.url, opts.fileUri, {
    sessionType: FileSystemSessionType.FOREGROUND,
  }, (progress) => opts.onProgress?.({
    loaded: progress.totalBytesWritten,
    total: progress.totalBytesExpectedToWrite,
  }));
  let releasePromise: Promise<void> | undefined;
  const release = () => releasePromise ??= (async () => {
    if (Platform.OS === 'android') {
      // Android's cancel alone retains the native task. Pause removes it; cancel also removes
      // the JS progress subscription when native setup failed before task registration.
      try {
        await task.pauseAsync();
      } finally {
        await task.cancelAsync();
      }
    } else {
      // iOS unregisters completed tasks itself, so pause would fail before unsubscribing.
      await task.cancelAsync();
    }
  })();
  const onAbort = () => {
    // The same promise is awaited below; attach a handler now to avoid an unhandled rejection.
    void release().catch(() => undefined);
  };
  const download = task.downloadAsync();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal.aborted) onAbort();
  let transferFailed = false;
  try {
    // A cancellation request is not terminal: native writes must settle before hashing/deleting.
    // Model files use native network timeouts; the configured deadline still owns manifest fetches.
    const result = await download;
    throwIfAborted(opts.signal);
    if (!result) throw new Error('model_pack_download_cancelled');
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`model_pack_download_failed:${result.status}`);
    }
  } catch (error) {
    transferFailed = true;
    throw error;
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    try {
      await release();
    } catch (error) {
      if (!transferFailed) throw error;
      // Preserve the causal transfer error, but keep failed cleanup visible by default.
      console.warn('[modelPacks] Failed to release native download', error);
    }
  }
}

async function downloadAndVerifyFile(opts: {
  fs: InstallerFs;
  rootDir: any;
  entry: ModelPackManifest['files'][number];
  signal: AbortSignal;
  onProgress?: (p: Progress) => void;
}): Promise<void> {
  const parts = filePathParts(opts.entry.path);
  const parentParts = parts.slice(0, -1);
  const filename = parts[parts.length - 1]!;

  let dir = opts.rootDir;
  for (const p of parentParts) {
    dir = new opts.fs.Directory(dir, p);
  }
  try {
    dir.create({ intermediates: true, idempotent: true });
  } catch {
    // ignore
  }

  const file = new opts.fs.File(dir, filename);
  if (file.exists) {
    try {
      const actual = await sha256FileHex(file, opts.signal);
      if (actual === opts.entry.sha256.toLowerCase()) return;
      file.delete();
    } catch (error) {
      // A cancelled verification does not invalidate an already downloaded file.
      if (opts.signal.aborted) throw error;
      try {
        file.delete();
      } catch {
        // ignore
      }
    }
  }

  try {
    await downloadToFile({
      url: opts.entry.url, fileUri: file.uri, signal: opts.signal, onProgress: opts.onProgress,
    });

    const actual = await sha256FileHex(file, opts.signal);
    if (actual !== opts.entry.sha256.toLowerCase()) {
      try {
        file.delete();
      } catch {
        // ignore
      }
      throw new Error('model_pack_sha256_mismatch');
    }
  } catch (error) {
    try {
      if (file.exists) file.delete();
    } catch {
      // ignore
    }
    throw error;
  }
}

export async function downloadManifestFiles(opts: {
  fs: InstallerFs;
  rootDir: any;
  manifest: ModelPackManifest;
  signal: AbortSignal;
  onProgress?: (p: { loaded: number; total: number; file?: string }) => void;
}): Promise<void> {
  const total = opts.manifest.files.reduce((acc, f) => acc + (Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0), 0);
  let loadedTotal = 0;

  for (const f of opts.manifest.files) {
    let loadedThisFile = 0;
    await downloadAndVerifyFile({
      fs: opts.fs,
      rootDir: opts.rootDir,
      entry: f,
      signal: opts.signal,
      onProgress: (p) => {
        const delta = Math.max(0, p.loaded - loadedThisFile);
        loadedThisFile = p.loaded;
        loadedTotal += delta;
        opts.onProgress?.({ loaded: loadedTotal, total, file: f.path });
      },
    });
  }
}
