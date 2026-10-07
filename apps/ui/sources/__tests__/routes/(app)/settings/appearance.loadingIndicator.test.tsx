import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks, resetSessionSettingsEntryState } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
        loadingIndicatorStyle: 'wave',
    } as Record<string, unknown>,
}));

type MutableSettingHook = (key: string) => [unknown, (next: unknown) => void];

const createMutableSettingHook = (settingsState: Record<string, unknown>): MutableSettingHook => {
    return (key: string) => [
        Object.prototype.hasOwnProperty.call(settingsState, key) ? settingsState[key] : null,
        (next: unknown) => {
            settingsState[key] = next;
        },
    ];
};

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Appearance: { getColorScheme: () => 'light' },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: '#00f', orange: '#f90', indigo: '#6366f1' },
                    status: { connecting: '#09f' },
                },
            },
            runtime: {
                setAdaptiveThemes: vi.fn(),
                setTheme: vi.fn(),
                setRootViewBackgroundColor: vi.fn(),
            },
        });
    },
    textModule: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return {
            ...createTextModuleMock(),
            getLanguageNativeName: () => 'English',
            SUPPORTED_LANGUAGES: { en: true },
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        const mutableSetting = createMutableSettingHook(shared.settingsState);
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: mutableSetting as typeof import('@/sync/domains/state/storage')['useSettingMutable'],
                useLocalSettingMutable: mutableSetting as typeof import('@/sync/domains/state/storage')['useLocalSettingMutable'],
            },
        });
    },
    useDeviceType: 'desktop',
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('@/theme', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/theme')>();
    return {
        ...actual,
        darkTheme: {
            ...actual.darkTheme,
            colors: {
                ...actual.darkTheme.colors,
                groupped: { background: '#000' },
            },
        },
        lightTheme: {
            ...actual.lightTheme,
            colors: {
                ...actual.lightTheme.colors,
                groupped: { background: '#fff' },
            },
        },
    };
});

// Load the real screen once, after the shared boundary factories have their configuration. Its
// module graph belongs to test setup; the test's deadline measures rendering and selection.
const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
    shared.settingsState.loadingIndicatorStyle = 'wave';
    shared.settingsState.loadingIndicatorSpeed = 'normal';
    shared.settingsState.loadingIndicatorPause = 'short';
});

function findDropdown(screen: Awaited<ReturnType<typeof renderSettingsView>>, title: string): any {
    const dropdown = screen.findAllByType('DropdownMenu' as any).find((node: any) => node.props?.itemTrigger?.title === title);
    if (!dropdown) throw new Error(`Expected the ${title} dropdown`);
    return dropdown;
}

describe('Appearance settings loading indicator', () => {
    it('offers every loading indicator style with a live preview and saves the choice', async () => {
        const { LOADING_INDICATOR_STYLE_IDS } = await import('@/sync/domains/settings/registry/local/loadingIndicatorStyleSetting');
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen), {
            flushOptions: { cycles: 0 },
        });

        const dropdown = screen
            .findAllByType('DropdownMenu' as any)
            .find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.loadingIndicatorStyle');
        expect(dropdown).toBeTruthy();
        expect(dropdown?.props?.selectedId).toBe('wave');

        const items = dropdown?.props?.items ?? [];
        expect(items.map((item: any) => item.id)).toEqual([...LOADING_INDICATOR_STYLE_IDS]);
        for (const item of items) {
            expect(item.icon?.props?.styleId).toBe(item.id);
        }

        await act(async () => {
            dropdown!.props.onSelect('radar');
        });
        expect(shared.settingsState.loadingIndicatorStyle).toBe('radar');

        await act(async () => {
            dropdown!.props.onSelect('hWave');
        });
        expect(shared.settingsState.loadingIndicatorStyle).toBe('hWave');

        await act(async () => {
            dropdown!.props.onSelect('notAStyle');
        });
        expect(shared.settingsState.loadingIndicatorStyle).toBe('hWave');
    });

    it('chooses the speed and the pause between loops beside the style and saves them on this device', async () => {
        shared.settingsState.loadingIndicatorSpeed = 'normal';
        shared.settingsState.loadingIndicatorPause = 'short';
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen), {
            flushOptions: { cycles: 0 },
        });

        const speed = findDropdown(screen, 'settingsAppearance.loadingIndicatorSpeed');
        const pause = findDropdown(screen, 'settingsAppearance.loadingIndicatorPause');
        expect(speed.props.selectedId).toBe('normal');
        expect(speed.props.items.map((item: { id: string }) => item.id)).toEqual(['slow', 'normal', 'fast']);
        expect(pause.props.selectedId).toBe('short');
        expect(pause.props.items.map((item: { id: string }) => item.id)).toEqual(['none', 'short', 'long']);
        expect(speed.props.itemTrigger.itemProps.disabled).toBe(false);
        expect(pause.props.itemTrigger.itemProps.disabled).toBe(false);

        await act(async () => { speed.props.onSelect('fast'); });
        await act(async () => { pause.props.onSelect('long'); });
        expect(shared.settingsState.loadingIndicatorSpeed).toBe('fast');
        expect(shared.settingsState.loadingIndicatorPause).toBe('long');
    });

    it.each([
        ['radar', { speed: false, pause: true }],
        ['classicRing', { speed: true, pause: true }],
    ] as const)('says when the %s style ignores a timing choice instead of offering it', async (styleId, disabled) => {
        shared.settingsState.loadingIndicatorStyle = styleId;
        const screen = await renderSettingsView(React.createElement(AppearanceSettingsScreen), {
            flushOptions: { cycles: 0 },
        });

        const speed = findDropdown(screen, 'settingsAppearance.loadingIndicatorSpeed');
        const pause = findDropdown(screen, 'settingsAppearance.loadingIndicatorPause');
        expect(speed.props.itemTrigger.itemProps.disabled).toBe(disabled.speed);
        expect(pause.props.itemTrigger.itemProps.disabled).toBe(disabled.pause);
        // One reason per state: the ring's note sits on Speed and covers Pause too.
        expect([speed.props.itemTrigger.subtitle, pause.props.itemTrigger.subtitle]).toEqual(styleId === 'classicRing'
            ? ['settingsAppearance.loadingIndicatorSpeedUnavailable', 'settingsAppearance.loadingIndicatorPauseDescription']
            : ['settingsAppearance.loadingIndicatorSpeedDescription', 'settingsAppearance.loadingIndicatorPauseUnavailable']);
    });

    it('keeps the previews out of the accessibility tree, since the option title already names the style', async () => {
        const { LoadingIndicatorStylePreview } = await import('@/components/settings/appearance/LoadingIndicatorStylePreview');
        const screen = await renderSettingsView(React.createElement(LoadingIndicatorStylePreview, { styleId: 'radar' }), {
            flushOptions: { cycles: 0 },
        });

        const root = screen.findAllByType('View' as any)[0];
        expect(root?.props).toEqual(expect.objectContaining({
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        }));
    });
});
