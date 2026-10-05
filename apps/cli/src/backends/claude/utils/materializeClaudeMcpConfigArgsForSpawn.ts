import { randomUUID } from 'node:crypto';
import { rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { writeSecureMcpRuntimeConfigFile } from '@/mcp/runtime/writeSecureMcpRuntimeConfigFile';
import { logger } from '@/ui/logger';

export const CLAUDE_MCP_CONFIG_FILE_PREFIX = 'happier-claude-mcp-config';
const CLAUDE_MCP_CONFIG_DIRECTORY_PREFIX = `${CLAUDE_MCP_CONFIG_FILE_PREFIX}-`;

export type MaterializedClaudeMcpConfigArgs = Readonly<{
    args: string[];
    cleanupPaths: string[];
    cleanup: () => Promise<void>;
}>;

function parseInlineMcpConfig(value: string): unknown | null {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;

    try {
        const parsed: unknown = JSON.parse(trimmed);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch {
        return null;
    }
}

async function cleanupMaterializedConfigPaths(configPaths: readonly string[]): Promise<void> {
    const failures: unknown[] = [];
    const remove = async (operation: () => Promise<void>): Promise<void> => {
        try { await operation(); } catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
            failures.push(error);
        }
    };
    await Promise.all(configPaths.map(async (configPath) => {
        await remove(() => unlink(configPath));
        const directory = dirname(configPath);
        if (basename(directory).startsWith(CLAUDE_MCP_CONFIG_DIRECTORY_PREFIX)) {
            await remove(() => rmdir(directory));
        }
    }));
    if (failures.length > 0) {
        logger.infoFile('[claude] Private MCP configuration cleanup incomplete (claude_mcp_config_cleanup_incomplete)');
        throw new AggregateError(failures, 'Private Claude MCP configuration cleanup incomplete');
    }
}

/**
 * Replaces inline Claude `--mcp-config` JSON values with private temporary files.
 *
 * Claude accepts either JSON or a file path for this flag. Paths already supplied by the user are
 * preserved verbatim; only inline JSON is materialized so secret-bearing config never reaches the
 * provider process argv.
 */
export async function materializeClaudeMcpConfigArgsForSpawn(
    inputArgs: readonly string[],
): Promise<MaterializedClaudeMcpConfigArgs> {
    const args = [...inputArgs];
    const cleanupPaths: string[] = [];

    const materializeValue = async (value: string): Promise<string> => {
        const payload = parseInlineMcpConfig(value);
        if (payload === null) return value;

        // A fresh UUID directory avoids trusting or reusing ACL state left by an older process.
        // The writer creates and protects it before any credential-bearing bytes are written.
        const privateDirectory = join(tmpdir(), `${CLAUDE_MCP_CONFIG_DIRECTORY_PREFIX}${randomUUID()}`);
        let configPath: string;
        try {
            configPath = await writeSecureMcpRuntimeConfigFile({
                prefix: CLAUDE_MCP_CONFIG_FILE_PREFIX,
                tmpDir: privateDirectory,
                payload,
            });
        } catch (error) {
            try { await rmdir(privateDirectory); } catch (cleanupError) {
                if (!(typeof cleanupError === 'object' && cleanupError !== null && 'code' in cleanupError && cleanupError.code === 'ENOENT')) {
                    logger.infoFile('[claude] Private MCP configuration cleanup incomplete (claude_mcp_config_cleanup_incomplete)');
                    throw new AggregateError([error, cleanupError], 'Claude MCP configuration preparation failed with incomplete cleanup', { cause: error });
                }
            }
            throw error;
        }
        cleanupPaths.push(configPath);
        return configPath;
    };

    try {
        for (let index = 0; index < args.length; index += 1) {
            const arg = args[index] ?? '';
            if (arg === '--mcp-config') {
                const valueIndex = index + 1;
                const value = args[valueIndex];
                if (typeof value === 'string') {
                    args[valueIndex] = await materializeValue(value);
                    index = valueIndex;
                }
                continue;
            }

            if (arg.startsWith('--mcp-config=')) {
                const value = arg.slice('--mcp-config='.length);
                args[index] = `--mcp-config=${await materializeValue(value)}`;
            }
        }
    } catch (error) {
        try { await cleanupMaterializedConfigPaths(cleanupPaths); } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Claude MCP configuration preparation failed with incomplete cleanup', { cause: error });
        }
        throw error;
    }

    return {
        args,
        cleanupPaths,
        cleanup: async () => {
            await cleanupMaterializedConfigPaths(cleanupPaths);
        },
    };
}
