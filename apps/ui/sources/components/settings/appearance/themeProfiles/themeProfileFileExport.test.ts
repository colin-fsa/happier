import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ files: new Map<string, string>(), share: vi.fn(async (_uri: string, _options?: { mimeType?: string; dialogTitle?: string }) => {}), androidShare: vi.fn(async (_uri: string, _name: string, _title?: string) => {}) }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// Genuine Expo file adapter; profile serialization, cache writing and share ownership stay real.
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    const fixture = createExpoFileSystemMock();
    sdk.files = fixture.files;
    return fixture.module;
});
vi.mock('expo-sharing', () => ({ shareAsync: sdk.share, isAvailableAsync: async () => true }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({ shareFile: sdk.androidShare }) }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));

import { Platform } from 'react-native';
import { exportThemeProfileToJson } from '@/theme/profiles/themeProfileImportExport';
import { getBuiltInThemeProfileDefinition } from '@/theme/profiles/builtInThemeProfiles';
import { downloadThemeJson } from './themeProfileFileExport';

beforeEach(() => { sdk.files.clear(); sdk.share.mockReset(); sdk.androidShare.mockReset(); });
const json = () => exportThemeProfileToJson(getBuiltInThemeProfileDefinition('premiumLight')!.profile, { mode: 'light', includeResolvedValues: true });

describe('theme profile file export', () => {
    it('hands real profile JSON to the Android owner with its title and retains granted bytes', async () => {
        Platform.OS = 'android';
        const contents = json();
        await downloadThemeJson('happier-theme-light.json', contents);
        const [uri, name, title] = sdk.androidShare.mock.calls[0] ?? [];
        expect(uri).toContain('/happier-downloads/');
        expect(name).toBe('happier-theme-light.json');
        expect(title).toBe('Export theme');
        expect(sdk.files.get(uri)).toBe(contents);
        expect(JSON.parse(contents).kind).toBe('happier.themeProfile');
        expect(sdk.share).not.toHaveBeenCalled();
    });
    it('shares exact JSON and cleans iOS temporary bytes after activity completion', async () => {
        Platform.OS = 'ios';
        const contents = json();
        let handedOff = '';
        sdk.share.mockImplementation(async uri => { handedOff = sdk.files.get(uri) ?? ''; });
        await downloadThemeJson('happier-theme-light.json', contents);
        expect(sdk.share).toHaveBeenCalledWith(expect.stringContaining('/happier-downloads/'), { mimeType: 'application/json', dialogTitle: 'Export theme' });
        expect(handedOff).toBe(contents);
        expect(sdk.files.size).toBe(0);
    });
});
