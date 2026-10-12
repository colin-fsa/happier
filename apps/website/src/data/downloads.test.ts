import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
    ANDROID_APK_URL,
    ANDROID_PLAY_URL,
    APP_STORE_URL,
    DESKTOP_PLATFORMS,
    RELEASE_PUBKEY,
    RELEASE_PUBKEY_ID,
} from './downloads';

/**
 * Offline guards for the class of bug that took six outbound links down at
 * once. These check shape, not reachability — `scripts/check-download-links.mjs`
 * does reachability, and needs a network, so it stays out of the unit suite.
 */
describe('download URLs', () => {
    it('uses stable rolling aliases for every desktop download', () => {
        expect(DESKTOP_PLATFORMS).toHaveLength(6);
        for (const platform of DESKTOP_PLATFORMS) {
            expect(platform.href).not.toMatch(/-v\d/);
            expect(platform.href).toMatch(
                /^https:\/\/github\.com\/happier-dev\/happier\/releases\/download\/ui-desktop-stable\//,
            );
        }
    });

    it('offers the published Linux package formats beside the default AppImage', () => {
        expect(DESKTOP_PLATFORMS.map((p) => p.id)).toEqual([
            'mac-arm64',
            'mac-x86_64',
            'win-x86_64',
            'linux-x86_64',
            'linux-x86_64-deb',
            'linux-x86_64-rpm',
        ]);
        expect(DESKTOP_PLATFORMS.filter((p) => p.id.startsWith('linux-')).map((p) => new URL(p.href).pathname.split('/').pop())).toEqual([
            'happier-ui-desktop-linux-x86_64.AppImage',
            'happier-ui-desktop-linux-x86_64.deb',
            'happier-ui-desktop-linux-x86_64.rpm',
        ]);
    });

    // The public Play listing is ANDROID_PLAY_URL and nothing else. These
    // constants must stay what their names say — `id=dev.happier` was a 404
    // that shipped in a badge once, so a Play URL turning up in the APK, App
    // Store or desktop constants is a swapped constant, not a new feature.
    it('keeps the Play listing out of every non-Play download constant', () => {
        const surfaces = [ANDROID_APK_URL, APP_STORE_URL, ...DESKTOP_PLATFORMS.map((p) => p.href)];
        for (const url of surfaces) {
            expect(url).not.toContain('play.google.com/store');
        }
        expect(ANDROID_APK_URL).toMatch(/\.apk$/);
    });

    it('offers the stable APK through its canonical rolling alias', () => {
        expect(ANDROID_APK_URL).toBe(
            'https://github.com/happier-dev/happier/releases/download/ui-mobile-stable/happier-android.apk',
        );
    });

    it('keeps static public download surfaces on the canonical public Play listing', () => {
        const staticSurfaces = {
            'index.html': readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
            'public/llms.txt': readFileSync(new URL('../../public/llms.txt', import.meta.url), 'utf8'),
        };

        for (const [name, surface] of Object.entries(staticSurfaces)) {
            expect(surface.includes(ANDROID_PLAY_URL), `${name} must link Google Play`).toBe(true);
            expect(surface.includes('play.google.com/store/apps/details?id=dev.happier"'), `${name} must not use the old package id`).toBe(false);
            expect(surface.includes('/ui-mobile-preview/'), `${name} must not link a preview APK`).toBe(false);
        }
        expect(staticSurfaces['public/llms.txt']).toContain(ANDROID_APK_URL);
    });

    // The key printed on the page must be the key the installer verifies
    // against. public/install.sh:26-27 is the other copy; if they ever diverge
    // the trust disclosure is worse than useless.
    it('prints the minisign key the installer actually trusts', () => {
        expect(RELEASE_PUBKEY_ID).toBe('91AE28177BF6E43C');
        expect(RELEASE_PUBKEY).toBe('RWQ85PZ7FyiukYbL3qv/bKnwgbT68wLVzotapeMFIb8n+c7pBQ7U8W2t');
    });
});
