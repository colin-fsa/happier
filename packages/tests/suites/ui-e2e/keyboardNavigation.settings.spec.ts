import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import {
  KEYBOARD_NAVIGATION_DESKTOP_VIEWPORT,
  enableKeyboardShortcutsV2FromSettings,
  openKeyboardShortcutSettings,
} from '../../src/testkit/uiE2e/keyboard';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function createAccountIfNeeded(page: Page): Promise<void> {
  await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
}

test.describe('ui e2e: keyboard navigation settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('keyboard-navigation-settings-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(540_000);
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-keyboard-navigation-${run.runId}`,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('renders keyboard shortcut settings and toggles v1 controls', async ({ page }) => {
    test.setTimeout(180_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize(KEYBOARD_NAVIGATION_DESKTOP_VIEWPORT);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await createAccountIfNeeded(page);

    await openKeyboardShortcutSettings({ page, uiBaseUrl });

    await expect(page.getByTestId('settings-keyboard-shortcuts-enabled')).toHaveCount(1);
    await expect(page.getByTestId('settings-keyboard-shortcuts-single-key-enabled')).toHaveCount(1);
    await expect(page.getByTestId('settings-keyboard-shortcut-row-commandPalette.open')).toHaveCount(1);
    await expect(page.getByTestId('settings-keyboard-shortcut-reset-commandPalette.open')).toHaveCount(1);

    await enableKeyboardShortcutsV2FromSettings({ page, singleKey: true });
  });
});
