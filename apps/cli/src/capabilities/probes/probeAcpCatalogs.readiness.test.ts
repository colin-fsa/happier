import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AGENT_IDS } from '@happier-dev/agents';
import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';
import { agent as agyEntry } from '@/backends/agy';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease';
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

describe('Antigravity ACP capability launch', () => {
  const release = (() => {
    try {
      return resolveAgyAcpReleaseAsset();
    } catch {
      return null;
    }
  })();
  for (const installed of [true, false]) {
    it.skipIf(installed && !release)(`uses only the existing managed server (installed=${installed})`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'happier-agy-capability-readiness-'));
      const keys = ['happyHomeDir', 'logsDir', 'settingsFile'] as const;
      const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(configuration, key)!);
      Object.defineProperties(configuration, {
        happyHomeDir: { value: home, configurable: true },
        logsDir: { value: join(home, 'logs'), configurable: true },
        settingsFile: { value: join(home, 'settings.json'), configurable: true },
      });
      const installDir = join(home, 'tools', 'agy-acp-server');
      const managedPath = join(installDir, 'current', release?.executableSubpath ?? 'unavailable-managed-server');
      const argvPath = join(home, 'probe-argv.json');
      const methodsPath = join(home, 'probe-methods.jsonl');
      const originalSpawn = childProcess.spawn;
      // Redirect the native managed-server executable at the OS boundary to a real scripted ACP process.
      const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof childProcess.spawn>) => {
        return args[0] === managedPath
          ? originalSpawn(process.execPath, [managedPath, ...(args[1] ?? [])], args[2])
          : originalSpawn(...args);
      });
      const downloadRequest = vi.spyOn(https, 'request').mockImplementation(() => {
        throw new Error('Unexpected capability installation download');
      });
      syncBuiltinESMExports();
      try {
        if (installed) {
          const source = String.raw`
            const { writeFileSync, appendFileSync } = require('node:fs');
            writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));
            require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
              const request = JSON.parse(line);
              appendFileSync(${JSON.stringify(methodsPath)}, JSON.stringify(request.method) + '\n');
              if (request.method === 'initialize') {
                process.stdout.write(JSON.stringify({
                  jsonrpc: '2.0', id: request.id,
                  result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } },
                }) + '\n');
              }
            });
          `;
          await mkdir(join(installDir, 'current'), { recursive: true });
          await writeFile(managedPath, source);
          await chmod(managedPath, 0o755);
          const metadata = await stat(managedPath);
          await writeFile(join(installDir, 'install-state.json'), JSON.stringify({
            executableSha256: createHash('sha256').update(source).digest('hex'),
            executableSize: metadata.size,
            executableMtimeMs: metadata.mtimeMs,
          }));
        }
        const interactivePath = join(home, 'interactive-agy');
        // Snapshot identities remain interactive CLI facts; the ACP launcher is provider-owned.
        const clis = Object.fromEntries(AGENT_IDS.map((id) => [id, { available: false }])) as DetectCliSnapshot['clis'];
        const context = {
          cliSnapshot: {
            path: null,
            clis: { ...clis, agy: { available: true, resolvedPath: interactivePath } },
            tmux: { available: false },
            windowsTerminal: { available: false },
          },
        };
        const getCapability = agyEntry.getCliCapabilityOverride;
        if (!getCapability) throw new Error('Expected the catalog ACP capability hook');
        const capability = await getCapability();
        const result = await capability.detect({
          request: { id: 'cli.agy', params: { includeAcpCapabilities: true } },
          context,
        });
        expect(result).toMatchObject({
          available: true,
          resolvedPath: interactivePath,
          acp: installed ? { ok: true, loadSession: true }
            : { ok: false, error: { message: expect.stringContaining('Agy ACP server is unavailable:') } },
        });
        expect(downloadRequest).not.toHaveBeenCalled();
        if (installed) {
          expect(JSON.parse(await readFile(argvPath, 'utf8'))).toEqual(release?.args);
          expect((await readFile(methodsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))).toEqual(['initialize']);
        } else {
          expect(spawn).not.toHaveBeenCalled();
          await expect(readdir(installDir)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } finally {
        keys.forEach((key, index) => Object.defineProperty(configuration, key, descriptors[index]));
        spawn.mockRestore();
        downloadRequest.mockRestore();
        syncBuiltinESMExports();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
