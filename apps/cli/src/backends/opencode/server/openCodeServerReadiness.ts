// V2 preview exposes /api/health; released OpenCode 2.0.15 exposes /api/info
// instead. Both are authenticated when the server has a password.
export const OPEN_CODE_V2_READINESS_PATHS = ['/api/health', '/api/info'] as const;
// Stable 1.x also answers /api/health with the preview V2 healthy marker.
// Match OpenCode's legacy-first discriminator before selecting V2 routes.
export const OPEN_CODE_AUTO_READINESS_PATHS = ['/global/health', ...OPEN_CODE_V2_READINESS_PATHS] as const;

export function isOpenCodeServerReadyResponse(path: string, body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (path === '/api/info') {
    return typeof value.version === 'string'
      && value.version.length > 0
      && typeof value.pid === 'number'
      && Number.isInteger(value.pid)
      && value.pid >= 0
      && Array.isArray(value.urls)
      && value.paths !== null
      && typeof value.paths === 'object'
      && !Array.isArray(value.paths);
  }
  return value.healthy === true;
}
