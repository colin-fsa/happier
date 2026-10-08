import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionFoldersV1, SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import { sessionTagKey } from '../sessionTagUtils';
import { resolveSessionListFolderMoveTargets } from './resolveSessionListFolderMoveTargets';

const workspace = { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' } satisfies SessionFolderWorkspaceRefV1;
const folders: SessionFoldersV1 = { v: 1, folders: [{ id: 'planning', name: 'Planning', workspace, parentId: null, createdAt: 1, updatedAt: 1 }] };
function item(id: string, rootPath = '/repo'): Extract<SessionListViewItem, { type: 'session' }> {
    return { type: 'session', serverId: 'server-a', groupKey: 'day:today', groupKind: 'date', workspace: { ...workspace, rootPath },
        session: createSessionFixture({ id, metadata: { path: rootPath, machineId: 'machine-a', host: 'host-a' } }) };
}
function resolve(items: readonly SessionListViewItem[], assignmentsBySessionKey: Record<string, string | null> = {}) {
    return resolveSessionListFolderMoveTargets({ items,
        sessionKeys: new Set(items.flatMap((row) => row.type === 'session' ? [sessionTagKey('server-a', row.session.id)] : [])),
        folders, assignmentsBySessionKey, workspaceRootTitle: 'Root' });
}

describe('resolveSessionListFolderMoveTargets', () => {
    it('finds destinations in a date list without folder or project headers', () => {
        const targets = resolve([item('s1')]);
        expect(targets.map((target) => target.folderId)).toEqual([null, 'planning']);
    });
    it('uses authoritative assignments rather than presentation folder ids', () => {
        const targets = resolve([{ ...item('s1'), folderId: null }], { [sessionTagKey('server-a', 's1')]: 'planning' });
        expect(targets.find((target) => target.folderId === 'planning')?.disabled).toBe(true);
        expect(targets.find((target) => target.folderId === null)?.disabled).toBe(false);
    });
    it('offers only assignment removal across different workspaces', () => {
        const targets = resolve([item('s1'), item('s2', '/other')], { [sessionTagKey('server-a', 's1')]: 'planning' });
        expect(targets).toMatchObject([{ folderId: null, disabled: false }]);
    });
    it('excludes direct sessions when resolving the destination scope', () => {
        const base = item('direct', '/other');
        const direct = { ...base, session: { ...base.session, metadata: { path: '/other', machineId: 'machine-a', directSessionV1: { v: 1 as const } } } };
        expect(resolve([item('s1'), direct]).map((target) => target.folderId)).toEqual([null, 'planning']);
        expect(resolve([direct])).toEqual([]);
    });
});
