import { afterEach, describe, expect, it, vi } from 'vitest';

// Boundary mocks only: the active socket transport and the ephemeral fallback socket. The restart op,
// active-server selection, and machineRpcWithServerScope routing below them run for real.
const activeMachineRpc = vi.hoisted(() => vi.fn());
const createEphemeralSocket = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/api/session/apiSocket')>();
    return {
        ...actual,
        apiSocket: {
            machineRPC: (...args: unknown[]) => activeMachineRpc(...args),
        },
    };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocket(...args),
}));

describe('restartStaleSessionRunner transport', () => {
    afterEach(() => {
        activeMachineRpc.mockReset();
        createEphemeralSocket.mockReset();
        vi.useRealTimers();
    });

    it('waits out a slow but successful restart instead of timing out and re-sending it', async () => {
        vi.useFakeTimers();
        // The daemon acks only after the old runner exits and its replacement spawns, which can exceed the
        // generic 30s machine RPC budget for runners started by an older CLI.
        const slowAckMs = 45_000;
        activeMachineRpc.mockImplementation(() => new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, status: 'restarted', sessionId: 's1' }), slowAckMs);
        }));

        const { restartStaleSessionRunner } = await import('./sessionRunnerRestart');
        const restart = restartStaleSessionRunner({
            sessionId: 's1',
            machineId: 'machine-1',
            expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old',
            expectedRunnerEntrypointIdentity: 'version:cli-old',
        });

        await vi.advanceTimersByTimeAsync(slowAckMs);

        await expect(restart).resolves.toEqual({ ok: true, status: 'restarted', sessionId: 's1' });
        expect(activeMachineRpc).toHaveBeenCalledTimes(1);
        expect(createEphemeralSocket).not.toHaveBeenCalled();
    });
});
