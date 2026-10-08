import { describe, expect, it } from 'vitest';
import type { SessionFoldersV1, SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import { buildSessionFolderMoveTargets } from '@/sync/domains/session/folders';

const workspace: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo',
};
const folders: SessionFoldersV1 = { v: 1, folders: [
    { id: 'planning', name: 'Planning', workspace, parentId: null, createdAt: 1, updatedAt: 1 },
    { id: 'child', name: 'Child', workspace, parentId: 'planning', createdAt: 1, updatedAt: 1 },
    { id: 'elsewhere', name: 'Elsewhere', workspace: { ...workspace, rootPath: '/other' }, parentId: null, createdAt: 1, updatedAt: 1 },
] };

describe('session folder move destinations', () => {
    it('offers scoped folder destinations without rendered folder headers', () => {
        const targets = buildSessionFolderMoveTargets({ folders, workspace, currentFolderIds: [null], workspaceRootTitle: 'Root' });
        expect(targets.map((target) => target.folderId)).toEqual([null, 'planning', 'child']);
    });

    it('keeps a destination usable when only part of the selection already belongs to it', () => {
        const targets = buildSessionFolderMoveTargets({ folders, workspace, currentFolderIds: ['planning', null], workspaceRootTitle: 'Root' });
        expect(targets.find((target) => target.folderId === 'planning')).toMatchObject({ disabled: false });
    });
});
