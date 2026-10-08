import { Platform } from 'react-native';

import {
    downloadDaemonSessionFileToDestination,
    type BulkTransferFileDestination,
} from '@/sync/domains/transfers/runtime/bulkTransferPipeline';
import { createNativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';
import { resolveWebFileBufferMaxBytes } from '@/sync/runtime/files/webFileBufferBudget';

const PREVIEW_CACHE_DIRECTORY_NAME = 'happier-previews';
const PREVIEW_SIZE_LIMIT_ERROR = 'File exceeds preview size limit';

export type SessionFilePreviewSource = Readonly<{
    uri: string;
    sizeBytes: number;
    cacheSizeBytes: number;
    svgXml: string | null;
    cleanup: () => void | Promise<void>;
}>;

type SessionFilePreviewDestination = BulkTransferFileDestination & Readonly<{
    cleanup: () => Promise<void>;
    buildSource: (input: Readonly<{
        name: string;
        sizeBytes: number;
        mimeType: string;
    }>) => Promise<SessionFilePreviewSource>;
}>;

type SessionFilePreviewDestinationResult =
    | Readonly<{ ok: true; destination: SessionFilePreviewDestination }>
    | Readonly<{ ok: false; error: string }>;

export type CreateSessionFilePreviewDestination = (input: Readonly<{
    filePath: string;
    mimeType: string;
}>) => Promise<SessionFilePreviewDestinationResult> | SessionFilePreviewDestinationResult;

export type CreateSessionFilePreviewSourceResult =
    | Readonly<{ ok: true; source: SessionFilePreviewSource }>
    | Readonly<{ ok: false; error: string }>;

function normalizeMaxBytes(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value);
}

function basename(path: string): string {
    const normalized = String(path ?? '').replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).at(-1) ?? 'preview';
}

function mergeChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

function decodeSvgXml(chunks: readonly Uint8Array[], totalBytes: number): string | null {
    if (totalBytes <= 0) return null;
    try {
        const decoded = new TextDecoder('utf-8', { fatal: false }).decode(mergeChunks(chunks, totalBytes));
        return decoded.includes('<svg') ? decoded : null;
    } catch {
        return null;
    }
}

function createWebObjectUrlPreviewDestination(input: Readonly<{ mimeType: string }>): SessionFilePreviewDestinationResult {
    const chunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    let objectUrl: string | null = null;

    return {
        ok: true,
        destination: {
            writeBytes: async (bytes) => {
                bufferedBytes += bytes.byteLength;
                chunks.push(new Uint8Array(bytes));
            },
            close: async () => {},
            cleanup: async () => {
                chunks.length = 0;
                bufferedBytes = 0;
                if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                    objectUrl = null;
                }
            },
            buildSource: async (download) => {
                const blob = new Blob(chunks as BlobPart[], { type: input.mimeType });
                chunks.length = 0;
                objectUrl = URL.createObjectURL(blob);
                return {
                    uri: objectUrl,
                    sizeBytes: download.sizeBytes,
                    cacheSizeBytes: download.sizeBytes,
                    svgXml: null,
                    cleanup: () => {
                        if (!objectUrl) return;
                        URL.revokeObjectURL(objectUrl);
                        objectUrl = null;
                    },
                };
            },
        },
    };
}

async function createNativeFilePreviewDestination(input: Readonly<{
    filePath: string;
    mimeType: string;
}>): Promise<SessionFilePreviewDestinationResult> {
    const sinkResult = await createNativeCacheFileSink({
        directoryName: PREVIEW_CACHE_DIRECTORY_NAME,
        name: basename(input.filePath),
    });
    if (!sinkResult.ok) return sinkResult;

    const sink = sinkResult.sink;
    const svgChunks: Uint8Array[] = [];
    let svgBytes = 0;
    const shouldDecodeSvg = input.mimeType === 'image/svg+xml';

    return {
        ok: true,
        destination: {
            writeBytes: async (bytes) => {
                await sink.writeBytes(bytes);
                if (shouldDecodeSvg) {
                    svgBytes += bytes.byteLength;
                    svgChunks.push(new Uint8Array(bytes));
                }
            },
            close: sink.close,
            cleanup: sink.cleanup,
            buildSource: async (download) => ({
                uri: sink.fileUri,
                sizeBytes: download.sizeBytes,
                cacheSizeBytes: download.sizeBytes,
                svgXml: shouldDecodeSvg ? decodeSvgXml(svgChunks, svgBytes) : null,
                cleanup: sink.cleanup,
            }),
        },
    };
}

export function createDefaultSessionFilePreviewDestination(input: Readonly<{
    filePath: string;
    mimeType: string;
}>): Promise<SessionFilePreviewDestinationResult> | SessionFilePreviewDestinationResult {
    if (Platform.OS === 'web') {
        return createWebObjectUrlPreviewDestination({ mimeType: input.mimeType });
    }
    return createNativeFilePreviewDestination(input);
}

export async function createSessionFilePreviewSource(input: Readonly<{
    sessionId: string;
    filePath: string;
    mimeType: string;
    maxBytes?: number | null;
    signal?: AbortSignal | null;
    createDestination?: CreateSessionFilePreviewDestination;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    const requestedMaxBytes = normalizeMaxBytes(input.maxBytes);
    const maxBytes = Platform.OS === 'web'
        ? Math.min(requestedMaxBytes ?? Infinity, resolveWebFileBufferMaxBytes())
        : requestedMaxBytes;
    const destinationResult = await (input.createDestination ?? createDefaultSessionFilePreviewDestination)({
        filePath: input.filePath,
        mimeType: input.mimeType,
    });
    if (!destinationResult.ok) return destinationResult;

    const destination = destinationResult.destination;
    let downloadedBytes = 0;
    const download = await downloadDaemonSessionFileToDestination({
        sessionId: input.sessionId,
        request: { path: input.filePath, asZip: false },
        destination: {
            writeBytes: async (bytes) => {
                downloadedBytes += bytes.byteLength;
                if (maxBytes !== null && downloadedBytes > maxBytes) {
                    throw new Error(PREVIEW_SIZE_LIMIT_ERROR);
                }
                await destination.writeBytes(bytes);
            },
            close: destination.close,
            cleanup: destination.cleanup,
        },
        onInit: async (init) => {
            if (maxBytes !== null && init.sizeBytes > maxBytes) {
                return { success: false, error: PREVIEW_SIZE_LIMIT_ERROR };
            }
        },
        signal: input.signal ?? null,
    });

    if (!download.ok) {
        await destination.cleanup();
        return { ok: false, error: download.error };
    }

    return {
        ok: true,
        source: await destination.buildSource({
            name: download.name,
            sizeBytes: download.sizeBytes,
            mimeType: input.mimeType,
        }),
    };
}
