import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions, DownloadPauseState, DownloadProgressData, FileSystemDownloadResult } from 'expo-file-system/legacy';

import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';

type NativeTask = {
  downloadAsync(): Promise<FileSystemDownloadResult | undefined>;
  pauseAsync(): Promise<DownloadPauseState>;
  cancelAsync(): Promise<void>;
};

const nativeBoundary = vi.hoisted(() => ({
  platform: { OS: 'android' as 'android' | 'ios' },
  createDownloadResumable: vi.fn<(
    url: string, uri: string, options: DownloadOptions | undefined,
    onProgress?: (progress: DownloadProgressData) => void,
  ) => NativeTask>(),
}));

// The native network/filesystem modules are unavailable in the Node test process.
vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: nativeBoundary.createDownloadResumable,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' }, {
    Platform: { get OS() { return nativeBoundary.platform.OS; } },
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createHarness(options: { status?: number; pending?: boolean; failure?: Error; setupFailure?: Error } = {}) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const files = new Map<string, Uint8Array>();
  const fileUri = 'file:///docs/happier/voice/modelPacks/example/model.bin';
  const metaUri = 'file:///docs/happier/voice/modelPacks/example/pack.json';
  const written = deferred<void>();
  const terminal = deferred<FileSystemDownloadResult | undefined>();
  const lifecycle = { subscribed: false, retainedNativeTask: false, stopRequested: false };
  const requestedUrls: string[] = [];
  const nativeUrls: string[] = [];
  const nativeOptions: DownloadOptions[] = [];
  const status = options.status ?? 200;
  const nativeResult = { uri: fileUri, status, headers: {}, mimeType: null };
  const cleanupError = new Error('native_task_not_found');

  function uri(parts: Array<string | { uri: string }>) {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  }
  class Directory {
    uri: string;
    exists = true;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
    create() {}
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
    get exists() { return files.has(this.uri); }
    create() { if (!this.exists) files.set(this.uri, new Uint8Array()); }
    delete() { files.delete(this.uri); }
    write(value: string) { files.set(this.uri, new TextEncoder().encode(value)); }
    async text() { return new TextDecoder().decode(files.get(this.uri)); }
    open() {
      let offset = 0;
      const fileUri = this.uri;
      return {
        readBytes(length: number) {
          if (length > 4 * 1024 * 1024) throw new Error('whole_file_read');
          const chunk = (files.get(fileUri) ?? new Uint8Array()).slice(offset, offset + length);
          offset += chunk.length;
          return chunk;
        },
        close() {},
      };
    }
  }

  nativeBoundary.createDownloadResumable.mockImplementation((url, destination, optionsForTask, onProgress) => ({
    async downloadAsync() {
      nativeUrls.push(url);
      nativeOptions.push(optionsForTask ?? {});
      lifecycle.subscribed = true;
      if (options.setupFailure) throw options.setupFailure;
      lifecycle.retainedNativeTask = true;
      files.set(destination, bytes.slice(0, options.pending || options.failure ? 2 : bytes.length));
      written.resolve();
      onProgress?.({ totalBytesWritten: 2, totalBytesExpectedToWrite: bytes.length });
      if (options.pending) {
        const result = await terminal.promise;
        if (nativeBoundary.platform.OS === 'ios') lifecycle.retainedNativeTask = false;
        return result;
      }
      if (options.failure) {
        if (nativeBoundary.platform.OS === 'ios') lifecycle.retainedNativeTask = false;
        throw options.failure;
      }
      onProgress?.({ totalBytesWritten: bytes.length, totalBytesExpectedToWrite: bytes.length });
      if (nativeBoundary.platform.OS === 'ios') lifecycle.retainedNativeTask = false;
      return { ...nativeResult, uri: destination };
    },
    async pauseAsync() {
      // SDK 54 iOS unregisters completed tasks; its pause method then rejects before removing the JS subscription.
      if (!lifecycle.retainedNativeTask) throw cleanupError;
      lifecycle.stopRequested = true;
      lifecycle.retainedNativeTask = false;
      lifecycle.subscribed = false;
      return { url, fileUri: destination, options: optionsForTask ?? {}, resumeData: '2' };
    },
    async cancelAsync() {
      lifecycle.stopRequested = true;
      lifecycle.subscribed = false;
      // SDK 54 Android cancellation leaves the native UUID registered; pause is its release boundary.
    },
  }));

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('manifest.json')) return Response.json({
      packId: 'example', kind: 'stt_sherpa', model: 'zipformer', version: 'v1',
      files: [{ path: 'model.bin', url: 'https://example.com/model.bin', sha256, sizeBytes: bytes.length }],
    });
    throw new Error('artifact_fetch_crossed_js_boundary');
  };

  const install = (signal: AbortSignal, onProgress?: (progress: { loaded: number; total: number }) => void) => ensureModelPackInstalled({
    packId: 'example', mode: 'download_if_missing', manifestUrl: 'https://example.com/manifest.json',
    timeoutMs: 120_000, signal, onProgress,
  }, { fs: { Directory, File, Paths: { document: 'file:///docs/' } }, fetch: fetchImpl });

  return { bytes, files, fileUri, metaUri, written, terminal, lifecycle, requestedUrls, nativeUrls, nativeOptions, cleanupError, install };
}

describe('native model pack file downloads', () => {
  beforeEach(() => {
    nativeBoundary.createDownloadResumable.mockReset();
    nativeBoundary.platform.OS = 'android';
  });

  it.each(['android', 'ios'] as const)('downloads files outside JS and releases native resources on %s', async (platform) => {
    nativeBoundary.platform.OS = platform;
    const harness = await createHarness();
    const progress: Array<{ loaded: number; total: number }> = [];
    await harness.install(new AbortController().signal, (value) => progress.push({ loaded: value.loaded, total: value.total }));

    expect(harness.requestedUrls).toHaveLength(1);
    expect(harness.requestedUrls[0]).toContain('manifest.json');
    expect(harness.nativeUrls).toEqual(['https://example.com/model.bin']);
    if (platform === 'ios') expect(harness.nativeOptions[0]?.sessionType).toBe(1);
    expect(harness.files.get(harness.fileUri)).toEqual(harness.bytes);
    expect(harness.files.has(harness.metaUri)).toBe(true);
    expect(progress).toEqual([{ loaded: 2, total: 4 }, { loaded: 4, total: 4 }]);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });

  it('rejects a non-success HTTP result and removes the native-downloaded file', async () => {
    const harness = await createHarness({ status: 404 });
    await expect(harness.install(new AbortController().signal)).rejects.toThrow('model_pack_download_failed:404');
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });

  it('removes partial output and releases native resources after a transport failure', async () => {
    const harness = await createHarness({ failure: new Error('native_transport_failed') });
    await expect(harness.install(new AbortController().signal)).rejects.toThrow('native_transport_failed');
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });

  it('preserves native setup failure while reporting cleanup failure and unsubscribing', async () => {
    const originalError = new Error('native_start_failed');
    const harness = await createHarness({ setupFailure: originalError });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(harness.install(new AbortController().signal)).rejects.toBe(originalError);
      expect(warning.mock.calls.flat()).toContain(harness.cleanupError);
      expect(harness.files.has(harness.metaUri)).toBe(false);
      expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['android', 'ios'] as const)('waits for native writing to stop before cancellation cleanup on %s', async (platform) => {
    nativeBoundary.platform.OS = platform;
    const harness = await createHarness({ pending: true });
    const controller = new AbortController();
    let settled = false;
    const outcome = harness.install(controller.signal).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      const started = await Promise.race([
        harness.written.promise.then(() => true),
        outcome.then(() => false),
      ]);
      expect(started).toBe(true);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(harness.files.has(harness.fileUri)).toBe(true);
      expect(harness.lifecycle.stopRequested).toBe(true);
    } finally {
      controller.abort();
      harness.terminal.resolve(undefined);
      await outcome;
    }
    expect(await outcome).toBeInstanceOf(Error);
    expect(harness.files.has(harness.fileUri)).toBe(false);
    expect(harness.files.has(harness.metaUri)).toBe(false);
    expect(harness.lifecycle).toMatchObject({ subscribed: false, retainedNativeTask: false });
  });
});
