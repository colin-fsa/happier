import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
    ANDROID_APK_URL,
    ANDROID_PLAY_URL,
    APP_STORE_URL,
    DESKTOP_PLATFORMS,
    DESKTOP_RELEASES_PAGE,
    LINUX_APPIMAGE_REQUIREMENTS_URL,
    type DesktopPlatformId,
} from '../data/downloads';
import { detectDesktopArchitecture, detectPlatform, isHandheld, readDesktopArchitectureHint } from './usePlatform';
import { trackDownloadBadgeClicked } from '../analytics/events';
import { locationOf } from '../analytics/location';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

/**
 * The /download page's inventory: every install target, plus the one behaviour
 * that page exists for — starting the right download without being asked.
 *
 * The SERVER RENDER is the complete list and nothing else. That is what a
 * crawler, a no-JS reader and the first client paint all see, and it is a
 * usable page on its own: every desktop format, both stores, the APK, the
 * releases page. Detection runs in an effect (the usePlatform rule — never
 * during render, so hydration cannot mismatch) and then does the LEAST
 * confident thing the platform allows:
 *
 *   windows / linux   default to the EXE / AppImage (unless Linux reports ARM,
 *                     for which no desktop artifact is published) via
 *                     `location.replace` — the page stays visible underneath,
 *                     because replacing to a binary asset does not navigate.
 *   mac               two artifacts, and the UA string does not say which
 *                     (Chrome reports "Intel Mac OS X" on Apple Silicon).
 *                     Chromium's `userAgentData.getHighEntropyValues` names
 *                     the architecture, so redirect there; Safari has no such
 *                     API, and GUESSING would hand Intel DMGs to M-series
 *                     Macs — so Safari gets the two macOS buttons highlighted
 *                     and one line telling the visitor where their chip is
 *                     named. Same reasoning as the split button in
 *                     DownloadBadges.tsx, which opens its popover in that case.
 *   ios/ipados/android a desktop binary is a dead end, so never redirect:
 *                     reorder the stores above the desktop builds instead.
 *
 * The auto-redirect emits `download_badge_clicked` with `detected: true` — the
 * event the delegated listener in useLinkClicks.ts would have captured had the
 * visitor clicked, emitted here by hand because `location.replace` is not a
 * click. Same event, same shape, no new taxonomy.
 */

type Hint =
    | { kind: 'none' }
    | { kind: 'redirecting'; id: DesktopPlatformId }
    | { kind: 'pick-your-mac' }
    /** Which store is THIS device's — an iPhone must never see Play chipped. */
    | { kind: 'handheld'; store: 'app-store' | 'google-play' };

/** Same @property-animated tokens as the badges; see DownloadBadges.tsx. */
const CARD_STYLE = {
    borderColor: 'var(--card-border)',
    background: 'var(--card)',
    color: 'var(--fg)',
} as const;

const STORES = [
    { id: 'app-store', href: APP_STORE_URL, label: 'App Store', sublabel: 'iPhone & iPad' },
    { id: 'google-play', href: ANDROID_PLAY_URL, label: 'Google Play', sublabel: 'Android' },
    { id: 'android-apk', href: ANDROID_APK_URL, label: 'Android APK', sublabel: 'Direct download' },
] as const;

function Chip({ children }: { children: string }) {
    return (
        <span
            className="shrink-0 rounded-full px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: 'var(--bg)', background: 'var(--fg)' }}
        >
            {children}
        </span>
    );
}

function Card({
    href,
    label,
    sublabel,
    chip,
    target,
}: {
    href: string;
    label: string;
    sublabel: string;
    chip?: string;
    target?: '_blank';
}) {
    return (
        <a
            href={href}
            target={target}
            rel="noreferrer"
            className="flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 transition-transform hover:-translate-y-[1px]"
            style={chip ? { ...CARD_STYLE, borderColor: 'var(--fg)' } : CARD_STYLE}
        >
            <span className="flex min-w-0 flex-col leading-[1.25]">
                <span className="text-[14px] font-semibold tracking-tight">{label}</span>
                <span className="truncate text-[11.5px] font-medium" style={{ color: 'var(--muted)' }}>
                    {sublabel}
                </span>
            </span>
            {chip ? <Chip>{chip}</Chip> : null}
        </a>
    );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
    return (
        <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>
                {heading}
            </h3>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">{children}</div>
        </div>
    );
}

export function DownloadHub() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();
    const copy = PAGE_PROSE.downloadPage;
    const [hint, setHint] = useState<Hint>({ kind: 'none' });
    const root = useRef<HTMLDivElement | null>(null);
    // StrictMode runs effects twice in dev; one detection, one event, one redirect.
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;

        const begin = (id: DesktopPlatformId) => {
            const target = DESKTOP_PLATFORMS.find((p) => p.id === id);
            if (!target) return;
            trackDownloadBadgeClicked({
                store: 'desktop',
                location: locationOf(root.current),
                variant: id,
                detected: true,
            });
            setHint({ kind: 'redirecting', id });
            window.location.replace(target.href);
        };

        const platform = detectPlatform();
        if (platform === 'windows') return begin('win-x86_64');
        if (platform === 'linux' && detectDesktopArchitecture() === 'arm64') return;
        if (isHandheld(platform)) {
            return setHint({
                kind: 'handheld',
                store: platform === 'android' ? 'google-play' : 'app-store',
            });
        }
        if (platform !== 'mac' && platform !== 'linux') return; // 'unknown': the full list is the answer.

        const withoutArchitectureHint = () => {
            if (platform === 'linux') begin('linux-x86_64');
            else setHint({ kind: 'pick-your-mac' });
        };

        void readDesktopArchitectureHint().then((architecture) => {
            if (platform === 'linux') {
                if (architecture !== 'arm64') begin('linux-x86_64');
                return;
            }
            if (architecture === 'arm64') begin('mac-arm64');
            else if (architecture === 'x86_64') begin('mac-x86_64');
            else withoutArchitectureHint();
        });
    }, []);

    const redirecting =
        hint.kind === 'redirecting' ? DESKTOP_PLATFORMS.find((p) => p.id === hint.id) : undefined;

    const desktopChip = (id: DesktopPlatformId): string | undefined => {
        if (hint.kind === 'redirecting' && hint.id === id) return copy.p8;
        if (hint.kind === 'pick-your-mac' && (id === 'mac-arm64' || id === 'mac-x86_64')) return copy.p9;
        return undefined;
    };

    const desktop = (
        <Group heading={copy.p6}>
            {DESKTOP_PLATFORMS.map((p) => (
                <Card key={p.id} href={p.href} label={p.label} sublabel={p.sublabel} chip={desktopChip(p.id)} />
            ))}
        </Group>
    );

    const mobile = (
        <Group heading={copy.p7}>
            {STORES.map((store) => (
                <Card
                    key={store.id}
                    href={store.href}
                    target="_blank"
                    label={store.label}
                    sublabel={store.id === 'android-apk' ? PAGE_PROSE.downloadBadges.p6 : store.sublabel}
                    chip={hint.kind === 'handheld' && store.id === hint.store ? copy.p10 : undefined}
                />
            ))}
        </Group>
    );

    return (
        <div ref={root} className="max-w-[760px]">
            {/* aria-live so the redirect announces itself; visually it is the
                line that explains why a .dmg just appeared in the tray — bold
                and a step larger when the auto-download fires, so it reads as
                the page's answer rather than a footnote. min-h covers the
                larger variant so the swap never moves the grid below. */}
            <p
                className={`min-h-[27px] leading-[1.6] ${redirecting ? 'text-[16.5px] font-semibold' : 'text-[15px]'}`}
                role="status"
                aria-live="polite"
                style={{ color: 'var(--fg)' }}
            >
                {redirecting
                    ? copy.p11.replace('{label}', redirecting.label).replace('{sublabel}', redirecting.sublabel)
                    : hint.kind === 'pick-your-mac'
                      ? copy.p12
                      : hint.kind === 'handheld'
                        ? copy.p13
                        : ''}
            </p>

            <div className="mt-5 space-y-8">
                {hint.kind === 'handheld' ? (
                    <>
                        {mobile}
                        {desktop}
                    </>
                ) : (
                    <>
                        {desktop}
                        {mobile}
                    </>
                )}
            </div>

            <p className="mt-6 text-[13.5px] leading-[1.6]" style={{ color: 'var(--muted)' }}>
                <a
                    href={LINUX_APPIMAGE_REQUIREMENTS_URL}
                    className="underline underline-offset-2"
                    style={{ color: 'var(--fg)' }}
                >{PAGE_PROSE.downloadBadges.p12}</a>
                {' · '}
                {rich(copy.p14, { 1: (children) => <a
                    href={DESKTOP_RELEASES_PAGE}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                    style={{ color: 'var(--fg)' }}
                >{children}</a> })}
            </p>
        </div>
    );
}
