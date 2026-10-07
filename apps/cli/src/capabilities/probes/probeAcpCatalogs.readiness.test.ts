import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { createCatalogAcpBackend } from '@/agent/acp/createCatalogAcpBackend';
import { probeAcpCatalogs } from './probeAcpCatalogs';

describe('ACP catalog prerequisite readiness', () => {
  it.each(['catalog', 'backend', 'session'] as const)('applies the existing managed prerequisite policy for %s', async (entryPoint) => {
    // Patch the real OS HTTP adapter, including native ESM bindings in external dependencies.
    const downloadRequest = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected catalog installation download'); });
    syncBuiltinESMExports();
    const home = await mkdtemp(join(tmpdir(), 'happier-agy-catalog-readiness-'));
    const keys = ['happyHomeDir', 'logsDir', 'settingsFile'] as const;
    const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
    Object.defineProperties(configuration, {
      happyHomeDir: { value: home, configurable: true },
      logsDir: { value: join(home, 'logs'), configurable: true },
      settingsFile: { value: join(home, 'settings.json'), configurable: true },
    });
    try {
      const discovery = entryPoint === 'catalog'
        ? probeAcpCatalogs({ agentId: 'agy', cwd: home, timeoutMs: 10_000, processEnv: {} })
        : createCatalogAcpBackend('agy', { cwd: home, env: {}, ...(entryPoint === 'session' ? {} : { readinessOnly: true }) });
      await expect(discovery).rejects.toThrow();
      expect(downloadRequest).toHaveBeenCalledTimes(entryPoint === 'session' ? 1 : 0);
      if (entryPoint !== 'session') {
        await expect(readdir(join(home, 'tools', 'agy-acp-server'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      keys.forEach((key, index) => Object.defineProperty(configuration, key, descriptors[index]));
      downloadRequest.mockRestore();
      syncBuiltinESMExports();
      await rm(home, { recursive: true, force: true });
    }
  });
});
