import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// File logging is an output boundary; private-file creation and cleanup stay real.
vi.mock('@/ui/logger', () => ({ logger: { infoFile: vi.fn() } }));
import { logger } from '@/ui/logger';

import { materializeClaudeMcpConfigArgsForSpawn } from './materializeClaudeMcpConfigArgsForSpawn';

describe('materializeClaudeMcpConfigArgsForSpawn', () => {
    it('reports incomplete private configuration cleanup and preserves unexpected directory contents', async () => {
        const materialized = await materializeClaudeMcpConfigArgsForSpawn(['--mcp-config', '{"mcpServers":{}}']);
        const configPath = materialized.cleanupPaths[0]!;
        const retainedPath = join(dirname(configPath), 'unexpected-entry');
        await writeFile(retainedPath, 'retained');
        try {
            await expect(materialized.cleanup()).rejects.toMatchObject({
                name: 'AggregateError',
                errors: [expect.objectContaining({ code: 'ENOTEMPTY' })],
            });
            await expect(readFile(retainedPath, 'utf8')).resolves.toBe('retained');
            expect(logger.infoFile).toHaveBeenCalledWith('[claude] Private MCP configuration cleanup incomplete (claude_mcp_config_cleanup_incomplete)');
        } finally {
            await rm(dirname(configPath), { recursive: true, force: true });
        }
    });
    it('replaces inline MCP JSON with private files, preserves path inputs, and cleans up idempotently', async () => {
        const first = JSON.stringify({
            mcpServers: { first: { command: 'mcp-one', env: { TOKEN: 'synthetic-first' } } },
        });
        const second = JSON.stringify({
            mcpServers: { second: { command: 'mcp-two', env: { TOKEN: 'synthetic-second' } } },
        });
        const existingPath = '/already/materialized/mcp.json';

        const materialized = await materializeClaudeMcpConfigArgsForSpawn([
            '--mcp-config',
            first,
            '--mcp-config',
            existingPath,
            `--mcp-config=${second}`,
        ]);

        expect(JSON.stringify(materialized.args)).not.toContain('synthetic-first');
        expect(JSON.stringify(materialized.args)).not.toContain('synthetic-second');
        expect(materialized.args[3]).toBe(existingPath);
        expect(materialized.cleanupPaths).toHaveLength(2);

        const firstPath = materialized.args[1]!;
        const secondPath = materialized.args[4]!.slice('--mcp-config='.length);
        await expect(readFile(firstPath, 'utf8')).resolves.toBe(first);
        await expect(readFile(secondPath, 'utf8')).resolves.toBe(second);
        if (process.platform !== 'win32') {
            expect((await stat(firstPath)).mode & 0o777).toBe(0o600);
            expect((await stat(secondPath)).mode & 0o777).toBe(0o600);
        }

        await materialized.cleanup();
        await materialized.cleanup();
        expect(existsSync(firstPath)).toBe(false);
        expect(existsSync(secondPath)).toBe(false);
        expect(existsSync(dirname(firstPath))).toBe(false);
        expect(existsSync(dirname(secondPath))).toBe(false);
    });
});
