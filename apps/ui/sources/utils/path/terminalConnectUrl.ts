import { isAcceptedHappierUrlProtocol, resolveAppUrlScheme } from '@/utils/url/appScheme';
import { parseHappierCustomSchemeUrl } from '@/utils/url/parseHappierCustomSchemeUrl';

export type ParsedTerminalConnectUrl = Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null;
    pairing?: Readonly<{
        secretB64Url: string;
        createdAtMs: number;
        expiresAtMs: number;
    }>;
}>;

const SAFE_SERVER_PROTOCOLS = new Set(['http:', 'https:']);
const TERMINAL_CONNECT_WEB_PATH = '/terminal/connect';

function normalizeServerUrl(raw: string): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol)) return null;
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function normalizeWebPathname(pathname: string): string {
    return String(pathname ?? '').replace(/\/+$/, '');
}

function parsePairingContext(params: URLSearchParams): ParsedTerminalConnectUrl['pairing'] {
    const secretB64Url = (params.get('pairingSecret') ?? '').trim();
    const createdAtMs = Number(params.get('createdAt'));
    const expiresAtMs = Number(params.get('expiresAt'));
    if (
        !secretB64Url
        || !Number.isSafeInteger(createdAtMs)
        || !Number.isSafeInteger(expiresAtMs)
        || createdAtMs < 0
        || expiresAtMs <= createdAtMs
    ) {
        return undefined;
    }
    return { secretB64Url, createdAtMs, expiresAtMs };
}

function withPairingContext(
    base: Omit<ParsedTerminalConnectUrl, 'pairing'>,
    params: URLSearchParams,
): ParsedTerminalConnectUrl {
    const pairing = parsePairingContext(params);
    return pairing ? { ...base, pairing } : base;
}

function buildPairingQuerySuffix(pairing: ParsedTerminalConnectUrl['pairing']): string {
    if (!pairing) return '';
    return `&pairingSecret=${encodeURIComponent(pairing.secretB64Url)}`
        + `&createdAt=${pairing.createdAtMs}`
        + `&expiresAt=${pairing.expiresAtMs}`;
}

function parseTerminalConnectWebUrl(raw: string): ParsedTerminalConnectUrl | null {
    try {
        const parsed = new URL(raw);
        // Bundled macOS/Linux Tauri webviews carry app routes on this local origin.
        const isLocalTauriCarrier = parsed.protocol === 'tauri:' && parsed.host === 'localhost';
        if (!SAFE_SERVER_PROTOCOLS.has(parsed.protocol) && !isLocalTauriCarrier) return null;
        if (normalizeWebPathname(parsed.pathname) !== TERMINAL_CONNECT_WEB_PATH) return null;

        const hashTail = String(parsed.hash ?? '').replace(/^#/, '');
        const source = hashTail || String(parsed.search ?? '').replace(/^\?/, '');
        if (!source) return null;

        const params = new URLSearchParams(source);
        const key = (params.get('key') ?? '').trim();
        if (!key) return null;

        const serverUrl = normalizeServerUrl(params.get('server') ?? '');
        return withPairingContext({ publicKeyB64Url: key, serverUrl }, params);
    } catch {
        return null;
    }
}

export function buildTerminalConnectDeepLink(params: Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null | undefined;
    pairing?: ParsedTerminalConnectUrl['pairing'];
}>): string {
    const terminalPrefix = `${resolveAppUrlScheme()}://terminal?`;
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');
    const pairingSuffix = buildPairingQuerySuffix(params.pairing);
    if (!safeServerUrl && !pairingSuffix) {
        return `${terminalPrefix}${publicKeyB64Url}`;
    }
    const serverSuffix = safeServerUrl ? `&server=${encodeURIComponent(safeServerUrl)}` : '';
    return `${terminalPrefix}key=${encodeURIComponent(publicKeyB64Url)}${serverSuffix}${pairingSuffix}`;
}

export function buildTerminalConnectWebHref(params: Readonly<{
    publicKeyB64Url: string;
    serverUrl: string | null | undefined;
    pairing?: ParsedTerminalConnectUrl['pairing'];
}>): string {
    const publicKeyB64Url = String(params.publicKeyB64Url ?? '').trim();
    const safeServerUrl = normalizeServerUrl(params.serverUrl ?? '');

    const serverSuffix = safeServerUrl ? `&server=${encodeURIComponent(safeServerUrl)}` : '';
    const hash =
        `#key=${encodeURIComponent(publicKeyB64Url)}${serverSuffix}${buildPairingQuerySuffix(params.pairing)}`;

    return `${TERMINAL_CONNECT_WEB_PATH}${hash}`;
}

export function parseTerminalConnectUrl(url: string): ParsedTerminalConnectUrl | null {
    const raw = String(url ?? '');
    const parsed = parseHappierCustomSchemeUrl(raw);
    const matchesTerminalTarget =
        parsed != null &&
        parsed.protocol != null &&
        isAcceptedHappierUrlProtocol(parsed.protocol) &&
        (
            parsed.hostname === 'terminal' ||
            parsed.pathname === 'terminal' ||
            parsed.pathname === '/terminal'
        );

    if (!matchesTerminalTarget || !parsed) {
        return parseTerminalConnectWebUrl(raw);
    }

    const tail = parsed.search.replace(/^\?/, '');
    if (!tail) return null;

    // Legacy format: happier://terminal?<publicKeyB64Url>
    // Canonical format: happier://terminal?key=<publicKeyB64Url>&server=<encodedServerUrl>
    const looksLikeQuery = tail.includes('=') || tail.includes('&');
    if (!looksLikeQuery) {
        return { publicKeyB64Url: tail, serverUrl: null };
    }

    const params = new URLSearchParams(tail);
    const key = (params.get('key') ?? '').trim();
    if (!key) return null;

    const serverUrl = normalizeServerUrl(params.get('server') ?? '');
    return withPairingContext({ publicKeyB64Url: key, serverUrl }, params);
}
