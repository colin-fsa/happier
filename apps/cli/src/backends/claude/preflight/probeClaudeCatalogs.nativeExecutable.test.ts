import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { withTempDir } from '@/testkit/fs/tempDir';

import { claudeCatalogProcessFixture, waitForClosed } from './claudeCatalogProcessFixture.testkit';
import { probeClaudeCatalogs } from './probeClaudeCatalogs';

const sdkLogEnv = createEnvKeyScope(['DEBUG', 'DEBUG_SDK']);
beforeEach(() => sdkLogEnv.patch({ DEBUG: undefined, DEBUG_SDK: undefined }));
afterEach(() => sdkLogEnv.restore());

describe('Claude native executable catalog discovery', () => {
  it('discovers native commands without a provisioned SDK JavaScript runtime', async () => {
    await withTempDir('happier-claude-native-catalog-', async (cwd) => {
      const fixturePath = join(cwd, 'fixture.cjs');
      const logPath = join(cwd, 'transport.jsonl');
      await writeFile(fixturePath, claudeCatalogProcessFixture);
      // The SDK launches this CLI entrypoint directly. Its interpreter stands in for the
      // external native provider binary; no Happier-managed JavaScript runtime is available.
      const executable = await writeExecutableShim({
        dir: cwd,
        fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`
          : `#!${process.execPath}\n${claudeCatalogProcessFixture}`,
      });
      const result = await probeClaudeCatalogs({ cwd, timeoutMs: 5_000, processEnv: {
        ...process.env,
        HAPPIER_CLAUDE_PATH: executable,
        HAPPIER_MANAGED_NODE_BIN: join(cwd, 'unavailable-runtime'),
        HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
        HAPPIER_E2E_CATALOG_COMMANDS: '[{"name":"review","description":"Review changes","argumentHint":""}]',
      } });
      expect(result.commands).toEqual([{ name: 'review', description: 'Review changes', argumentHint: '' }]);
      expect(result.skills).toBeNull();
      expect((await waitForClosed(logPath)).some((event) => event.type === 'closed')).toBe(true);
    });
  });
});
