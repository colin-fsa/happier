import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('every desktop channel signs bundled hsetup with the shared Bun JIT entitlement policy', () => {
  const tauriDir = new URL('../../../apps/ui/src-tauri/', import.meta.url);
  const baseConfig = JSON.parse(readFileSync(new URL('tauri.conf.json', tauriDir), 'utf8'));
  const standalone = readFileSync(new URL('../release/bun-standalone.entitlements.plist', import.meta.url), 'utf8');
  assert.match(standalone, /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/u);
  // Tauri re-signs every externalBin with this policy, including when CI
  // bundles an already-built unsigned candidate.
  for (const channel of ['tauri.conf.json', 'tauri.preview.conf.json', 'tauri.publicdev.conf.json']) {
    const override = JSON.parse(readFileSync(new URL(channel, tauriDir), 'utf8'));
    const bundle = { ...baseConfig.bundle, ...override.bundle };
    const macOS = { ...baseConfig.bundle.macOS, ...override.bundle?.macOS };
    assert.ok(bundle.externalBin.includes('binaries/hsetup'), channel);
    assert.equal(typeof macOS.entitlements, 'string', channel);
    assert.equal(
      new URL(macOS.entitlements, tauriDir).href,
      new URL('../release/bun-standalone.entitlements.plist', import.meta.url).href,
      'desktop and standalone signing must consume one entitlement file',
    );
    const desktop = readFileSync(new URL(macOS.entitlements, tauriDir), 'utf8');
    assert.match(desktop, /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/u, channel);
    assert.doesNotMatch(desktop, /allow-unsigned-executable-memory|disable-library-validation/u, channel);
  }
  assert.doesNotMatch(standalone, /com\.apple\.security\.device\.audio-input/u);
});
