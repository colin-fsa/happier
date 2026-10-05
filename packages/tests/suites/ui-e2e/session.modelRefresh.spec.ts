import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { fetchJson } from '../../src/testkit/http';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { writeFakeCodexAppServerScript, readFakeCodexAppServerRequestLog } from '../../src/testkit/codexAppServerRemoteHarness';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import type { StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e-model-refresh' });

test.describe('UI e2e: inactive session model refresh', () => {
    const suiteDir = run.testDir('inactive-session-model-refresh');
    const cliHomeDir = join(suiteDir, 'cli-home');
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs({ ...process.env, HAPPIER_E2E_UI_WEB_MODE: 'metro' }));
        await mkdir(cliHomeDir, { recursive: true });
        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
                HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
            },
        });
        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                HAPPIER_E2E_UI_WEB_MODE: 'metro',
                NODE_OPTIONS: process.env.NODE_OPTIONS,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: run.runId,
                EXPO_PUBLIC_DEBUG: '1',
            },
        });
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop();
        await ui?.stop();
        await server?.stop();
    });

    test('refreshes the machine catalog, keeps usable stale results on failure, and never resumes the session', async ({ page }) => {
        test.setTimeout(180_000);
        if (!server || !ui) throw new Error('Missing live fixtures');
        const diagnostics = collectBrowserDiagnostics({ page });
        const uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
        const requestLogPath = join(suiteDir, 'provider.requests.jsonl');
        const modelListStatePath = join(suiteDir, 'provider.models.json');
        const setCatalog = (models: string[], extra: { error?: boolean; delayMs?: number } = {}) => writeFile(
            modelListStatePath,
            JSON.stringify({ models: models.map((id) => ({ id, displayName: id, isDefault: true })), ...extra }),
        );
        const modelRequests = async () => (await readFakeCodexAppServerRequestLog(requestLogPath)).filter((entry) => entry.method === 'model/list');
        try {
            await setCatalog(['catalog-initial'], { delayMs: 1000 });
            const fakeAppServer = await writeFakeCodexAppServerScript({ dir: suiteDir, requestLogPath, modelListStatePath });
            daemon = await authenticateAndStartDaemon({
                page, testDir: suiteDir, cliHomeDir, serverUrl: server.baseUrl, uiBaseUrl,
                extraEnv: {
                    HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
                    HAPPIER_CODEX_APP_SERVER_RPC_LOG_PATH: join(suiteDir, 'provider.rpc.jsonl'),
                    HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
                    HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                },
            });
            const credentials = await readCliAccessKey(cliHomeDir);
            if (!credentials) throw new Error('Missing fixture credentials');
            const headers = { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' };
            let machineId: string | undefined;
            await expect.poll(async () => {
                const machines = await fetchJson<Array<{ id: string }>>(`${server!.baseUrl}/v1/machines`, { headers });
                machineId = machines.data?.[0]?.id;
                return machineId;
            }, { timeout: 60_000 }).toBeTruthy();
            if (!machineId) throw new Error('Fixture daemon did not register a machine');
            const created = await fetchJson<{ session: { id: string } }>(`${server.baseUrl}/v1/sessions`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    tag: run.runId, encryptionMode: 'plain', dataEncryptionKey: null, agentState: null,
                    metadata: JSON.stringify({
                        v: 1, name: 'Inactive model refresh', path: suiteDir, flavor: 'codex', machineId,
                        codexSessionId: 'inactive-native-thread',
                        sessionModelsV1: {
                            v: 1, provider: 'codex', updatedAt: 1, currentModelId: 'metadata-stale',
                            availableModels: [{ id: 'metadata-stale', name: 'Metadata stale' }],
                        },
                    }),
                }),
            });
            expect(created.status).toBe(200);
            const sessionId = created.data.session.id;
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
            await expect(page.getByTestId('session-composer-input')).toBeVisible({ timeout: 120_000 });
            expect(await modelRequests()).toHaveLength(0);
            await page.getByTestId('agent-input-agent-chip').click();
            await expect(page.getByTestId('model-picker-overlay-option:metadata-stale')).toBeVisible();
            await expect(page.getByTestId('model-picker-overlay-option:catalog-initial')).toBeVisible({ timeout: 60_000 });
            await setCatalog(['catalog-refreshed']);
            const refresh = page.getByTestId('model-picker-overlay-refresh');
            await expect(refresh.getByRole('progressbar')).toHaveCount(0);
            await refresh.click();
            await expect(page.getByTestId('model-picker-overlay-option:catalog-refreshed')).toBeVisible({ timeout: 60_000 });
            await setCatalog([], { error: true });
            await expect(refresh.getByRole('progressbar')).toHaveCount(0);
            const beforeFailure = (await modelRequests()).length;
            await refresh.click();
            await expect.poll(async () => (await modelRequests()).length, { timeout: 60_000 }).toBeGreaterThan(beforeFailure);
            await expect(refresh.getByRole('progressbar')).toHaveCount(0, { timeout: 60_000 });
            await expect(page.getByTestId('model-picker-overlay-option:catalog-refreshed')).toBeVisible();
            await page.getByTestId('model-picker-overlay-option:catalog-refreshed').click();
            await expect.poll(async () => {
                const session = await fetchSessionV2(server!.baseUrl, credentials.token, sessionId);
                const metadata = JSON.parse(session.metadata);
                return metadata.modelOverrideV1?.modelId;
            }, { timeout: 60_000 }).toBe('catalog-refreshed');
            expect((await fetchSessionV2(server.baseUrl, credentials.token, sessionId)).active).toBe(false);
            const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
            expect(requests.filter((entry) => entry.method && ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method))).toEqual([]);
            expect((await modelRequests()).length).toBeGreaterThanOrEqual(3);
            await page.screenshot({ path: join(suiteDir, 'model-refresh-selected.png') });
        } catch (error) {
            throw appendBrowserDiagnostics(error, diagnostics());
        }
    });
});
