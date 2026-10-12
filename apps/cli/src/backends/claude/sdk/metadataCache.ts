import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    lstatSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    type Stats,
} from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process'

import { configuration } from '@/configuration'
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir'

export interface SDKMetadata {
    tools?: string[]
    slashCommands?: string[]
}

type CacheKey = Readonly<{
    schemaVersion: 1
    claudePath: string
    claudeVersion: string
    runtimeExecutable: string | null
    configFingerprint: string
}>

type CachedEntry = Readonly<{
    key: CacheKey
    metadata: SDKMetadata
    updatedAt: number
}>

type CacheFileV1 = Readonly<{
    version: 1
    byKey: Readonly<Record<string, CachedEntry>>
}>

const DEFAULT_CACHE: CacheFileV1 = { version: 1, byKey: {} }
const MAX_FINGERPRINT_FILE_BYTES = 2 * 1024 * 1024

let inMemory: CacheFileV1 | null = null

function resolveCachePath(): string {
    return join(configuration.happyHomeDir, 'cli', 'claude-sdk-metadata-cache.json')
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function normalizeStringArray(value: unknown): string[] | null | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) return null
    const out: string[] = []
    for (const entry of value) {
        if (typeof entry !== 'string') return null
        out.push(entry)
    }
    return out
}

function normalizeMetadata(value: unknown): SDKMetadata | null {
    const record = asRecord(value)
    if (!record) return null
    const tools = normalizeStringArray(record.tools)
    const slashCommands = normalizeStringArray(record.slashCommands)
    if (tools === null || slashCommands === null) return null

    const metadata: SDKMetadata = {}
    if (tools !== undefined) metadata.tools = tools
    if (slashCommands !== undefined) metadata.slashCommands = slashCommands
    if (!isCacheableMetadata(metadata)) return null
    return metadata
}

function normalizeCacheKey(value: unknown): CacheKey | null {
    const record = asRecord(value)
    if (!record) return null
    if (record.schemaVersion !== 1) return null
    const claudePath = typeof record.claudePath === 'string' ? record.claudePath : ''
    const claudeVersion = typeof record.claudeVersion === 'string' ? record.claudeVersion : ''
    const runtimeExecutableRaw = record.runtimeExecutable
    const runtimeExecutable = typeof runtimeExecutableRaw === 'string'
        ? runtimeExecutableRaw
        : runtimeExecutableRaw === null
            ? null
            : undefined
    const configFingerprint = typeof record.configFingerprint === 'string' ? record.configFingerprint : ''
    if (!claudePath || !claudeVersion || runtimeExecutable === undefined || !configFingerprint) return null
    return {
        schemaVersion: 1,
        claudePath,
        claudeVersion,
        runtimeExecutable,
        configFingerprint,
    }
}

function normalizeCachedEntry(value: unknown): CachedEntry | null {
    const record = asRecord(value)
    if (!record) return null
    const key = normalizeCacheKey(record.key)
    const metadata = normalizeMetadata(record.metadata)
    const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : 0
    if (!key || !metadata || updatedAt <= 0) return null
    return { key, metadata, updatedAt }
}

function loadCacheOnce(): CacheFileV1 {
    if (inMemory) return inMemory

    try {
        const raw = readFileSync(resolveCachePath(), 'utf8')
        const parsed = asRecord(JSON.parse(raw) as unknown)
        const byKeyRaw = parsed?.version === 1 ? asRecord(parsed.byKey) : null
        if (!byKeyRaw) {
            inMemory = DEFAULT_CACHE
            return inMemory
        }

        const byKey: Record<string, CachedEntry> = {}
        for (const [key, value] of Object.entries(byKeyRaw)) {
            const entry = normalizeCachedEntry(value)
            if (entry) byKey[key] = entry
        }
        inMemory = { version: 1, byKey }
        return inMemory
    } catch {
        inMemory = DEFAULT_CACHE
        return inMemory
    }
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    if (!value || typeof value !== 'object') return JSON.stringify(value)
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function hashCacheKey(key: CacheKey): string {
    return createHash('sha256').update(stableJson(key), 'utf8').digest('hex')
}

function canonicalizePath(path: string): string {
    try {
        return realpathSync(path)
    } catch {
        return path
    }
}

function isJavaScriptEntrypoint(path: string): boolean {
    const lower = path.toLowerCase()
    return lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')
}

function resolveClaudeVersion(params: Readonly<{
    claudePath: string
    runtimeExecutable?: string
}>): string | null {
    const command = isJavaScriptEntrypoint(params.claudePath) ? params.runtimeExecutable : params.claudePath
    if (!command) return null
    const args = isJavaScriptEntrypoint(params.claudePath) ? [params.claudePath, '--version'] : ['--version']

    try {
        const invocation = resolveWindowsCommandInvocation({
            command,
            args,
            env: process.env,
        })
        const raw = execFileSync(invocation.command, invocation.args, {
            encoding: 'utf8',
            windowsHide: true,
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            ...(configuration.vendorCliHelpTimeoutMs > 0 ? { timeout: configuration.vendorCliHelpTimeoutMs } : {}),
        })
        const version = raw.trim()
        return version.length > 0 ? version : null
    } catch {
        return null
    }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
    const record = asRecord(error)
    return record?.code === code
}

function updateHashValue(hash: ReturnType<typeof createHash>, value: unknown): void {
    hash.update(stableJson(value), 'utf8')
    hash.update('\0')
}

function statIdentity(stats: Stats): string {
    return `${stats.dev}:${stats.ino}`
}

function addPathFingerprint(params: Readonly<{
    hash: ReturnType<typeof createHash>
    label: string
    path: string
    visited: Set<string>
}>): boolean {
    let stats: Stats
    try {
        stats = lstatSync(params.path)
    } catch (error) {
        if (isNodeErrorCode(error, 'ENOENT')) {
            updateHashValue(params.hash, { label: params.label, path: params.path, type: 'missing' })
            return true
        }
        return false
    }

    if (stats.isSymbolicLink()) {
        try {
            const target = readlinkSync(params.path)
            const realPath = realpathSync(params.path)
            updateHashValue(params.hash, { label: params.label, path: params.path, type: 'symlink', target, realPath })
            return addPathFingerprint({
                hash: params.hash,
                label: `${params.label}:target`,
                path: realPath,
                visited: params.visited,
            })
        } catch {
            return false
        }
    }

    updateHashValue(params.hash, {
        label: params.label,
        path: params.path,
        type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    })

    if (stats.isDirectory()) {
        const identity = statIdentity(stats)
        if (params.visited.has(identity)) return true
        params.visited.add(identity)

        let entries: string[]
        try {
            entries = readdirSync(params.path).sort()
        } catch {
            return false
        }

        updateHashValue(params.hash, { label: params.label, entries })
        for (const entry of entries) {
            if (!addPathFingerprint({
                hash: params.hash,
                label: `${params.label}/${entry}`,
                path: join(params.path, entry),
                visited: params.visited,
            })) {
                return false
            }
        }
        return true
    }

    if (!stats.isFile()) return true
    if (stats.size > MAX_FINGERPRINT_FILE_BYTES) return false

    try {
        params.hash.update(readFileSync(params.path))
        params.hash.update('\0')
        return true
    } catch {
        return false
    }
}

function selectedEnvironmentFingerprint(): Record<string, string | null> {
    const keys = [
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
        'HAPPIER_CLAUDE_CONFIG_DIR',
        'HAPPIER_CLAUDE_PATH',
    ]
    const out: Record<string, string | null> = {}
    for (const key of keys) {
        const value = process.env[key]
        out[key] = typeof value === 'string' ? value : null
    }
    return out
}

function resolveConfigFingerprint(entrypoint?: string): string | null {
    const hash = createHash('sha256')
    const cwd = resolve(process.cwd())
    const configDir = resolveConfiguredClaudeConfigDir({ env: process.env })
    updateHashValue(hash, {
        schemaVersion: 1,
        cwd,
        configDir,
        env: selectedEnvironmentFingerprint(),
        ...(entrypoint ? { entrypoint } : {}),
    })

    const configFiles = ['settings.json', 'settings.local.json', '.claude.json']
    const configDirs = ['commands', 'skills', 'agents', 'plugins']
    const projectClaudeDir = join(cwd, '.claude')
    const candidates: Array<Readonly<{ label: string; path: string }>> = []

    for (const name of configFiles) {
        candidates.push({ label: `user:${name}`, path: join(configDir, name) })
        candidates.push({ label: `project:${name}`, path: join(projectClaudeDir, name) })
    }
    candidates.push({ label: 'project-root:.claude.json', path: join(cwd, '.claude.json') })

    for (const name of configDirs) {
        candidates.push({ label: `user:${name}`, path: join(configDir, name) })
        candidates.push({ label: `project:${name}`, path: join(projectClaudeDir, name) })
    }

    const visited = new Set<string>()
    for (const candidate of candidates) {
        if (!addPathFingerprint({ hash, label: candidate.label, path: candidate.path, visited })) return null
    }

    return hash.digest('hex')
}

export function resolveSDKMetadataCacheKey(params: Readonly<{
    claudePath: string
    runtimeExecutable?: string
    entrypoint?: string
}>): CacheKey | null {
    const claudeVersion = resolveClaudeVersion(params)
    const configFingerprint = resolveConfigFingerprint(params.entrypoint)
    if (!claudeVersion || !configFingerprint) return null
    return {
        schemaVersion: 1,
        claudePath: canonicalizePath(params.claudePath),
        claudeVersion,
        runtimeExecutable: params.runtimeExecutable ? canonicalizePath(params.runtimeExecutable) : null,
        configFingerprint,
    }
}

function shouldBypassSDKMetadataCache(): boolean {
    const raw = String(process.env.HAPPIER_CLAUDE_SDK_METADATA_CACHE_INVALIDATE ?? '').trim().toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

export function readCachedSDKMetadata(key: CacheKey): SDKMetadata | null {
    if (shouldBypassSDKMetadataCache()) return null
    const cache = loadCacheOnce()
    return cache.byKey[hashCacheKey(key)]?.metadata ?? null
}

export function isCacheableMetadata(metadata: SDKMetadata): boolean {
    return Array.isArray(metadata.tools) || Array.isArray(metadata.slashCommands)
}

export async function writeCachedSDKMetadata(key: CacheKey, metadata: SDKMetadata): Promise<void> {
    if (!isCacheableMetadata(metadata)) return
    const cache = loadCacheOnce()
    const cacheKey = hashCacheKey(key)
    const next: CacheFileV1 = {
        version: 1,
        byKey: {
            ...cache.byKey,
            [cacheKey]: {
                key,
                metadata,
                updatedAt: Date.now(),
            },
        },
    }
    inMemory = next

    const filePath = resolveCachePath()
    const tmpPath = `${filePath}.tmp`
    try {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(tmpPath, JSON.stringify(next), 'utf8')
        await rename(tmpPath, filePath)
    } catch {
        // Best effort: the next session can still probe.
    }
}
