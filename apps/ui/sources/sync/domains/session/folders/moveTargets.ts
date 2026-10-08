import { buildSessionFolderTree, type SessionFolderTreeNode } from './tree';
import type { SessionFoldersV1, SessionFolderWorkspaceRefV1 } from './types';

export type SessionFolderMoveTarget = Readonly<{
    id: string;
    folderId: string | null;
    title: string;
    disabled: boolean;
}>;

/** Session assignment destinations come from organization state, independently of list presentation. */
export function buildSessionFolderMoveTargets(params: Readonly<{
    folders: SessionFoldersV1;
    workspace: SessionFolderWorkspaceRefV1 | null;
    currentFolderIds: readonly (string | null)[];
    workspaceRootTitle: string;
}>): SessionFolderMoveTarget[] {
    const targets: SessionFolderMoveTarget[] = [];
    const appendTarget = (folderId: string | null, title: string) => targets.push({
        id: folderId === null ? 'session-folder-move-root' : `folder:${folderId}`,
        folderId, title,
        disabled: params.currentFolderIds.every((current) => current === folderId),
    });
    appendTarget(null, params.workspaceRootTitle);
    if (params.workspace) {
        const appendNodes = (nodes: readonly SessionFolderTreeNode[]): void => {
            for (const node of nodes) {
                appendTarget(node.id, node.name);
                appendNodes(node.children);
            }
        };
        appendNodes(buildSessionFolderTree(params.folders, params.workspace).rootNodes);
    }
    return targets;
}
