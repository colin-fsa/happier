import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

export function createActionOperationFixture(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'session.direct.takeover_persist',
        scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 's1' },
        title: 'Import session history',
        state: 'running',
        createdAt: 100,
        startedAt: 101,
        cancellation: 'supported',
        progress: { kind: 'determinate', current: 42, total: 100 },
        ...overrides,
    };
}
