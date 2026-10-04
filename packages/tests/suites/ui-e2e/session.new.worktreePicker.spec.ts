/**
 * Phase 5.7 — Worktree picker UI e2e smoke (agent-input-selection-list-popover-unification).
 *
 * SCOPE (smoke-only): this spec verifies the browser-level wiring that the
 * migrated worktree picker continues to mount the SelectionList popover from
 * the agent-input checkout chip and exposes the quick-actions root step. The
 * actual assertions in the test body (see :138-146) are:
 *
 *   - A real pointer click on the new-session checkout chip
 *     (`new-session-checkout-chip`) keeps `/new` mounted, preserves the
 *     composer draft, and renders the shared
 *     `agent-input-selection-list-popover` shell.
 *   - The root step `worktree-root` exposes the quick-actions options
 *     `current_path` and `create_git_worktree` via the option testID scheme
 *     `selection-list:worktree-root:option:<id>`.
 *
 * FR4-17.3 normalization 2026-05-12: this header previously also claimed
 * coverage for the create step drill-down, existing-worktree status/age
 * accessory testIDs (`worktree-row-age:<path>`, `worktree-row-status:<path>`),
 * and branch reuse pills (`worktree-branch-reuse:<branch>`). The test body
 * does NOT assert any of those today — adding the missing Playwright
 * assertions requires provisioning a real multi-worktree git repo with SCM
 * enrichment in the test stack, which is deferred to the deep-journey e2e
 * tracked as RV-6 child task T1 (plan §Phase 5.7) and T2 (plan §Phase 7.4).
 *
 * The status pill variant resolution, age text formatting, reuse vs create
 * routing, search filtering, back navigation, and drill-down semantics are
 * exercised by deterministic vitest suites (these own the contract; this
 * spec only proves the browser-level mount + root step renders):
 *
 *   - `apps/ui/sources/components/sessions/new/hooks/screenModel/buildWorktreeSelectionListSteps.test.tsx`
 *     (status pill variant, reuse vs create routing, branch row construction).
 *   - `apps/ui/sources/components/ui/selectionList/__tests__/SelectionList.test.tsx`
 *     (back navigation, search filtering, dynamic section state).
 *   - `apps/ui/sources/components/ui/selectionList/__tests__/SelectionList.dynamicSectionState.test.tsx`
 *     (loading/error/empty states for dynamic branch sections).
 *
 * The vitest path is preferred for those domain transformations because (1)
 * the unit tests can drive the snapshot deterministically without
 * provisioning a real remote git repo with multiple worktrees, (2) Playwright
 * keyboard simulation against a real `repoScmBranchService` RPC is slow and
 * adds little additional signal over the unit tests, (3) the browser-level
 * keyboard handling (Tab focus management, reduced-motion, ghost width
 * measurement) is owned by `SelectionListInputController` and tested there.
 *
 * Anything that requires a real session draft + machine + popover anchor
 * (the popover wiring, the chip → popover → SelectionList composition, the
 * testID contract surface) is what this e2e spec is for.
 */

import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const execFileAsync = promisify(execFile);

async function createGitRepository(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: path });
}

async function selectGitWorkingDirectory(params: Readonly<{
    page: Page;
    repoDir: string;
}>): Promise<void> {
    const pathInput = params.page.getByTestId('path-selection-list:header:input');
    if ((await pathInput.count()) === 0) {
        await expect(params.page.getByTestId('agent-input-path-chip')).toHaveCount(1, { timeout: 60_000 });
        await params.page.getByTestId('agent-input-path-chip').click();
    }

    await expect(pathInput).toBeVisible({ timeout: 60_000 });
    await pathInput.fill(params.repoDir);
    await expect(pathInput).toHaveValue(params.repoDir);
    await pathInput.press('Enter');

    await expect
        .poll(async () => await params.page.getByTestId('new-session-checkout-chip').count(), { timeout: 120_000 })
        .toBe(1);
}

test.describe('ui e2e: /new worktree picker (Phase 5 SelectionList migration)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('new-session-worktree-picker-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
    const worktreeRepoDir = resolve(join(suiteDir, 'worktree-picker-repo'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(cliHomeDir, { recursive: true });
        await createGitRepository(worktreeRepoDir);

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
            },
        });
        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            },
        });
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        try { await daemon?.stop?.(); } catch { /* best-effort */ }
        try { await ui?.stop?.(); } catch { /* best-effort */ }
        try { await server?.stop?.(); } catch { /* best-effort */ }
    });

    test('the worktree popover renders the migrated SelectionList surface with the quick-actions root step', async ({ page }) => {
        if (!server || !ui || !uiBaseUrl) {
            throw new Error('test infra failed to start');
        }
        test.setTimeout(180_000);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);
        daemon = await authenticateAndStartDaemon({
            page,
            testDir: suiteDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            terminalConnectUrlTimeoutMs: 180_000,
            daemonStartupTimeoutMs: 180_000,
        });

        await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl, timeoutMs: 180_000 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 120_000);
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 60_000 });

        const draftText = 'worktree picker pointer smoke';
        await page.getByTestId('new-session-composer-input').fill(draftText);
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftText);
        await selectGitWorkingDirectory({ page, repoDir: worktreeRepoDir });

        // Open the agent-input checkout chip → SelectionList popover.
        await expect(page.getByTestId('new-session-checkout-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-checkout-chip').click();
        expect(new URL(page.url()).pathname).toBe('/new');
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible();
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftText);

        // The worktree picker mounts inside the shared SelectionList popover shell.
        await expect(page.getByTestId('agent-input-selection-list-popover')).toBeVisible({ timeout: 30_000 });

        // The root step `worktree-root` exposes the quick-actions options by
        // stable ids (`current_path` / `create_git_worktree`). Visible labels
        // are intentionally not asserted here.
        await expect(page.getByTestId('selection-list:worktree-root:option:current_path')).toBeVisible();
        await expect(page.getByTestId('selection-list:worktree-root:option:create_git_worktree')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(page.getByTestId('agent-input-selection-list-popover')).toBeHidden({ timeout: 30_000 });
        expect(new URL(page.url()).pathname).toBe('/new');
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible();
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue(draftText);
    });
});
