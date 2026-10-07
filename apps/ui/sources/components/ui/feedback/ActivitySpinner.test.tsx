import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) => options.web ?? options.default,
        },
    });
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: { secondary: 'theme-secondary-text' },
                accent: { indigo: 'accent-indigo', purple: 'accent-purple', orange: 'accent-orange' },
            },
        },
    });
});

const localSettingValues: Partial<LocalSettings> = {};

vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    const useLocalSetting = createUseLocalSettingMock();
    return {
        useLocalSetting: (key: keyof LocalSettings) => (key in localSettingValues ? localSettingValues[key] : useLocalSetting(key)),
    };
});

/** The page's `<style>` sink is the one DOM boundary the web spinner writes to outside React. */
type InjectedStyle = { id: string; textContent: string };
let injectedStyles: InjectedStyle[] = [];
let reducedMotionMatches = false;

beforeEach(() => {
    vi.resetModules();
    injectedStyles = [];
    reducedMotionMatches = false;
    for (const key of Object.keys(localSettingValues)) delete localSettingValues[key as keyof LocalSettings];
    vi.stubGlobal('document', {
        getElementById: (id: string) => injectedStyles.find((style) => style.id === id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
        head: { appendChild: (style: InjectedStyle) => { injectedStyles.push(style); } },
    });
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: reducedMotionMatches, addEventListener: () => {} }),
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function renderSpinner(props: Record<string, unknown>) {
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const screen = await renderScreen(<ActivitySpinner testID="spinner" {...props} />);
    const spinner = screen.findByTestId('spinner');
    if (!spinner) throw new Error('Expected the spinner to render');
    const strips = screen.findAllByType('span' as never);
    return { screen, spinner, strip: strips[0] as { props: Record<string, unknown> } | undefined };
}

function frameSheetFor(strip: { props: Record<string, unknown> } | undefined): string {
    const key = strip?.props['data-happier-activity-spinner'];
    if (typeof key !== 'string') throw new Error('Expected the strip to carry its frame-sheet key');
    const rule = injectedStyles.map((style) => style.textContent).find((css) => css.includes(`"${key}"`));
    if (!rule) throw new Error(`Expected a frame-sheet rule for ${key}`);
    const payload = rule.match(/data:image\/svg\+xml,([^")]+)/)?.[1];
    if (!payload) throw new Error('Expected the rule to embed its frame sheet');
    return decodeURIComponent(payload);
}

describe('ActivitySpinner (web)', () => {
    it.each(['wave', 'classicRing'] as const)('provides a localized accessible name for %s and preserves caller labels', async (variant) => {
        const { setPreferredLanguageFromSettings, t } = await import('@/text');
        setPreferredLanguageFromSettings('fr');
        try {
            const { ActivitySpinner } = await import('./ActivitySpinner');
            const { screen } = await renderSpinner({ variant });
            const host = screen.findHostByTestId('spinner')!;
            expect(host.props.accessibilityRole).toBe('progressbar');
            expect(host.props.accessibilityLabel).toBe(t('common.loading'));

            await screen.update(<ActivitySpinner testID="spinner" variant={variant} accessibilityLabel="Upload progress" />);
            expect(host.props.accessibilityLabel).toBe('Upload progress');
            await screen.update(<ActivitySpinner testID="spinner" variant={variant} accessibilityLabel="" />);
            expect(host.props.accessibilityLabel).toBe('');
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('draws the mark wave by default as a frame strip stepped by one transform animation', async () => {
        const { screen, spinner, strip } = await renderSpinner({ size: 12, color: 'red' });

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        const box = flattenStyle(spinner.props.style);
        expect(box.width).toBe(12);
        expect(box.height).toBe(12);
        expect(box.overflow).toBe('hidden');
        expect(box.borderTopColor).toBeUndefined();

        const stripStyle = flattenStyle(strip?.props.style);
        expect(stripStyle.animationName).toBe('happierActivitySpinnerFilmstrip');
        expect(stripStyle.animationDuration).toBe('1004ms');
        expect(stripStyle.animationTimingFunction).toBe('steps(30, end)');
        expect(stripStyle.width).toBe('3000%');
        expect(frameSheetFor(strip)).toContain('fill="red"');
        expect(frameSheetFor(strip).match(/<circle /g)).toHaveLength(30 * 8);
    });

    it('keeps the H wave in its own frame sheet and uses theme accents for H Aurora', async () => {
        const mark = await renderSpinner({});
        const h = await renderSpinner({ variant: 'hWave' });
        expect(frameSheetFor(h.strip).match(/<circle /g)).toHaveLength(30 * 7);
        expect(h.strip?.props['data-happier-activity-spinner']).not.toBe(mark.strip?.props['data-happier-activity-spinner']);
        const aurora = await renderSpinner({ variant: 'hAurora' });
        expect(frameSheetFor(aurora.strip)).toContain('fill="accent-indigo"');
    });

    it('shares one frame sheet between every spinner drawn in the same style and ink', async () => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(
            <>
                <ActivitySpinner size={12} />
                <ActivitySpinner size={20} />
                <ActivitySpinner size={20} color="red" />
            </>,
        );

        const keys = screen.findAllByType('span' as never).map((node) => (node.props as Record<string, unknown>)['data-happier-activity-spinner']);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[0]);
        expect(injectedStyles).toHaveLength(2);
    });

    it('keeps distinct valid CSS inks in separate frame sheets', async () => {
        const first = await renderSpinner({ color: '#00018f' });
        const second = await renderSpinner({ color: '#0002d9' });

        expect(frameSheetFor(first.strip)).toContain('fill="#00018f"');
        expect(frameSheetFor(second.strip)).toContain('fill="#0002d9"');
        expect(injectedStyles).toHaveLength(2);
    });

    it('builds the frame sheet only when absent, and recovers a removed sheet on the next mount', async () => {
        const { DotSpinnerWeb } = await import('./activitySpinner/DotSpinnerWeb');
        // Observe the real renderer through its ink input: building the SVG reads color for its
        // dots, while a cached mount needs only the one read that identifies the ink.
        let colorReads = 0;
        const ink = { get color() { colorReads += 1; return 'red'; } };
        const mount = (size: number) => renderScreen(
            <DotSpinnerWeb styleId="wave" timing={{ speed: 'normal', pause: 'short' }} size={size} ink={ink} motion="animate" viewProps={{}} />,
        );
        await mount(12);
        expect(colorReads).toBeGreaterThan(1);
        const readsAfterBuild = colorReads;
        const originalSheet = injectedStyles[0]!.textContent;

        await mount(20);
        expect(colorReads - readsAfterBuild).toBe(1);
        expect(injectedStyles).toHaveLength(1);

        injectedStyles = [];
        const readsBeforeRecovery = colorReads;
        await mount(16);
        expect(colorReads - readsBeforeRecovery).toBeGreaterThan(1);
        expect(injectedStyles).toHaveLength(1);
        expect(injectedStyles[0]!.textContent).toBe(originalSheet);
    });

    it('draws the style chosen in settings', async () => {
        localSettingValues.loadingIndicatorStyle = 'slowBreath';
        const { strip } = await renderSpinner({ size: 16 });

        expect(flattenStyle(strip?.props.style).animationDuration).toBe('2400ms');
    });

    it('lets a caller preview a specific style regardless of the setting', async () => {
        localSettingValues.loadingIndicatorStyle = 'slowBreath';
        const { strip } = await renderSpinner({ size: 16, variant: 'radar' });

        expect(flattenStyle(strip?.props.style).animationDuration).toBe('1100ms');
    });

    it('falls back to the wave when the stored style is not one it knows', async () => {
        localSettingValues.loadingIndicatorStyle = 'retiredStyle' as never;
        const { strip } = await renderSpinner({ size: 16 });

        expect(flattenStyle(strip?.props.style).animationDuration).toBe('1004ms');
    });

    it('plays at the speed and pause chosen in settings, and previews follow them', async () => {
        localSettingValues.loadingIndicatorSpeed = 'fast';
        localSettingValues.loadingIndicatorPause = 'long';
        const wave = await renderSpinner({ size: 16 });
        // 804 ms of motion at 1.5×, then the 500 ms pause.
        expect(flattenStyle(wave.strip?.props.style).animationDuration).toBe('1036ms');

        // A continuous style takes the speed but has no pause to lengthen.
        const radar = await renderSpinner({ size: 16, variant: 'radar' });
        expect(flattenStyle(radar.strip?.props.style).animationDuration).toBe('733ms');
    });

    it('plays unknown stored speeds and pauses at the defaults', async () => {
        localSettingValues.loadingIndicatorSpeed = 'warp' as never;
        localSettingValues.loadingIndicatorPause = 'forever' as never;
        const { strip } = await renderSpinner({ size: 16 });

        expect(flattenStyle(strip?.props.style).animationDuration).toBe('1004ms');
    });

    it('colors aurora with the theme accents, but an explicit color wins so the mark stays legible on tinted buttons', async () => {
        localSettingValues.loadingIndicatorStyle = 'aurora';
        const themed = await renderSpinner({ size: 16 });
        const themedRule = frameSheetFor(themed.strip);
        expect(themedRule).toContain('fill="accent-indigo"');
        expect(themedRule).toContain('fill="accent-orange"');

        const explicit = await renderSpinner({ size: 16, color: 'white' });
        const explicitRule = frameSheetFor(explicit.strip);
        expect(explicitRule).toContain('fill="white"');
        expect(explicitRule).not.toContain('accent-indigo');
    });

    it('keeps the classic ring for people who choose it', async () => {
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner, strip } = await renderSpinner({ size: 12, color: 'red' });

        const style = flattenStyle(spinner.props.style);
        expect(strip).toBeUndefined();
        expect(style.animationName).toBe('happierActivitySpinnerSpin');
        expect(style.animationTimingFunction).toBe('steps(6, end)');
        expect(style.width).toBe(12);
        expect(style.borderColor).toBe('red');
    });

    it('uses the theme secondary text color and self-centers when no color is provided', async () => {
        const { spinner, strip } = await renderSpinner({ size: 'small' });

        expect(flattenStyle(spinner.props.style).alignSelf).toBe('center');
        expect(flattenStyle(spinner.props.style).width).toBe(20);
        expect(frameSheetFor(strip)).toContain('fill="theme-secondary-text"');
    });

    it('holds a still, fully drawn mark without scheduling any animation when ambient motion is paused', async () => {
        const { spinner, strip } = await renderSpinner({ size: 12, animationEnabled: false });

        expect(flattenStyle(spinner.props.style).animationName).toBeUndefined();
        expect(flattenStyle(strip?.props.style).animationName).toBeUndefined();
        expect(flattenStyle(spinner.props.style).opacity).not.toBe(0);
        expect(frameSheetFor(strip)).toContain('fill-opacity="0.85"');
    });

    it('drops every animation while the page is hidden, so an unseen tab never keeps a spinner moving', async () => {
        vi.stubGlobal('document', { ...globalThis.document, visibilityState: 'hidden' });
        const dots = await renderSpinner({ size: 12 });
        expect(flattenStyle(dots.strip?.props.style).animationName).toBeUndefined();

        reducedMotionMatches = true;
        const breathing = await renderSpinner({ size: 12 });
        expect(flattenStyle(breathing.spinner.props.style).animationName).toBeUndefined();

        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const ring = await renderSpinner({ size: 12 });
        expect(flattenStyle(ring.spinner.props.style).animationName).toBeUndefined();
    });

    it('replaces the travelling light with a slow breath of the still chosen mark under reduced motion', async () => {
        reducedMotionMatches = true;
        const { spinner, strip } = await renderSpinner({ size: 12 });

        expect(flattenStyle(strip?.props.style).animationName).toBeUndefined();
        expect(flattenStyle(spinner.props.style).animationName).toBe('happierActivitySpinnerBreath');
        expect(frameSheetFor(strip)).toContain('fill-opacity="0.85"');
    });

    it('stops turning the classic ring under reduced motion', async () => {
        reducedMotionMatches = true;
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner } = await renderSpinner({ size: 12 });

        expect(flattenStyle(spinner.props.style).animationName).toBeUndefined();
    });

    it.each([false, true])('keeps an explicitly stopped classic ring visible without animating (reduced motion: %s)', async (reduceMotion) => {
        reducedMotionMatches = reduceMotion;
        localSettingValues.loadingIndicatorStyle = 'classicRing';
        const { spinner, strip } = await renderSpinner({ animating: false, hidesWhenStopped: false });

        expect(strip).toBeUndefined();
        const style = flattenStyle(spinner.props.style);
        expect(style.animationName).toBeUndefined();
        expect(style.animationIterationCount).toBeUndefined();
        expect(style.opacity).toBe(1);
    });

    it.each(['wave', 'classicRing'] as const)('renders nothing when stopped and hidden with %s', async (variant) => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(<ActivitySpinner testID="spinner" variant={variant} animating={false} />);

        expect(screen.findAllByType('View' as never)).toHaveLength(0);
        expect(screen.findAllByType('span' as never)).toHaveLength(0);
    });
});
