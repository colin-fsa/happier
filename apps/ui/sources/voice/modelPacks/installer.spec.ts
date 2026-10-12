import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadResumable, DownloadOptions, DownloadProgressData } from 'expo-file-system/legacy';

import { ensureModelPackInstalled, getModelPackInstallSummary, removeModelPack } from '@/voice/modelPacks/installer.native';
import type { ModelPackManifest } from '@/voice/modelPacks/manifest';

const nativeDownload = vi.hoisted(() => vi.fn<(
  url: string, uri: string, options?: DownloadOptions, onProgress?: (progress: DownloadProgressData) => void,
) => Pick<DownloadResumable, 'downloadAsync' | 'pauseAsync' | 'cancelAsync'>>());
// Artifact network and disk IO are native system boundaries, unavailable in the Node test process.
vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: nativeDownload,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'android' });
});

const PACK_URI = 'file:///docs/happier/voice/modelPacks/example';
const MAX_BOUNDED_READ_BYTES = 4 * 1024 * 1024;

function createFs(files = new Map<string, Uint8Array>(), options: {
  onRead?: () => void;
  openHandles?: Set<object>;
} = {}) {
  const directories = new Set<string>();
  function joinUri(parts: Array<string | { uri: string }>) {
    return parts.map((part) => (typeof part === 'string' ? part : part.uri).replace(/\/$/, '')).join('/');
  }
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = joinUri(parts); }
    get exists() { return directories.has(this.uri); }
    create() { directories.add(this.uri); }
    delete() {
      directories.delete(this.uri);
      for (const key of files.keys()) if (key.startsWith(`${this.uri}/`)) files.delete(key);
    }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = joinUri(parts); }
    get exists() { return files.has(this.uri); }
    create() { if (!this.exists) files.set(this.uri, new Uint8Array()); }
    delete() {
      if (options.openHandles?.size) throw new Error('file_handle_still_open');
      files.delete(this.uri);
    }
    write(value: string | Uint8Array) {
      files.set(this.uri, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
    }
    async text() { return new TextDecoder().decode(files.get(this.uri)); }
    // Whole-file reads must stay unavailable: these fixtures also protect the Android heap contract.
    async bytes(): Promise<Uint8Array> { throw new Error('whole_file_read_exceeds_js_heap'); }
    open() {
      let offset = 0;
      const data = files.get(this.uri) ?? new Uint8Array();
      const handle = {};
      options.openHandles?.add(handle);
      return {
        readBytes(length: number) {
          if (length > MAX_BOUNDED_READ_BYTES) throw new Error('read_exceeds_js_heap_budget');
          const chunk = data.slice(offset, offset + length);
          offset += chunk.length;
          options.onRead?.();
          return chunk;
        },
        close() { options.openHandles?.delete(handle); },
      };
    }
  }
  return { Directory, File, Paths: { document: 'file:///docs/' }, files };
}

function useNativeDownloads(fs: ReturnType<typeof createFs>, data: (url: string) => Uint8Array, requested: string[] = []) {
  nativeDownload.mockImplementation((url, destination, options) => ({
    async downloadAsync() {
      requested.push(url);
      fs.files.set(destination, new Uint8Array(data(url)));
      return { uri: destination, status: 200, headers: {}, mimeType: null };
    },
    async pauseAsync() { return { url, fileUri: destination, options: options ?? {}, resumeData: '0' }; },
    async cancelAsync() {},
  }));
}

function fetchManifest(manifest: ModelPackManifest): typeof fetch {
  return async (input) => {
    if (!String(input).includes('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
    return Response.json(manifest);
  };
}

function manifest(files: ModelPackManifest['files'], version = 'v1'): ModelPackManifest {
  return { packId: 'example', kind: 'tts_sherpa', model: 'kokoro', version, files };
}

async function sha256Hex(bytes: Uint8Array) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

function multiChunkBytes(seed: number) {
  const bytes = new Uint8Array(MAX_BOUNDED_READ_BYTES * 2 + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

const installOptions = {
  packId: 'example', mode: 'download_if_missing' as const, manifestUrl: 'https://example.com/manifest.json', timeoutMs: 120_000,
};

describe('modelPacks installer (native)', () => {
  beforeEach(() => { nativeDownload.mockReset(); });

  it('rewrites GitHub release file URLs using publisher-authored asset names', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await sha256Hex(bytes);
    const fs = createFs();
    const requested: string[] = [];
    useNativeDownloads(fs, () => bytes, requested);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__model.onnx?v=1', sha256, sizeBytes: bytes.length },
      // GitHub sanitizes ! into ., so the pack-relative path cannot reproduce the uploaded asset name.
      { path: 'espeak-ng-data/voices/!v/Alex', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__espeak-ng-data__voices__.v__Alex?v=1', sha256, sizeBytes: bytes.length },
      // A malformed percent escape is still a valid URL pathname and must be reused without decoding.
      { path: 'notes%ZZ.txt', url: 'https://github.com/happier/happier-assets/releases/download/model-packs/example__notes%ZZ.txt?v=1', sha256, sizeBytes: bytes.length },
    ]);
    await ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal,
      manifestUrl: 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/example__manifest.json',
    }, { fs, fetch: fetchManifest(remote) });
    const prefix = 'https://github.com/happier-dev/happier-assets/releases/download/model-packs/';
    expect(requested).toEqual([
      `${prefix}example__model.onnx`,
      `${prefix}example__espeak-ng-data__voices__.v__Alex`,
      `${prefix}example__notes%ZZ.txt`,
    ]);
  });

  describe('large files', () => {
    it('verifies existing and downloaded files without whole-file reads', async () => {
      const existing = multiChunkBytes(1);
      const downloaded = multiChunkBytes(2);
      const fs = createFs(new Map([[`${PACK_URI}/existing.bin`, existing]]));
      const requested: string[] = [];
      useNativeDownloads(fs, () => downloaded, requested);
      await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'existing.bin', url: 'https://example.com/existing.bin', sha256: await sha256Hex(existing), sizeBytes: existing.length },
          { path: 'downloaded.bin', url: 'https://example.com/downloaded.bin', sha256: await sha256Hex(downloaded), sizeBytes: downloaded.length },
        ])),
      });
      expect(requested).toEqual(['https://example.com/downloaded.bin']);
      expect(Buffer.from(fs.files.get(`${PACK_URI}/downloaded.bin`) ?? []).equals(Buffer.from(downloaded))).toBe(true);
    });

    it('rejects and removes a downloaded file whose SHA-256 does not match', async () => {
      const fs = createFs();
      useNativeDownloads(fs, () => new Uint8Array([4, 5, 6, 7]));
      await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: 'a'.repeat(64), sizeBytes: 4 },
        ])),
      })).rejects.toThrow('model_pack_sha256_mismatch');
      expect(fs.files.has(`${PACK_URI}/model.bin`)).toBe(false);
      expect(fs.files.has(`${PACK_URI}/pack.json`)).toBe(false);
    });

    it.each(['existing', 'downloaded'] as const)('stops %s file verification when cancelled and closes its handle', async (state) => {
      const bytes = multiChunkBytes(3);
      const fileUri = `${PACK_URI}/model.bin`;
      const files = new Map<string, Uint8Array>(state === 'existing' ? [[fileUri, bytes]] : []);
      const openHandles = new Set<object>();
      const controller = new AbortController();
      const fs = createFs(files, { openHandles, onRead: () => queueMicrotask(() => controller.abort()) });
      useNativeDownloads(fs, () => bytes);
      await expect(ensureModelPackInstalled({ ...installOptions, signal: controller.signal }, {
        fs, fetch: fetchManifest(manifest([
          { path: 'model.bin', url: 'https://example.com/model.bin', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
        ])),
      })).rejects.toThrow('aborted');
      expect(openHandles.size).toBe(0);
      expect(files.has(`${PACK_URI}/pack.json`)).toBe(false);
      expect(files.has(fileUri)).toBe(state === 'existing');
    });
  });

  it('rejects pack manifests that contain unsafe paths', async () => {
    await expect(ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal }, {
      fs: createFs(), fetch: fetchManifest(manifest([
        { path: '../escape.txt', url: 'https://example.com/escape.txt', sha256: 'a'.repeat(64), sizeBytes: 1 },
      ])),
    })).rejects.toThrow('model_pack_invalid_path');
  });

  it('refreshes an installed pack when a requested manual update has a different remote manifest', async () => {
    const fs = createFs();
    const oldManifest = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 },
    ]);
    const meta = new fs.File(PACK_URI, 'pack.json');
    meta.write(JSON.stringify({ manifest: oldManifest }));
    const bytes = new Uint8Array([1]);
    useNativeDownloads(fs, () => bytes);
    const remote = manifest([
      { path: 'model.onnx', url: 'https://example.com/model.onnx?rev=2', sha256: await sha256Hex(bytes), sizeBytes: bytes.length },
    ], 'v2');
    await ensureModelPackInstalled({ ...installOptions, signal: new AbortController().signal, updatePolicy: 'manual_update_if_available' }, {
      fs, fetch: fetchManifest(remote),
    });
    const parsed = JSON.parse(await meta.text());
    expect(parsed.manifest.version).toBe('v2');
  });

  it('throws when packs are required but not installed', async () => {
    await expect(ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal, mode: 'require_installed', manifestUrl: null,
    }, { fs: createFs() })).rejects.toThrow('model_pack_not_installed');
  });

  it('throws when download is requested but manifestUrl is missing', async () => {
    await expect(ensureModelPackInstalled({
      ...installOptions, signal: new AbortController().signal, manifestUrl: null,
    }, { fs: createFs() })).rejects.toThrow('model_pack_manifest_url_missing');
  });

  it('reports not installed when pack.json is missing', async () => {
    const summary = await getModelPackInstallSummary({ packId: 'example' }, { fs: createFs() });
    expect(summary.installed).toBe(false);
    expect(summary.manifest).toBe(null);
  });

  it('removes without throwing when the directory is missing', async () => {
    await expect(removeModelPack({ packId: 'example' }, { fs: createFs() })).resolves.toBeUndefined();
  });
});
