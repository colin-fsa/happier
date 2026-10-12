// @vitest-environment jsdom

import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_PLATFORMS } from '../data/downloads';
import { LocaleProvider } from '../i18n';
import { DownloadBadges } from './DownloadBadges';
import { DownloadHub } from './DownloadHub';

describe('desktop download links', () => {
    it.each([
        ['Mozilla/5.0 (X11; Linux aarch64) Firefox/144.0', 'Linux aarch64', false, undefined],
        ['Mozilla/5.0 (X11; Linux) Firefox/144.0', 'Linux arm64', false, undefined],
        ['Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0', 'Linux x86_64', false, 'arm'],
        ['Mozilla/5.0 (X11; Linux) Firefox/144.0', 'Linux', true, undefined],
    ] as const)('only starts a compatible default download for %s / %s', async (userAgent, platform, startsDownload, architecture) => {
        Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: userAgent });
        Object.defineProperty(window.navigator, 'platform', { configurable: true, value: platform });
        Object.defineProperty(window.navigator, 'userAgentData', {
            configurable: true,
            value: architecture ? { getHighEntropyValues: async () => ({ architecture }) } : undefined,
        });
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(
                <LocaleProvider locale="en" path="/download">
                    <div id="download-hub"><DownloadHub /></div>
                    <div id="download-badges"><DownloadBadges /></div>
                </LocaleProvider>,
            ));
            await vi.waitFor(() => {
                const status = container.querySelector('[role="status"]');
                expect(Boolean(status?.textContent)).toBe(startsDownload);
                expect(container.querySelectorAll('#download-hub a[href$=".AppImage"]')).toHaveLength(1);
                expect(container.querySelectorAll('#download-badges a[href$=".AppImage"]')).toHaveLength(startsDownload ? 1 : 0);
            });
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    it('renders the complete desktop inventory without opening an empty download tab', () => {
        const container = document.createElement('div');
        container.innerHTML = renderToStaticMarkup(
            <LocaleProvider locale="en" path="/download">
                <DownloadHub />
            </LocaleProvider>,
        );

        const links = [...container.querySelectorAll<HTMLAnchorElement>('a')];
        expect(links.some((link) => link.href === 'https://docs.happier.dev/getting-started/get-the-apps#linux-appimage-prerequisites')).toBe(true);
        for (const platform of DESKTOP_PLATFORMS) {
            const link = links.find((anchor) => anchor.href === platform.href);
            expect(link).toBeDefined();
            expect(link?.target).not.toBe('_blank');
        }
    });

    it('keeps the detected Linux download and explicit menu downloads in the current tab', async () => {
        // jsdom has no layout; this OS/browser boundary reproduces the live 1280×800 geometry.
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        const layout = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.getAttribute('role') === 'menu') return new DOMRect(0, 0, 260, 293);
            return new DOMRect(394, 510, 200, 48);
        });
        Object.defineProperty(window.navigator, 'userAgent', {
            configurable: true,
            value: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/144.0',
        });
        Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'Linux x86_64' });

        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <LocaleProvider locale="en" path="/">
                        <DownloadBadges />
                    </LocaleProvider>,
                );
            });

            const defaultDownload = DESKTOP_PLATFORMS.find((platform) => platform.id === 'linux-x86_64');
            const mainLink = [...container.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.href === defaultDownload?.href);
            expect(mainLink).toBeDefined();
            expect(mainLink?.target).not.toBe('_blank');

            const button = mainLink?.parentElement?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
            expect(button).not.toBeNull();
            await act(async () => button?.click());

            const menuLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]')];
            expect(menuLinks.filter((link) => link.href.startsWith('https://github.com/')).map((link) => link.href)).toEqual(DESKTOP_PLATFORMS.map((platform) => platform.href));
            expect(menuLinks.every((link) => link.target !== '_blank')).toBe(true);
            expect(menuLinks.some((link) => link.href === 'https://docs.happier.dev/getting-started/get-the-apps#linux-appimage-prerequisites')).toBe(true);
            const menu = menuLinks[0]?.closest<HTMLElement>('[role="menu"]');
            expect(menu).not.toBeNull();
            expect(Number.parseFloat(menu?.style.top ?? '') + 293).toBeLessThanOrEqual(window.innerHeight);
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
            await act(async () => window.dispatchEvent(new Event('resize')));
            expect(Number.parseFloat(menu?.style.left ?? '') + 260).toBeLessThanOrEqual(window.innerWidth);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            layout.mockRestore();
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width });
            Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.height });
        }
    });
});
