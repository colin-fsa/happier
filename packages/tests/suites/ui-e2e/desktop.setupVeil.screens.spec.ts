import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { gotoDomContentLoadedWithPathFallback, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { installFakeTauriDesktopBridge } from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { attachDesktopSystemTaskHost, createDesktopSystemTaskHost } from '../../src/testkit/uiE2e/desktopSetup/desktopSystemTaskHost';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';

/**
 * R11 visual QA of the desktop setup surface: the real app on the fake Tauri shell, its system
 * tasks answered by a scripted hsetup (`scriptedHsetup.mjs`, driven by a scenario file), so every
 * state is the real lifecycle presenting real facts over the real Home. Desktop width, light and
 * dark. Screenshots land in `HAPPIER_E2E_SETUP_SCREENS_DIR` (default: the run dir).
 */
const run = createRunDirs({ runLabel: 'ui-e2e' });
const screensDir = resolve(process.env.HAPPIER_E2E_SETUP_SCREENS_DIR ?? run.testDir('setup-screens'));
const scriptedHsetup = join(dirname(fileURLToPath(import.meta.url)), '../../src/testkit/uiE2e/desktopSetup/scriptedHsetup.mjs');

type Scenario = Readonly<{ relayUrl: string; status: 'hold' | 'unconfigured' | 'otherAccount'; setup: 'hold' | 'fail' }>;

test.describe('ui e2e: desktop setup veil screens (R11)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('setup-screens-suite');
    const scenarioFile = join(suiteDir, 'scenario.json');
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    const setScenario = async (scenario: Omit<Scenario, 'relayUrl'>) => {
        if (!server) throw new Error('missing server');
        await writeFile(scenarioFile, JSON.stringify({ relayUrl: server.baseUrl, ...scenario }));
    };

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-setup-screens-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'metro',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
        };
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });
        await mkdir(screensDir, { recursive: true });
        server = await startServerLight({ testDir: suiteDir, dbProvider: 'sqlite' });
        ui = await startUiWeb({ testDir: suiteDir, env: { ...uiWebEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl } });
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    async function openDesktop(browser: Browser, theme: 'light' | 'dark'): Promise<Page> {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
        const page = await context.newPage();
        await installFakeTauriDesktopBridge(page, { state: { platform: 'linux', strategy: 'custom-controls' } });
        await attachDesktopSystemTaskHost(page, (emit) => createDesktopSystemTaskHost({
            launch: { command: process.execPath, args: [scriptedHsetup], env: { ...process.env, HAPPIER_E2E_SETUP_SCENARIO_FILE: scenarioFile } },
            emit,
            logPath: join(suiteDir, `system-tasks-${theme}.log`),
        }));
        return page;
    }

    async function shot(page: Page, name: string): Promise<void> {
        // Past the entrance stagger and the status settle.
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(screensDir, `${name}.png`), fullPage: false });
    }

    for (const theme of ['light', 'dark'] as const) {
        test(`every setup state over the Home, desktop width, ${theme}`, async ({ browser }) => {
            test.setTimeout(180_000);
            if (!uiBaseUrl) throw new Error('missing ui base url');

            // 1. First run: signed in just now, facts still being read.
            await setScenario({ status: 'hold', setup: 'hold' });
            const page = await openDesktop(browser, theme);
            await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/`, '/', 180_000);
            await waitForInitialAppUi({ page, timeoutMs: 180_000 });
            const continueToAuth = page.getByTestId('setup.continueToAuth');
            if ((await continueToAuth.count()) > 0) {
                await expect(continueToAuth).toBeEnabled({ timeout: 120_000 });
                await continueToAuth.click();
            }
            await ensureAccountReadyForConnect({ page, timeoutMs: 180_000 });
            await expect(page.getByTestId('desktop-setup-panel:veil')).toBeVisible({ timeout: 120_000 });
            await expect(page.getByTestId('desktop-setup-panel:checking')).toBeVisible({ timeout: 60_000 });
            await shot(page, `${theme}-desktop-1-checking`);

            // 2. Setup running.
            await setScenario({ status: 'unconfigured', setup: 'hold' });
            await page.reload();
            await expect(page.getByTestId('desktop-setup-panel:working')).toBeVisible({ timeout: 180_000 });
            await shot(page, `${theme}-desktop-2-progress`);

            // 3. Setup stopped: the honest sentence, Retry, Continue without, Details.
            await setScenario({ status: 'unconfigured', setup: 'fail' });
            await page.reload();
            await expect(page.getByTestId('desktop-setup-panel:blocked')).toBeVisible({ timeout: 180_000 });
            await expect(page.getByTestId('desktop-setup-panel:retry')).toBeVisible();
            const headline = page.getByTestId('desktop-setup-panel:status');
            await expect(headline).toContainText('Installing the background service');
            await expect(headline).not.toContainText('reading');
            await shot(page, `${theme}-desktop-3-blocked`);
            await page.getByTestId('desktop-setup-panel:details').click();
            const failedStep = await page.getByTestId('system-task-step-label').innerText();
            await expect(headline).toContainText(failedStep);
            await expect(page.getByTestId('desktop-setup-panel:diagnostic')).toHaveText('Access is denied.');
            await shot(page, `${theme}-desktop-4-blocked-details`);

            // The rest of the app stays usable beside it: the sidebar still navigates.
            await page.getByTestId('desktop-setup-panel:continue-without').click();
            await expect(page.getByTestId('desktop-setup-panel:veil')).toHaveCount(0, { timeout: 30_000 });
            await shot(page, `${theme}-desktop-5-continued-without`);

            // 4. This computer is signed in as someone else: the account question over the veil.
            await setScenario({ status: 'otherAccount', setup: 'hold' });
            await page.reload();
            await expect(page.getByText(/sam/).first()).toBeVisible({ timeout: 180_000 });
            await shot(page, `${theme}-desktop-6-account-consent`);
            await page.context().close();
        });
    }
});
