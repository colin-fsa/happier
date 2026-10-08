import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeTerminalLaunchSpec } from '@/terminal/runtime/terminalLaunchSpec';
import type { TerminalHostHandle } from '../terminalHost/_types';
import { createZellijTerminalHostAdapter } from './adapter';
import { BUNDLED_ZELLIJ_VERSION } from './runtimeBinary';
import { resolveZellijBinary } from './resolveZellijBinary';

// Opt in because this exercises a real terminal server. Every server and artifact belongs to
// this test's temporary home; no existing user sessions or Zellij configuration are touched.
describe.skipIf(process.env.HAPPIER_CLI_ZELLIJ_INTEGRATION !== '1' || process.platform === 'win32')('Zellij native launch environment', () => {
  it('passes launch-only values through the server and launch-spec runner to each provider child', async () => {
    const zellijBinary = await resolveZellijBinary({
      toolsDir: resolve('tools/unpacked'), expectedVersion: BUNDLED_ZELLIJ_VERSION,
    });
    expect(zellijBinary).not.toBeNull();
    if (!zellijBinary) throw new Error('Bundled Zellij is required for the native integration test');
    const home = await mkdtemp(join(tmpdir(), 'happier-zj-'));
    const adapter = createZellijTerminalHostAdapter({ zellijBinary, happyHomeDir: home });
    const handles: TerminalHostHandle[] = [];
    const specs: string[] = [];
    try {
      const child = join(home, 'observe-env.cjs');
      await writeFile(child, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ suggestion: process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, value: process.env.HAPPIER_TEST_LAUNCH_VALUE })); process.stdin.resume();`);
      for (const value of ['first value with spaces and $literal', 'second value "quoted"']) {
        const result = join(home, `observed-${handles.length}.json`);
        const spec = await writeTerminalLaunchSpec({
          command: process.execPath, args: [child, result], cwd: home, env: {},
          envPassthroughKeys: ['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION', 'HAPPIER_TEST_LAUNCH_VALUE'],
        });
        specs.push(spec);
        const handle = await adapter.createOrAttachHost({
          sessionName: `env-${process.pid}-${handles.length}`,
          workingDirectory: home,
          spawnArgv: [process.execPath, resolve('scripts/terminal_launch_spec_runner.cjs'), spec],
          spawnEnv: {
            TERM: 'dumb', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
            HAPPIER_TEST_LAUNCH_VALUE: value,
            XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
          },
          isolatedEnv: true,
        });
        handles.push(handle);
        await expect.poll(async () => {
          try { return JSON.parse(await readFile(result, 'utf8')); }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
            throw error;
          }
        }).toEqual({ suggestion: 'false', value });
      }
    } finally {
      for (const handle of handles) await adapter.dispose(handle);
      for (const spec of specs) await rm(dirname(spec), { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
