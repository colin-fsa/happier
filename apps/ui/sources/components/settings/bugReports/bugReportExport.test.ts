import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  deleteError: null as Error | null,
  share: vi.fn(async (_uri: string, _options?: { mimeType?: string; dialogTitle?: string; UTI?: string }) => {}),
  available: vi.fn(async () => true),
  androidShare: vi.fn(async (_uri: string, _name: string, _title?: string) => {}),
}));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
// Genuine Expo filesystem boundary: the real cache writer and serialization run beneath it.
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    const fixture = createExpoFileSystemMock({ onDelete: () => { if (sdk.deleteError) throw sdk.deleteError; } });
    sdk.files = fixture.files;
    return fixture.module;
});
vi.mock('expo-sharing', () => ({ shareAsync: sdk.share, isAvailableAsync: sdk.available }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({ shareFile: sdk.androidShare }) }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));
import { Platform } from 'react-native';
import { log } from '@/log';
import { exportBugReportDiagnosticsBundle } from './bugReportExport';

const input = {
  exportedAt: '2026-09-26T00:00:00.000Z',
  environment: { appVersion: '0.2.13', platform: 'ios', deploymentType: 'cloud' },
  artifacts: [{ filename: 'logs.txt', sourceKind: 'ui-mobile', contentType: 'text/plain', content: 'hello' }],
} satisfies Parameters<typeof exportBugReportDiagnosticsBundle>[0];
beforeEach(() => { log.clear(); sdk.deleteError = null; sdk.files.clear(); sdk.share.mockReset(); sdk.available.mockReset(); sdk.available.mockResolvedValue(true); sdk.androidShare.mockReset(); });

describe('exportBugReportDiagnosticsBundle', () => {
  it('retains serialized JSON in the trusted Android download root after chooser handoff', async () => {
    Platform.OS = 'android';
    let handedOffContents = '';
    sdk.androidShare.mockImplementation(async uri => { handedOffContents = sdk.files.get(uri) ?? ''; });
    await exportBugReportDiagnosticsBundle(input);
    const [uri, name, title] = sdk.androidShare.mock.calls[0] ?? [];
    expect(uri).toMatch(/^file:\/\/\/cache\/happier-downloads\/.+-happier-diagnostics-.+\.json$/);
    expect(name).toMatch(/^happier-diagnostics-.+\.json$/);
    expect(title).toBe('Save As');
    expect(JSON.parse(handedOffContents).schemaVersion).toBe(1);
    expect(handedOffContents).toContain('hello');
    expect(sdk.files.get(uri)).toBe(handedOffContents);
    expect(sdk.share).not.toHaveBeenCalled();
  });
  it('preserves iOS sharing options and removes the temporary JSON only after completion', async () => {
    Platform.OS = 'ios';
    let handedOffContents = '';
    sdk.share.mockImplementation(async uri => { handedOffContents = sdk.files.get(uri) ?? ''; });
    await exportBugReportDiagnosticsBundle(input);
    expect(sdk.share).toHaveBeenCalledWith(expect.stringContaining('/happier-downloads/'), {
      mimeType: 'application/json', dialogTitle: 'Save As', UTI: 'public.json',
    });
    expect(JSON.parse(handedOffContents).schemaVersion).toBe(1);
    expect(sdk.files.size).toBe(0);
  });
  it('removes ungranted bytes and reports an Android handoff failure', async () => {
    Platform.OS = 'android';
    sdk.androidShare.mockRejectedValue(new Error('no receiving activity'));
    await expect(exportBugReportDiagnosticsBundle(input)).rejects.toThrow('no receiving activity');
    expect(sdk.files.size).toBe(0);
  });
  it('keeps the SDK sharing failure observable when cache deletion also fails', async () => {
    Platform.OS = 'android';
    const shareFailure = new Error('Sharing boundary failure');
    const deleteFailure = new Error('Cache deletion boundary failure');
    sdk.androidShare.mockRejectedValue(shareFailure);
    sdk.deleteError = deleteFailure;
    await expect(exportBugReportDiagnosticsBundle(input)).rejects.toBe(deleteFailure);
    expect(log.getLogs().some(message => message.includes(shareFailure.message))).toBe(true);
    expect(log.getLogs().some(message => message.includes(deleteFailure.message))).toBe(true);
  });

});
