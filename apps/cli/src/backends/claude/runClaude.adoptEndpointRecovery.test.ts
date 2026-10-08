import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
    type AttachmentBoundClaudeEndpointState,
} from './endpointRecovery/claudeEndpointArtifacts';
import { resolveClaudeAdoptEndpointRecovery } from './endpointRecovery/claudeEndpointRecovery';
import { startHookServer } from './utils/startHookServer';
import { writeClaudeEndpointDescriptor } from './endpointRecovery/claudeEndpointArtifacts';
import { createTerminalAttachmentId, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { claimSessionRunnerOwnership, withSessionRunnerOwnership } from '@/daemon/sessionRunnerLock';
import { reloadConfiguration } from '@/configuration';

const originalEndpointStateEnv = process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];

async function reservePort(): Promise<Readonly<{ port: number; close: () => Promise<void> }>> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Failed to reserve a local port');
    }
    return {
        port: address.port,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

async function findAvailablePort(): Promise<number> {
    const reservation = await reservePort();
    const { port } = reservation;
    await reservation.close();
    return port;
}

async function runSessionForwarder(params: Readonly<{
    scriptPath: string;
    port: number;
    secretFilePath: string;
    body: unknown;
}>): Promise<number | null> {
    return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            params.scriptPath,
            String(params.port),
            'UserPromptSubmit',
            '--secret-file',
            params.secretFilePath,
        ], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.once('error', reject);
        child.once('close', resolve);
        child.stdin.end(JSON.stringify(params.body));
    });
}

async function writeRecoveryArtifacts(params: Readonly<{
    root: string;
    attachmentId?: string;
    stateHookServerPort: number;
    hooksJsonHookServerPort?: number;
    mcpPort: number;
    permissionSecret?: string;
    statuslineSecret?: string;
}>): Promise<AttachmentBoundClaudeEndpointState> {
    const hookPluginDir = join(params.root, 'hook-plugin');
    const hooksDir = join(hookPluginDir, 'hooks');
    const hookSettingsPath = join(params.root, 'session-hook.json');
    const hookSettingsOverlayPath = join(params.root, 'session-hook.overlay.json');
    const statuslineSecretFilePath = join(params.root, 'session-hook.statusline-secret');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hookPluginDir, 'permission-hook-secret'), params.permissionSecret ?? 'permission-secret', 'utf8');
    await writeFile(hookSettingsPath, '{}', 'utf8');
    await writeFile(hookSettingsOverlayPath, '{}', 'utf8');
    await writeFile(statuslineSecretFilePath, params.statuslineSecret ?? 'statusline-secret', 'utf8');
    await writeFile(join(hooksDir, 'hooks.json'), JSON.stringify({
        hooks: {
            SessionStart: [
                {
                    matcher: '',
                    hooks: [
                        {
                            type: 'command',
                            command: `"node" "/app/session_hook_forwarder.cjs" ${params.hooksJsonHookServerPort ?? params.stateHookServerPort} "SessionStart" --secret-file "${join(hookPluginDir, 'permission-hook-secret')}"`,
                        },
                    ],
                },
            ],
        },
    }), 'utf8');
    return {
        v: 2,
        attachmentId: params.attachmentId ?? 'attachment-endpoint-test',
        hookServerPort: params.stateHookServerPort,
        hookPluginDir,
        hookSettingsPath,
        hookSettingsOverlayPath,
        statuslineSecretFilePath,
        mcpUrl: `http://127.0.0.1:${params.mcpPort}`,
        mcpPort: params.mcpPort,
    };
}

describe('resolveClaudeAdoptEndpointRecovery', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        if (originalEndpointStateEnv === undefined) {
            delete process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
        } else {
            process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = originalEndpointStateEnv;
        }
        for (const dir of tempDirs.splice(0)) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns null when the endpoint marker env is missing', async () => {
        delete process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it.each(['owned', 'borrowed', 'different-attachment'] as const)(
        'recovers only exact owned retained endpoint custody after explicit runner admission (%s)', async (custody) => {
            const home = await mkdtemp(join(tmpdir(), 'happier-explicit-endpoint-'));
            tempDirs.push(home);
            const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HERDR_BIN_PATH', HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]);
            env.patch({ HAPPIER_HOME_DIR: home, [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: undefined });
            reloadConfiguration();
            try {
                await withHerdrApi(async (api) => {
                    // Exercise installed-binary admission with the same external Herdr fixture as the socket.
                    env.patch({ HERDR_BIN_PATH: api.binary });
                    api.panes.add('managed');
                    const sessionId = 'sid_retained_controller';
                    const attachmentId = createTerminalAttachmentId();
                    const state = await writeRecoveryArtifacts({ root: home, attachmentId,
                        stateHookServerPort: await findAvailablePort(), mcpPort: await findAvailablePort() });
                    await writeTerminalAttachmentInfo({ happyHomeDir: home, sessionId, attachmentId,
                        lifecycle: custody === 'borrowed' ? 'borrowed' : 'owned',
                        terminal: { mode: 'herdr', herdr: { sessionName: 'work', socketPath: api.socketPath, paneId: 'managed', terminalId: 'terminal_1' } },
                        handle: { kind: 'herdr', sessionName: 'work', socketPath: api.socketPath, paneId: 'managed', terminalId: 'terminal_1', attachmentId,
                            attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } },
                    });
                    await writeClaudeEndpointDescriptor({ happyHomeDir: home, sessionId,
                        endpointState: custody === 'different-attachment' ? { ...state, attachmentId: createTerminalAttachmentId() } : state });
                    await withSessionRunnerOwnership(async () => {
                        await claimSessionRunnerOwnership(sessionId);
                        const recovered = await resolveClaudeAdoptEndpointRecovery({ existingSession: { happyHomeDir: home, sessionId } });
                        if (custody === 'owned') expect(recovered).toMatchObject({ state });
                        else expect(recovered).toBeNull();
                    });
                    expect(api.requests.some(request => request.method === 'pane.close' || request.method === 'layout.apply')).toBe(false);
                });
            } finally {
                env.restore(); reloadConfiguration();
            }
        },
    );

    it('returns null when retained endpoint artifacts are missing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-missing-'));
        tempDirs.push(root);
        const state: AttachmentBoundClaudeEndpointState = {
            v: 2,
            attachmentId: 'attachment-missing-artifacts',
            hookServerPort: await findAvailablePort(),
            hookPluginDir: join(root, 'missing-plugin'),
            hookSettingsPath: join(root, 'missing-settings.json'),
            mcpUrl: `http://127.0.0.1:${await findAvailablePort()}`,
            mcpPort: await findAvailablePort(),
        };
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it('rejects an unbound legacy endpoint descriptor even when its artifacts are valid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-unbound-'));
        tempDirs.push(root);
        const state = await writeRecoveryArtifacts({
            root,
            stateHookServerPort: await findAvailablePort(),
            mcpPort: await findAvailablePort(),
        });
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify({
            ...state,
            v: 1,
            attachmentId: undefined,
        });

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it('returns null when a retained endpoint port is already taken', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-port-'));
        tempDirs.push(root);
        const occupied = await reservePort();
        try {
            const state = await writeRecoveryArtifacts({
                root,
                stateHookServerPort: occupied.port,
                mcpPort: await findAvailablePort(),
            });
            process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

            await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
        } finally {
            await occupied.close();
        }
    });

    it('returns null when hooks.json points at a different hook server port than the marker', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-mismatch-'));
        tempDirs.push(root);
        const state = await writeRecoveryArtifacts({
            root,
            stateHookServerPort: await findAvailablePort(),
            hooksJsonHookServerPort: await findAvailablePort(),
            mcpPort: await findAvailablePort(),
        });
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
    });

    it('returns retained state and re-read secrets when artifacts and ports are valid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-happy-'));
        tempDirs.push(root);
        const state = await writeRecoveryArtifacts({
            root,
            stateHookServerPort: await findAvailablePort(),
            mcpPort: await findAvailablePort(),
            permissionSecret: 'permission-secret-happy',
            statuslineSecret: 'statusline-secret-happy',
        });
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toEqual({
            state,
            permissionHookSecret: 'permission-secret-happy',
            statuslineSecret: 'statusline-secret-happy',
        });

        const hooksJson = JSON.parse(await readFile(join(state.hookPluginDir!, 'hooks', 'hooks.json'), 'utf8')) as any;
        const userPromptSubmitCommand = hooksJson.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command as string;
        expect(userPromptSubmitCommand).toEqual(expect.any(String));
        const sessionForwarderPath = userPromptSubmitCommand.match(/"([^"]*session_hook_forwarder\.cjs)"/)?.[1];
        expect(sessionForwarderPath).toContain(state.hookPluginDir!);
        await expect(access(sessionForwarderPath!)).resolves.toBeUndefined();

        const onSessionHook = vi.fn();
        const hookServer = await startHookServer({
            requestedPort: state.hookServerPort,
            permissionHookSecret: 'permission-secret-happy',
            onSessionHook,
        });
        try {
            await expect(runSessionForwarder({
                scriptPath: sessionForwarderPath!,
                port: state.hookServerPort,
                secretFilePath: join(state.hookPluginDir!, 'permission-hook-secret'),
                body: { session_id: 'claude-retained-session', prompt: 'retained prompt' },
            })).resolves.toBe(0);
            await vi.waitFor(() => {
                expect(onSessionHook).toHaveBeenCalledWith(
                    'claude-retained-session',
                    expect.objectContaining({ hook_event_name: 'UserPromptSubmit', prompt: 'retained prompt' }),
                );
            });
        } finally {
            hookServer.stop();
        }
    });

    it('keeps the complete legacy hooks file when local forwarder materialization fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-adopt-refresh-failure-'));
        tempDirs.push(root);
        const state = await writeRecoveryArtifacts({
            root,
            stateHookServerPort: await findAvailablePort(),
            mcpPort: await findAvailablePort(),
        });
        const hooksJsonPath = join(state.hookPluginDir!, 'hooks', 'hooks.json');
        const originalHooksJson = await readFile(hooksJsonPath, 'utf8');
        await writeFile(join(state.hookPluginDir!, 'runtime-assets'), 'blocks runtime asset directory creation', 'utf8');
        process.env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY] = JSON.stringify(state);

        await expect(resolveClaudeAdoptEndpointRecovery()).resolves.toBeNull();
        await expect(readFile(hooksJsonPath, 'utf8')).resolves.toBe(originalHooksJson);
    });
});
