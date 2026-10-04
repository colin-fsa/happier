import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function installFirstLaunchOverlayBypass(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem('mmkv.default\\onboarding-showcase-seen-version', 'v4');
    });
}

async function dismissBlockingStoryDeckIfPresent(page: Page): Promise<void> {
    const candidates = [
        page.getByRole('button', { name: "Let's go!" }).first(),
        page.getByText("Let's go!", { exact: true }).last(),
        page.getByTestId('onboarding-showcase-primary').first(),
        page.getByTestId('release-notes-primary').first(),
    ];
    for (const candidate of candidates) {
        if ((await candidate.count()) <= 0) continue;
        await candidate.click({ timeout: 10_000, force: true }).catch(() => {});
        await page.waitForTimeout(500);
        if ((await page.getByRole('button', { name: "Let's go!" }).count()) <= 0) return;
    }
    const clicked = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
        const target = controls.find((control) => control.textContent?.includes("Let's go!"));
        if (!(target instanceof HTMLElement)) return false;
        target.click();
        return true;
    });
    if (clicked) {
        await page.waitForTimeout(500);
    }
}

async function createAccountIfNeeded(baseUrl: string, page: Page): Promise<void> {
    await dismissBlockingStoryDeckIfPresent(page);
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
    await gotoDomContentLoadedWithRetries(page, `${baseUrl}/settings/actions?happier_hmr=0`, 180_000);
}

async function openActionDetailFromList(params: Readonly<{
    page: Page;
    baseUrl: string;
    actionId: string;
    requiredTestId?: string;
}>): Promise<void> {
    const actionRowId = `settings-actions:action:${params.actionId}`;
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/actions?happier_hmr=0`, 180_000);
    await expect(params.page.getByTestId(actionRowId)).toHaveCount(1, { timeout: 120_000 });
    await params.page.getByTestId(actionRowId).scrollIntoViewIfNeeded();
    await params.page.getByTestId(actionRowId).click({ timeout: 60_000 });
    await expect(params.page).toHaveURL(new RegExp(`/settings/actions/${encodeURIComponent(params.actionId)}(?:[?#].*)?$`), {
        timeout: 60_000,
    });
    if (params.requiredTestId) {
        await expect(params.page.getByTestId(params.requiredTestId)).toHaveCount(1, { timeout: 120_000 });
    }
}

function resolvedExposureMarker(actionId: string, targetId: string, mode: 'direct' | 'discoverable_only'): string {
    return `settings-actions:action:${actionId}:target:${targetId}:tool-exposure:resolved:${mode}`;
}

function exposureControl(actionId: string, targetId: string): string {
    return `settings-actions:action:${actionId}:target:${targetId}:tool-exposure`;
}

function exposureOption(actionId: string, targetId: string, option: 'default' | 'direct' | 'discoverable_only'): string {
    return `${exposureControl(actionId, targetId)}:${option}`;
}

async function expectResolvedExposure(params: Readonly<{
    page: Page;
    actionId: string;
    targetId: string;
    mode: 'direct' | 'discoverable_only';
}>): Promise<void> {
    await expect(params.page.getByTestId(resolvedExposureMarker(params.actionId, params.targetId, params.mode)))
        .toHaveCount(1, { timeout: 60_000 });
}

async function chooseExposureOption(params: Readonly<{
    page: Page;
    actionId: string;
    targetId: string;
    option: 'default' | 'direct' | 'discoverable_only';
}>): Promise<void> {
    const control = params.page.getByTestId(exposureControl(params.actionId, params.targetId));
    await expect(control).toHaveCount(1, { timeout: 60_000 });
    await control.scrollIntoViewIfNeeded();
    await control.click({ timeout: 60_000 });

    const option = params.page.getByTestId(exposureOption(params.actionId, params.targetId, params.option));
    await expect(option).toHaveCount(1, { timeout: 60_000 });
    await option.click({ timeout: 60_000 });
}

test.describe('ui e2e: actions settings tool exposure', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-actions-tool-exposure-suite');

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
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-actions-tool-exposure-${run.runId}`,
                EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY: 'app.ui.onboardingShowcase',
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('persists per-surface action tool exposure overrides', async ({ page }) => {
        test.setTimeout(180_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        const actionId = 'agents.backends.list';

        await page.setViewportSize({ width: 1440, height: 900 });
        await installFirstLaunchOverlayBypass(page);
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/actions?happier_hmr=0`, 180_000);
        await createAccountIfNeeded(uiBaseUrl, page);

        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: exposureControl(actionId, 'session_agent'),
        });

        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'discoverable_only' });
        await expectResolvedExposure({ page, actionId, targetId: 'mcp', mode: 'direct' });
        await expectResolvedExposure({ page, actionId, targetId: 'cli', mode: 'direct' });

        await chooseExposureOption({
            page,
            actionId,
            targetId: 'session_agent',
            option: 'direct',
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'direct' });

        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: resolvedExposureMarker(actionId, 'session_agent', 'direct'),
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'direct' });

        await chooseExposureOption({
            page,
            actionId,
            targetId: 'session_agent',
            option: 'default',
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'discoverable_only' });

        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: resolvedExposureMarker(actionId, 'session_agent', 'discoverable_only'),
        });
        await expectResolvedExposure({ page, actionId, targetId: 'session_agent', mode: 'discoverable_only' });
    });
});
