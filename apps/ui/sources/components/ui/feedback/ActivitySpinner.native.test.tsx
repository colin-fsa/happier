import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { ActivityIndicatorProps } from 'react-native';

/**
 * `animationEnabled` shipped as a web-only branch, and the native path spread the whole prop bag
 * into `ActivityIndicator`. So every call site that threaded the flag to pause ambient motion
 * paused nothing at all on iOS or Android — the spinner kept turning and an unknown prop went to
 * the platform component. A pause flag that silently does nothing on two of three platforms is
 * worse than no flag: it makes the corridor *look* gated.
 */

const reducedMotionBoundary = vi.hoisted(() => ({
    listener: null as ((enabled: boolean) => void) | null,
}));
const nativeBoundary = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    const React = await import('react');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { get OS() { return nativeBoundary.os; } },
        View: 'View',
        // RN 0.81 Android ProgressBarContainerView.apply() hides every animating=false widget;
        // hidesWhenStopped is iOS-only. Observe that OS output, rather than just incoming props.
        ActivityIndicator: (props: ActivityIndicatorProps) => {
            const [nativeInstance] = React.useState(() => Symbol('native-widget'));
            return React.createElement('ActivityIndicator', {
                ...props,
                nativeInstance,
                nativeVisibility: nativeBoundary.os === 'android' && props.animating === false ? 'invisible' : 'visible',
            });
        },
        AccessibilityInfo: {
            isReduceMotionEnabled: async () => false,
            addEventListener: (_event: string, listener: (enabled: boolean) => void) => {
                reducedMotionBoundary.listener = listener;
                return { remove: () => { reducedMotionBoundary.listener = null; } };
            },
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

beforeEach(() => {
    nativeBoundary.os = 'ios';
    for (const key of Object.keys(localSettingValues)) delete localSettingValues[key as keyof LocalSettings];
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, item) => Object.assign(acc, flattenStyle(item)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function renderClassicSpinner(props: Record<string, unknown>) {
    localSettingValues.loadingIndicatorStyle = 'classicRing';
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const screen = await renderScreen(<ActivitySpinner testID="spinner" size={16} {...props} />);
    mountedScreens.push(screen);
    const nodes = screen.findAllByType('ActivityIndicator' as never);
    expect(nodes.length).toBe(1);
    return nodes[0]!.props as Record<string, unknown>;
}

type MountedScreen = Awaited<ReturnType<typeof renderScreen>>;
const mountedScreens: MountedScreen[] = [];

/** The shared clocks live at module level, so every test leaves nothing mounted behind it. */
async function unmountAll() {
    for (const screen of mountedScreens.splice(0)) await screen.unmount();
}

afterEach(unmountAll);

type InterpolationStub = { parent: unknown; config: { inputRange: number[]; outputRange: (number | string)[] } };

function findDots(screen: MountedScreen) {
    return screen.findAllByType('Animated.View' as never).filter((node) => (node.props as { testID?: string }).testID === 'activity-spinner-dot');
}

async function runningNativeLoops(): Promise<number> {
    const { animatedLoops } = await import('@/dev/reactNativeStub');
    return animatedLoops.size;
}

async function renderDotSpinner(props: Record<string, unknown>) {
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const screen = await renderScreen(<ActivitySpinner testID="spinner" size={18} {...props} />);
    mountedScreens.push(screen);
    return { screen, dots: findDots(screen), running: await runningNativeLoops() };
}

describe('ActivitySpinner (native)', () => {
    it('keeps the seven-dot H selectable while sharing the mark wave clock', async () => {
        const mark = await renderDotSpinner({});
        const h = await renderDotSpinner({ variant: 'hWave' });
        expect(mark.dots).toHaveLength(8);
        expect(h.dots).toHaveLength(7);
        expect(await runningNativeLoops()).toBe(1);
    });

    it('draws the mark with eight dots whose brightness the native driver reads from the frame table', async () => {
        const { getDotSpinnerFrames, readDotSeries } = await import('./activitySpinner/dotSpinnerFrames');
        const { screen, dots, running } = await renderDotSpinner({});
        const { t } = await import('@/text');
        expect(screen.findHostByTestId('spinner')!.props.accessibilityLabel).toBe(t('common.loading'));

        expect(screen.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
        expect(dots).toHaveLength(8);
        expect(running).toBe(1);
        const firstDot = flattenStyle(dots[0]!.props.style);
        expect(firstDot.backgroundColor).toBe('theme-secondary-text');
        expect(firstDot.width).toBe(3);

        const frames = getDotSpinnerFrames('wave', { speed: 'normal', pause: 'short' });
        const series = readDotSeries(frames, frames.opacity, 0);
        const opacity = firstDot.opacity as InterpolationStub;
        expect(opacity.config.outputRange).toEqual([...series, series[0]]);
        expect(opacity.config.inputRange[0]).toBe(0);
        expect(opacity.config.inputRange.at(-1)).toBe(1);
    });

    it('runs each speed and pause on the shared clock for its own played cycle', async () => {
        localSettingValues.loadingIndicatorSpeed = 'fast';
        localSettingValues.loadingIndicatorPause = 'long';
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const fast = await renderScreen(<><ActivitySpinner size={18} /><ActivitySpinner size={12} /></>);
        mountedScreens.push(fast);
        expect(await runningNativeLoops()).toBe(1);

        localSettingValues.loadingIndicatorSpeed = 'slow';
        const slow = await renderScreen(<ActivitySpinner size={18} />);
        mountedScreens.push(slow);
        expect(await runningNativeLoops()).toBe(2);
    });

    it('drives every spinner of a style from one shared native loop and stops it when the last one leaves', async () => {
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const screen = await renderScreen(
            <>
                <ActivitySpinner size={18} />
                <ActivitySpinner size={12} />
            </>,
        );
        mountedScreens.push(screen);

        expect(findDots(screen)).toHaveLength(16);
        expect(await runningNativeLoops()).toBe(1);

        await unmountAll();
        expect(await runningNativeLoops()).toBe(0);
    });

    it('runs no loop and holds the full mark when ambient motion is paused', async () => {
        const { dots, running } = await renderDotSpinner({ animationEnabled: false });

        expect(running).toBe(0);
        expect(dots.map((dot) => flattenStyle(dot.props.style).opacity)).toEqual(Array(8).fill(0.85));
    });

    it('releases its loop while the app is in the background and takes it back on return', async () => {
        const { AppState } = await import('react-native');
        const { act } = await import('react-test-renderer');
        const { createReactNativeAppStateEmitter } = await import('@/dev/testkit');
        const appState = createReactNativeAppStateEmitter();
        const restoreAppState = appState.install(AppState);
        try {
            await renderDotSpinner({});
            expect(await runningNativeLoops()).toBe(1);

            await act(async () => appState.emit('background'));
            expect(await runningNativeLoops()).toBe(0);

            await act(async () => appState.emit('active'));
            expect(await runningNativeLoops()).toBe(1);
        } finally {
            restoreAppState();
        }
    });

    it.each([
        { os: 'android', variant: 'classicRing' },
        { os: 'android', variant: 'wave' },
        { os: 'ios', variant: 'classicRing' },
        { os: 'ios', variant: 'wave' },
    ] as const)('hides the stopped $os $variant placeholder from accessibility and restores caller flags on resume', async ({ os, variant }) => {
        nativeBoundary.os = os;
        const { ActivitySpinner } = await import('./ActivitySpinner');
        const props = {
            variant,
            testID: 'spinner',
            size: 18,
            accessible: true,
            accessibilityElementsHidden: false,
            importantForAccessibility: 'yes' as const,
        };
        const screen = await renderScreen(<ActivitySpinner {...props} />);
        mountedScreens.push(screen);
        const host = screen.findHostByTestId('spinner')!;
        const callerFlags = { accessible: true, accessibilityElementsHidden: false, importantForAccessibility: 'yes' };
        expect(host.props).toMatchObject(callerFlags);

        await screen.update(<ActivitySpinner {...props} animating={false} />);
        expect(screen.findHostByTestId('spinner')).toBe(host);
        expect(host.props).toMatchObject({
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        if (variant === 'wave') {
            expect(findDots(screen)).toHaveLength(0);
            expect(await runningNativeLoops()).toBe(0);
        }
        await screen.update(<ActivitySpinner {...props} animating={false} hidesWhenStopped={true} />);
        expect(host.props).toMatchObject({ accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' });

        await screen.update(<ActivitySpinner {...props} animationEnabled={false} />);
        expect(host.props).toMatchObject(callerFlags);
        await screen.update(<ActivitySpinner {...props} />);
        expect(host.props).toMatchObject(callerFlags);
        await screen.update(<ActivitySpinner {...props} animating={false} hidesWhenStopped={false} />);
        expect(host.props).toMatchObject(callerFlags);
    });

    it('animates aurora colour on the native driver too, through the theme accents', async () => {
        const { dots } = await renderDotSpinner({ variant: 'aurora' });

        const color = flattenStyle(dots[0]!.props.style).backgroundColor as InterpolationStub;
        // Clock -> unwrapped hue -> accent gradient: both steps are interpolations, so no JS runs per frame.
        expect((color.parent as InterpolationStub).config.inputRange[0]).toBe(0);
        expect(color.config.outputRange).toEqual(expect.arrayContaining(['accent-indigo', 'accent-purple', 'accent-orange']));
    });

    it('breathes the still mark from one shared loop under reduced motion', async () => {
        const { DotSpinnerNative } = await import('./activitySpinner/DotSpinnerNative');
        const screen = await renderScreen(
            <DotSpinnerNative styleId="wave" timing={{ speed: 'normal', pause: 'short' }} size={18} ink={{ color: 'ink' }} motion="breathe" hidden={false} viewProps={{ testID: 'spinner' }} />,
        );
        mountedScreens.push(screen);

        expect(await runningNativeLoops()).toBe(1);
        expect(findDots(screen).map((dot) => flattenStyle(dot.props.style).opacity)).toEqual(Array(8).fill(0.85));
        const layer = screen.findAllByType('Animated.View' as never).find((node) => (node.props as { testID?: string }).testID === 'spinner');
        expect((flattenStyle(layer!.props.style).opacity as InterpolationStub).config.outputRange).toEqual([1, 0.45]);
    });

    describe('classic ring', () => {
        it.each([
            { pause: 'ambient', size: 'small', expectedSize: 20 },
            { pause: 'reduced motion', size: 'large', expectedSize: 36 },
            { pause: 'explicit stop', size: 16, expectedSize: 16 },
        ] as const)('preserves the Android widget and visible mark through $pause and resume', async ({ pause, size, expectedSize }) => {
            nativeBoundary.os = 'android';
            localSettingValues.loadingIndicatorStyle = 'classicRing';
            const { ActivitySpinner } = await import('./ActivitySpinner');
            const { act } = await import('react-test-renderer');
            const props = {
                testID: 'spinner',
                accessibilityLabel: 'Working',
                size,
                color: '#2468ab',
                style: { marginLeft: 7 },
            };
            const screen = await renderScreen(<ActivitySpinner {...props} />);
            mountedScreens.push(screen);
            const originalWidget = screen.findAllByType('ActivityIndicator' as never)[0]!;
            const nativeInstance = originalWidget.props.nativeInstance;
            expect(originalWidget.props.nativeVisibility).toBe('visible');
            try {
                if (pause === 'reduced motion') {
                    await act(async () => reducedMotionBoundary.listener?.(true));
                } else {
                    await screen.update(<ActivitySpinner {...props}
                        animationEnabled={pause !== 'ambient'}
                        {...(pause === 'explicit stop' ? { animating: false, hidesWhenStopped: false } : {})}
                    />);
                }
                const nativeWidgets = screen.findAllByType('ActivityIndicator' as never);
                expect(nativeWidgets).toHaveLength(1);
                expect(nativeWidgets[0]!.props).toMatchObject({ nativeInstance, nativeVisibility: 'invisible', animating: false, color: '#2468ab', size });
                const rings = screen.findAllByType('View' as never).filter((node) => flattenStyle(node.props.style).borderWidth);
                expect(rings).toHaveLength(1);
                const ring = rings[0]!;
                expect(flattenStyle(ring.props.style)).toMatchObject({ width: expectedSize, height: expectedSize, borderColor: '#2468ab', opacity: 1 });
                expect(flattenStyle(ring.props.style)).not.toHaveProperty('animationName');
                expect(ring.props.pointerEvents).toBe('none');
                const host = screen.findHostByTestId('spinner')!;
                expect(host.props).toMatchObject({ accessibilityRole: 'progressbar', accessibilityLabel: 'Working' });
                expect(flattenStyle(host.props.style)).toMatchObject({ marginLeft: 7 });
                expect(flattenStyle(host.props.style)).not.toHaveProperty('width');
                expect(flattenStyle(host.props.style)).not.toHaveProperty('height');
                expect(screen.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'progressbar')).toHaveLength(1);
                expect(nativeWidgets[0]!.props.accessible).toBe(false);
                expect(ring.props.accessible).toBe(false);

                if (pause === 'reduced motion') await act(async () => reducedMotionBoundary.listener?.(false));
                await screen.update(<ActivitySpinner {...props} />);
                const resumedWidget = screen.findAllByType('ActivityIndicator' as never)[0]!;
                expect(resumedWidget.props).toMatchObject({ nativeInstance, nativeVisibility: 'visible' });
                expect(flattenStyle(ring.props.style).opacity).toBe(0);

                await screen.update(<ActivitySpinner {...props} animating={false} />);
                expect(screen.findAllByType('ActivityIndicator' as never)[0]!.props).toMatchObject({ nativeInstance, nativeVisibility: 'invisible' });
                expect(flattenStyle(ring.props.style).opacity).toBe(0);
                await screen.update(<ActivitySpinner {...props} animating={false} hidesWhenStopped={true} />);
                expect(screen.findAllByType('ActivityIndicator' as never)[0]!.props.nativeInstance).toBe(nativeInstance);
                expect(flattenStyle(ring.props.style).opacity).toBe(0);
                await screen.update(<ActivitySpinner {...props} animating={false} hidesWhenStopped={false} />);
                expect(screen.findAllByType('ActivityIndicator' as never)[0]!.props.nativeInstance).toBe(nativeInstance);
                expect(flattenStyle(ring.props.style).opacity).toBe(1);
            } finally {
                if (pause === 'reduced motion') await act(async () => reducedMotionBoundary.listener?.(false));
            }
        });

        it('keeps Android caller layout, native colour, and accessibility overrides on the host', async () => {
            nativeBoundary.os = 'android';
            const { ActivitySpinner } = await import('./ActivitySpinner');
            // RN's Android PlatformColor boundary supplies an opaque resource_paths payload.
            const nativeColor = { resource_paths: ['?attr/colorAccent'] } as unknown as NonNullable<ActivityIndicatorProps['color']>;
            const screen = await renderScreen(<ActivitySpinner
                variant="classicRing"
                testID="spinner"
                size="large"
                color={nativeColor}
                style={{ width: 48, height: 48, opacity: 0.5 }}
                accessibilityRole="image"
                accessibilityLabel="Working"
                accessible={false}
                animationEnabled={false}
            />);
            mountedScreens.push(screen);
            const host = screen.findHostByTestId('spinner')!;
            expect(host.props).toMatchObject({ accessibilityRole: 'image', accessibilityLabel: 'Working', accessible: false });
            expect(flattenStyle(host.props.style)).toMatchObject({ width: 48, height: 48, opacity: 0.5 });
            const widget = screen.findAllByType('ActivityIndicator' as never)[0]!;
            expect(widget.props.color).toBe(nativeColor);
            expect(widget.props.size).toBe('large');
            expect(widget.props.importantForAccessibility).toBe('no-hide-descendants');
            const ring = screen.findAllByType('View' as never).find((node) => flattenStyle(node.props.style).borderWidth)!;
            expect(flattenStyle(ring.props.style).borderColor).toBe(nativeColor);
            expect(ring.props.importantForAccessibility).toBe('no-hide-descendants');
        });

        it('animates by default and never hands the platform component an unknown prop', async () => {
            const props = await renderClassicSpinner({});
            const { t } = await import('@/text');
            expect(props.accessibilityLabel).toBe(t('common.loading'));

            expect(props.animating).toBeUndefined();
            expect(props).not.toHaveProperty('animationEnabled');
            expect(props).not.toHaveProperty('variant');
        });

        it('actually stops the native spinner when ambient motion is paused, and keeps it visible', async () => {
            const props = await renderClassicSpinner({ animationEnabled: false });

            // Stopped, not hidden: `hidesWhenStopped` defaults to true, so pausing without this would
            // make the running mark vanish — the row would read as "no longer working".
            expect(props.animating).toBe(false);
            expect(props.hidesWhenStopped).toBe(false);
            expect(props).not.toHaveProperty('animationEnabled');
        });

        it('preserves explicit stopped visibility under reduced motion and ambient pause', async () => {
            const { act } = await import('react-test-renderer');
            await renderClassicSpinner({});
            try {
                await act(async () => reducedMotionBoundary.listener?.(true));
                const running = await renderClassicSpinner({});
                expect(running.animating).toBe(false);
                expect(running.hidesWhenStopped).toBe(false);

                const hidden = await renderClassicSpinner({ animating: false, animationEnabled: false });
                expect(hidden.animating).toBe(false);
                expect(hidden.hidesWhenStopped).toBeUndefined();
                const explicitlyHidden = await renderClassicSpinner({ animating: false, hidesWhenStopped: true });
                expect(explicitlyHidden.hidesWhenStopped).toBe(true);
                const visible = await renderClassicSpinner({ animating: false, hidesWhenStopped: false });
                expect(visible.hidesWhenStopped).toBe(false);
            } finally {
                await act(async () => reducedMotionBoundary.listener?.(false));
            }
        });

        it('leaves an explicitly stopped spinner alone, so hiding it stays the caller\'s decision', async () => {
            const props = await renderClassicSpinner({ animating: false });

            expect(props.animating).toBe(false);
            expect(props.hidesWhenStopped).toBeUndefined();
        });
    });
});
