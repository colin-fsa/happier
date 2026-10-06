import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '@/sync/runtime/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

const directSource = {
    kind: 'codexHome' as const,
    home: 'user' as const,
};

describe('machine direct sessions ops server-scoped routing', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        storage.setState({ machines: {}, settings: { ...settingsDefaults } });
    });

    it('routes direct session candidate listing through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            candidates: [],
            nextCursor: null,
        });
        const { machineDirectSessionsCandidatesList } = await import('./machineDirectSessions');

        const result = await machineDirectSessionsCandidatesList({
            machineId: 'machine-1',
            providerId: 'codex',
            source: directSource,
            limit: 20,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, candidates: [], nextCursor: null });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.candidates.list',
            payload: expect.objectContaining({
                providerId: 'codex',
                limit: 20,
            }),
        }));
    });

    it('negotiates ACP session-list capability before calling a current daemon', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                capability: 'acp_session_list_v1',
                protocolVersion: 1,
                sourceKind: 'acpSessionList',
                resumeOnly: true,
            })
            .mockResolvedValueOnce({ ok: true, candidates: [], nextCursor: null });
        const { machineDirectSessionsCandidatesList } = await import('./machineDirectSessions');

        await expect(machineDirectSessionsCandidatesList({
            machineId: 'machine-1',
            providerId: 'kimi',
            source: { kind: 'acpSessionList', cwd: '/work/repo' },
        }, { serverId: 'server-a' })).resolves.toEqual({ ok: true, candidates: [], nextCursor: null });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            method: 'daemon.directSessions.acpSessionList.capability.get',
            payload: {},
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.directSessions.candidates.list',
            payload: expect.objectContaining({ source: { kind: 'acpSessionList', cwd: '/work/repo' } }),
        }));
    });

    it('degrades ACP listing without sending its new source to the released v0.2.12 daemon', async () => {
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new RpcError(
            'RPC method not available',
            RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        ));
        const { machineDirectSessionsCandidatesList } = await import('./machineDirectSessions');

        await expect(machineDirectSessionsCandidatesList({
            machineId: 'machine-1',
            providerId: 'kimi',
            source: { kind: 'acpSessionList', cwd: '/work/repo' },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'provider_unavailable',
            error: 'acp_session_list_requires_daemon_upgrade',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    });

    it('does not reinterpret a capable daemon rejecting a relative ACP directory as compatibility fallback', async () => {
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                ok: true,
                capability: 'acp_session_list_v1',
                protocolVersion: 1,
                sourceKind: 'acpSessionList',
                resumeOnly: true,
            })
            .mockResolvedValueOnce({ ok: false, errorCode: 'invalid_request', error: 'cwd must be absolute' });
        const { machineDirectSessionsCandidatesList } = await import('./machineDirectSessions');

        await expect(machineDirectSessionsCandidatesList({
            machineId: 'machine-1',
            providerId: 'kimi',
            source: { kind: 'acpSessionList', cwd: 'relative/repo' },
        })).resolves.toEqual({ ok: false, errorCode: 'invalid_request', error: 'cwd must be absolute' });
    });

    it('routes direct session linking hints through server-scoped machine rpc', async () => {
        const runtimeDescriptor = {
            v: 1 as const,
            providerId: 'codex' as const,
            provider: {
                backendMode: 'appServer' as const,
                vendorSessionId: 'vendor-session-1',
                home: 'user' as const,
            },
        };
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            sessionId: 'happy-session-1',
            created: true,
        });
        const { machineDirectSessionLinkEnsure } = await import('./machineDirectSessions');

        const result = await machineDirectSessionLinkEnsure({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            codexBackendMode: 'appServer',
            runtimeDescriptor,
            source: directSource,
        }, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            sessionId: 'happy-session-1',
            created: true,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.link.ensure',
            payload: {
                machineId: 'machine-1',
                providerId: 'codex',
                remoteSessionId: 'vendor-session-1',
                titleHint: 'Existing Codex Session',
                directoryHint: '/tmp/worktree',
                codexBackendMode: 'appServer',
                runtimeDescriptor,
                source: directSource,
            },
        }));
    });

    it('routes provider-owned candidate deletion through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, deleted: true });
        const { machineDirectSessionCandidateDelete } = await import('./machineDirectSessions');

        const result = await machineDirectSessionCandidateDelete({
            machineId: 'machine-1',
            providerId: 'kimi',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'acpSessionList', cwd: '/work/repo' },
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, deleted: true });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.candidate.delete',
            payload: {
                machineId: 'machine-1',
                providerId: 'kimi',
                remoteSessionId: 'vendor-session-1',
                source: { kind: 'acpSessionList', cwd: '/work/repo' },
            },
        }));
    });

    it('routes direct transcript paging through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            items: [],
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        const { machineDirectSessionTranscriptPage } = await import('./machineDirectSessions');

        const result = await machineDirectSessionTranscriptPage({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        }, { serverId: 'server-a' });

        expect(result).toEqual({
            ok: true,
            items: [],
            nextCursor: 'cursor-2',
            hasMore: true,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.transcript.page',
            payload: expect.objectContaining({
                remoteSessionId: 'vendor-session-1',
                direction: 'older',
            }),
        }));
    });

    it.each(['direct', 'persist'] as const)('uses replacement-machine terminal settings for %s takeover', async (mode) => {
        storage.setState({
            machines: {
                old: createMachineFixture({ id: 'old', active: false, replacedByMachineId: 'current', replacedAt: 123 }),
                current: createMachineFixture({ id: 'current', active: true }),
            },
            settings: {
                ...settingsDefaults,
                sessionUseTmux: false,
                sessionTmuxByMachineId: {
                    current: { useTmux: true, sessionName: ' machine-work ', isolated: true, tmpDir: ' /tmp/machine-tmux ' },
                },
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, operation: { sessionId: 'session-1', state: 'running', phase: 'preparing', importedCount: 0, canCancel: true } });
        const { machineDirectSessionTakeover, machineDirectSessionTakeoverPersistStart } = await import('./machineDirectSessions');
        await (mode === 'direct' ? machineDirectSessionTakeover : machineDirectSessionTakeoverPersistStart)({
            machineId: 'old', sessionId: 'session-1',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'current',
            payload: {
                machineId: 'old', sessionId: 'session-1',
                terminal: { mode: 'tmux', tmux: { sessionName: 'machine-work', isolated: true, tmpDir: '/tmp/machine-tmux' } },
            },
        }));
    });

    it.each([
        { useTmux: true, override: undefined, expected: { mode: 'tmux', tmux: { sessionName: 'global-work', isolated: false, tmpDir: null } } },
        { useTmux: false, override: undefined, expected: undefined },
        { useTmux: true, override: { useTmux: false, sessionName: '', isolated: false, tmpDir: '' }, expected: undefined },
    ])('uses global tmux=$useTmux and machine override=$override for takeover', async ({ useTmux, override, expected }) => {
        storage.setState({ settings: {
            ...settingsDefaults,
            sessionUseTmux: useTmux,
            sessionTmuxSessionName: 'global-work',
            sessionTmuxIsolated: false,
            sessionTmuxTmpDir: '',
            sessionTmuxByMachineId: override ? { machine: override } : {},
        } });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true });
        const { machineDirectSessionTakeover } = await import('./machineDirectSessions');
        await machineDirectSessionTakeover({ machineId: 'machine', sessionId: 'session-1' });
        expect(machineRpcWithServerScopeMock.mock.calls[0][0].payload.terminal).toEqual(expected);
    });

    it('routes direct session takeover+persist through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            operation: { sessionId: 'happy-session-1', state: 'running', phase: 'preparing', importedCount: 0, canCancel: true },
        });
        const { machineDirectSessionTakeoverPersistStart } = await import('./machineDirectSessions');

        const result = await machineDirectSessionTakeoverPersistStart({
            machineId: 'machine-1',
            sessionId: 'happy-session-1',
            forceStop: true,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, operation: { sessionId: 'happy-session-1', state: 'running', phase: 'preparing', importedCount: 0, canCancel: true } });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: 'daemon.directSessions.takeoverPersist.start',
            payload: {
                machineId: 'machine-1',
                sessionId: 'happy-session-1',
                forceStop: true,
            },
        }));
    });

    it('routes direct session RPCs to an active replacement machine while preserving linked metadata identity', async () => {
        storage.setState({
            machines: {
                'machine-old': createMachineFixture({
                    id: 'machine-old',
                    active: false,
                    replacedByMachineId: 'machine-new',
                    replacedAt: 123,
                }),
                'machine-new': createMachineFixture({
                    id: 'machine-new',
                    active: true,
                }),
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            ok: true,
            operation: { sessionId: 'happy-session-1', state: 'running', phase: 'preparing', importedCount: 0, canCancel: true },
        });
        const { machineDirectSessionTakeoverPersistStart } = await import('./machineDirectSessions');

        const result = await machineDirectSessionTakeoverPersistStart({
            machineId: 'machine-old',
            sessionId: 'happy-session-1',
            forceStop: true,
        }, { serverId: 'server-a' });

        expect(result).toEqual({ ok: true, operation: { sessionId: 'happy-session-1', state: 'running', phase: 'preparing', importedCount: 0, canCancel: true } });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-new',
            serverId: 'server-a',
            method: 'daemon.directSessions.takeoverPersist.start',
            payload: {
                machineId: 'machine-old',
                sessionId: 'happy-session-1',
                forceStop: true,
            },
        }));
    });

    it('throws for malformed transcript page responses', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ nope: true });
        const { machineDirectSessionTranscriptPage } = await import('./machineDirectSessions');

        await expect(machineDirectSessionTranscriptPage({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'vendor-session-1',
            source: directSource,
            direction: 'older',
        })).rejects.toThrow('Unsupported response from machine RPC (daemon.directSessions.transcript.page)');
    });
});
