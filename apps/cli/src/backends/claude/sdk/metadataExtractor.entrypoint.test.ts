import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('applies Happier attribution to metadata probes and isolates cached catalogs by attribution', async () => {
  root = await mkdtemp(join(tmpdir(), 'happier-claude-metadata-entrypoint-'));
  const configDir = join(root, 'claude');
  const claudePath = join(root, 'claude.cjs');
  await mkdir(configDir);
  // External Claude process fixture: exercise the real extractor, query and environment owner.
  await writeFile(claudePath, `
    if (process.argv.includes('--version')) {
      process.stdout.write('claude fixture-entrypoint\\n');
    } else {
      process.stdout.write(JSON.stringify({
        type: 'system', subtype: 'init', session_id: 'metadata-fixture',
        tools: [process.env.CLAUDE_CODE_ENTRYPOINT || 'default', process.env.CLAUDECODE || 'clean'],
        slash_commands: ['/help']
      }) + '\\n');
      if (!process.argv.includes('--no-session-persistence')) {
        require('node:fs').writeFileSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR, 'probe.jsonl'), 'hello');
      }
    }
  `);
  vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'happier'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  vi.stubEnv('HAPPIER_CLAUDE_PATH', claudePath);
  vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'sdk-ts');
  vi.stubEnv('CLAUDECODE', '1');
  vi.resetModules();
  const { extractSDKMetadata } = await import('./metadataExtractor');
  expect(await extractSDKMetadata()).toMatchObject({ tools: ['default', 'clean'] });
  expect(await extractSDKMetadata({ claudeCodeIncludeInNativeHistory: true })).toMatchObject({ tools: ['happier', 'clean'] });
  expect(await extractSDKMetadata({ claudeCodeIncludeInNativeHistory: false })).toMatchObject({ tools: ['default', 'clean'] });
  expect(await import('node:fs/promises').then(fs => fs.readdir(configDir))).not.toContain('probe.jsonl');
});
