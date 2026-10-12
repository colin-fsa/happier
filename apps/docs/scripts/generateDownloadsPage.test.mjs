import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderDownloadsPageMarkdown } from './generateDownloadsPage.mjs';

test('generated phone downloads include the manifest Play listing and APK', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../website/src/data/downloads.json', import.meta.url), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'happier-downloads-'));
  try {
    const manifestPath = join(directory, 'downloads.json');
    manifest.androidPlayUrl = 'https://play.google.com/store/apps/details?id=test.app';
    manifest.androidApkUrl = 'https://example.com/android.apk';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const markdown = await renderDownloadsPageMarkdown({ manifestPath });
    const cardDestinations = [...markdown.matchAll(/<Card\s[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(cardDestinations.includes(manifest.androidPlayUrl), 'the phone cards must link to the manifest Play listing');
    assert.ok(cardDestinations.includes(manifest.androidApkUrl), 'the direct APK download remains available');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated downloads page uses stable rolling desktop and Android links', async () => {
  const markdown = await renderDownloadsPageMarkdown();

  assert.match(markdown, /ui-mobile-stable\/happier-android\.apk/);
  assert.doesNotMatch(markdown, /ui-mobile-preview/);
  assert.match(markdown, /ui-desktop-stable\/happier-ui-desktop-darwin-aarch64\.dmg/);
  assert.match(markdown, /ui-desktop-stable\/happier-ui-desktop-windows-x86_64\.exe/);
  assert.doesNotMatch(markdown, /ui-desktop-stable\/[^\s)"']*-v\d/);
  assert.doesNotMatch(markdown, /Current desktop build:/);
});
