import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { resolveCliTestLaunchSpec } from '../../src/testkit/process/cliLaunchSpec';
import { repoRootDir } from '../../src/testkit/paths';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import {
    createSessionFromNewSessionComposer,
    reloadCreatedSessionFromNewSessionComposer,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { parseTestTerminalAttachmentInfo, type TestTerminalAttachmentInfo } from '../../src/testkit/uiE2e/terminalAttachmentInfo';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { waitForSessionActive } from '../../src/testkit/providers/scenarios/sessionRuntime';

// The UI package is CommonJS; use its real lifecycle budget from this ESM test.
const { readSpawnSessionRpcTimeoutMsFromEnv }: typeof import('../../../../apps/ui/sources/sync/domains/session/spawn/spawnSessionRpcTimeout') =
    createRequire(import.meta.url)('../../../../apps/ui/sources/sync/domains/session/spawn/spawnSessionRpcTimeout.ts');

const run = createRunDirs({ runLabel: 'ui-e2e' });

function tmuxAvailable(): boolean {
    if (process.platform === 'win32') return false;
    const res = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
    return res.status === 0;
}

function canReadProcessUid(): boolean {
    return typeof process.getuid === 'function';
}

function attachmentInfoPath(happyHomeDir: string, sessionId: string): string {
    return join(happyHomeDir, 'terminal', 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function waitForAttachmentInfo(happyHomeDir: string, sessionId: string, previousAttachmentId?: string): Promise<TestTerminalAttachmentInfo> {
    const path = attachmentInfoPath(happyHomeDir, sessionId);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
        if (!existsSync(path)) {
            await sleep(100);
            continue;
        }

        // Best-effort: avoid reading while another process is mid-write (can yield partial JSON).
        const s1 = await stat(path).catch(() => null);
        if (!s1) {
            await sleep(100);
            continue;
        }
        await sleep(25);
        const s2 = await stat(path).catch(() => null);
        if (!s2 || s2.size !== s1.size) {
            await sleep(100);
            continue;
        }

        const raw = await readFile(path, 'utf8').catch(() => '');
        const parsed = parseTestTerminalAttachmentInfo(raw);
        if (parsed?.sessionId === sessionId && parsed.attachmentId !== previousAttachmentId) return parsed;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${previousAttachmentId ? 'resumed' : 'initial'} terminal attachment info at ${path}`);
}

async function ensureTmuxSettingsInUi(params: {
    page: Page;
    uiBaseUrl: string;
    tmuxSessionName: string;
    tmuxTmpDir: string;
}): Promise<void> {
    const { page, uiBaseUrl, tmuxSessionName, tmuxTmpDir } = params;

    await page.goto(`${uiBaseUrl}/settings/session/runtime`, { waitUntil: 'domcontentloaded' });

    const terminalHostItem = page.getByTestId('settings-session-terminal-host-item');
    await expect(terminalHostItem).toHaveCount(1, { timeout: 60_000 });
    await terminalHostItem.scrollIntoViewIfNeeded();
    await terminalHostItem.click();
    const tmuxOption = page.getByTestId('settings-session-terminal-host-option-tmux');
    await expect(tmuxOption).toBeVisible();
    await tmuxOption.click();

    const sessionNameInput = page.getByTestId('settings-session-tmux-sessionName-input');
    await expect(sessionNameInput).toHaveCount(1, { timeout: 60_000 });
    await sessionNameInput.fill(tmuxSessionName);

    const isolatedItem = page.getByTestId('settings-session-tmux-isolated-item');
    await expect(isolatedItem).toHaveCount(1, { timeout: 60_000 });
    await isolatedItem.scrollIntoViewIfNeeded();

    const tmpDirInput = page.getByTestId('settings-session-tmux-tmpDir-input');
    if ((await tmpDirInput.count()) === 0) {
        await isolatedItem.click();
    }
    await expect(tmpDirInput).toHaveCount(1, { timeout: 60_000 });
    await tmpDirInput.fill(tmuxTmpDir);
}

test.describe('ui e2e: tmux spawn → attach', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!tmuxAvailable(), 'tmux is not available on this machine');
    test.skip(!canReadProcessUid(), 'process.getuid is not available');

    const suiteDir = run.testDir('session-tmux-spawn-attach-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    let tmuxTmpDir: string | null = null;
    let tmuxSessionName: string | null = null;

    test.beforeAll(async () => {
        // Expo web cold starts can take several minutes on developer machines (initial Metro + bundling).
        // Keep this generous so we fail on real errors, not just slow bundle readiness.
        test.setTimeout(900_000);
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});

        if (tmuxTmpDir && tmuxSessionName && tmuxAvailable()) {
            spawnSync('tmux', ['kill-session', '-t', tmuxSessionName], { env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } });
        }
        if (tmuxTmpDir) {
            await rm(tmuxTmpDir, { recursive: true, force: true }).catch(() => {});
        }
    });

    test('starts and resumes a UI-created session in tmux and can attach via CLI', async ({ page }) => {
        // CI 36709793378: this journey passed in 198s; retain its longer test budget.
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const diagnostics = collectBrowserDiagnostics({ page });
        try {
            await page.setViewportSize({ width: 1440, height: 900 });
            await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

            await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

            const testDir = resolve(join(suiteDir, 't1-tmux-spawn-attach'));
            await mkdir(testDir, { recursive: true });

            tmuxSessionName = `happy-ui-e2e-${run.runId.slice(0, 8)}`;
            const shortTmpBase = process.platform === 'win32' ? tmpdir() : '/tmp';
            tmuxTmpDir = await mkdtemp(join(shortTmpBase, 'happy-ui-e2e-tmux-'));

            await ensureTmuxSettingsInUi({ page, uiBaseUrl, tmuxSessionName, tmuxTmpDir });

            const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
                testDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                webappUrl: uiBaseUrl,
                env: {
                    ...process.env,
                    HOME: cliHomeDir,
                    CI: '1',
                    HAPPIER_DISABLE_CAFFEINATE: '1',
                    HAPPIER_VARIANT: 'dev',
                },
            });

            await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
            await page.getByTestId('terminal-connect-approve').click();
            await cliLogin.waitForSuccess();
            await cliLogin.stop().catch(() => {});

            await acknowledgeTerminalConnectSuccessIfPresent(page);

            const fakeClaudePath = fakeClaudeFixturePath();
            daemon = await startTestDaemon({
                testDir,
                happyHomeDir: cliHomeDir,
                env: {
                    ...process.env,
                    HOME: cliHomeDir,
                    CI: '1',
                    HAPPIER_HOME_DIR: cliHomeDir,
                    HAPPIER_SERVER_URL: server.baseUrl,
                    HAPPIER_WEBAPP_URL: uiBaseUrl,
                    HAPPIER_DISABLE_CAFFEINATE: '1',
                    HAPPIER_VARIANT: 'dev',
                    HAPPIER_CLAUDE_PATH: fakeClaudePath,
                    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                },
            });

            const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });

            const session = await createSessionFromNewSessionComposer({
                page,
                uiBaseUrl,
                machineId,
                prompt: `hello ${run.runId}`,
                readiness: 'first-turn-reload-safe',
            });
            const { sessionId } = session;
            await reloadCreatedSessionFromNewSessionComposer({ page, session });
            await expect.poll(async () => page.locator('[data-testid^="transcript-message-"]').count(), { timeout: 180_000 }).toBeGreaterThan(1);

            const info = await waitForAttachmentInfo(cliHomeDir, sessionId);
            expect(info.terminal.mode).toBe('tmux');
            const target = info.terminal.tmux?.target;
            expect(typeof target).toBe('string');
            if (typeof target !== 'string' || target.length === 0) throw new Error('Missing terminal.tmux.target in attachment info');
            expect(target.startsWith(`${tmuxSessionName}:`)).toBe(true);

            // Verify isolated tmux server socket exists.
            const uid = process.getuid?.();
            if (typeof uid !== 'number') throw new Error('process.getuid is not available');
            const socketPath = `${tmuxTmpDir}/tmux-${uid}/default`;
            expect(existsSync(socketPath)).toBe(true);

            // Attach non-interactively: emulate being already inside the same isolated tmux server.
            const cliLaunchSpec = await resolveCliTestLaunchSpec(
                { testDir, env: process.env },
                { snapshotDir: resolve(testDir, 'cli-dist') },
            );
            const sessionName = tmuxSessionName;
            const isolatedTmpDir = tmuxTmpDir;
            const assertCanAttach = (attachment: TestTerminalAttachmentInfo) => {
                const attachRes = spawnSync(
                    cliLaunchSpec.command,
                    [...cliLaunchSpec.args, 'attach', sessionId],
                    {
                        cwd: cliLaunchSpec.cwd ?? repoRootDir(),
                        env: {
                            ...process.env,
                            ...cliLaunchSpec.env,
                            CI: '1',
                            HAPPIER_VARIANT: 'dev',
                            HAPPIER_HOME_DIR: cliHomeDir,
                            TMUX: `${socketPath},0,0`,
                            TMUX_PANE: '%0',
                        },
                        encoding: 'utf8',
                    },
                );
                expect(attachRes.status, `CLI attach failed: ${attachRes.stdout}\n${attachRes.stderr}`).toBe(0);

                // Assert tmux now has the target window active.
                const parts = attachment.terminal.tmux!.target!.split(':');
                expect(parts.length).toBeGreaterThanOrEqual(2);
                const windowId = parts[1];
                expect(windowId).toMatch(/^@\d+$/);
                const windows = spawnSync('tmux', ['list-windows', '-t', sessionName, '-F', '#{window_active} #{window_id}'], {
                    env: { ...process.env, TMUX_TMPDIR: isolatedTmpDir, TMUX: `${socketPath},0,0` },
                    encoding: 'utf8',
                });
                expect(windows.status).toBe(0);
                const active = (windows.stdout || '')
                    .split('\n')
                    .map((l) => l.trim())
                    .filter(Boolean)
                    .find((l) => l.startsWith('1 '));
                expect(active).toBe(`1 ${windowId}`);
            };
            assertCanAttach(info);

            await test.step('stop the initial session from the UI', async () => {
                await page.getByTestId('session-header-action-menu-trigger').click();
                await page.getByTestId('dropdown-option-ui_session_stop').click();
                const confirm = page.getByTestId('web-modal-confirm');
                await expect(confirm).toBeEnabled();
                await confirm.click();
            });

            await test.step('resume from the UI and attach to the fresh tmux runtime', async () => {
                await page.getByTestId('session-header-action-menu-trigger').click();
                const resume = page.getByTestId('dropdown-option-ui_session_resume');
                await expect(resume).toBeVisible({ timeout: 60_000 });
                await expect(resume).toBeEnabled();
                await resume.click();

                // Resume acknowledges before the new runtime is ready. Wait for its
                // authoritative active state using the owning spawn lifecycle budget.
                const accessKey = await readCliAccessKey(cliHomeDir);
                if (!accessKey) throw new Error('Missing test CLI access key');
                await waitForSessionActive({
                    baseUrl: server!.baseUrl,
                    token: accessKey.token,
                    sessionId,
                    timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
                });
                const resumedInfo = await waitForAttachmentInfo(cliHomeDir, sessionId, info.attachmentId);
                expect(resumedInfo.terminal.mode).toBe('tmux');
                expect(resumedInfo.terminal.tmux?.target?.startsWith(`${tmuxSessionName}:`)).toBe(true);
                expect(resumedInfo.terminal.tmux?.tmpDir).toBe(tmuxTmpDir);
                assertCanAttach(resumedInfo);
            });
        } catch (error) {
            throw appendBrowserDiagnostics(error, diagnostics());
        }
    });
});
