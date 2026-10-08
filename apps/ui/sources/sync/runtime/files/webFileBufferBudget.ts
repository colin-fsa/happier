function parseOptionalPositiveInt(value: unknown): number | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : undefined;
}

export function resolveWebFileBufferMaxBytes(): number {
    return (
        parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_FILES_DOWNLOAD_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_FILES_DOWNLOAD_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES)
        // Conservative default to prevent unbounded buffering on web.
        ?? 50_000_000
    );
}
