import {
    PreflightSessionCatalogsV1Schema,
    SessionSkillCatalogListResponseV1Schema,
    SessionVendorPluginCatalogListResponseV1Schema,
    type SessionSkillCatalogListResponseV1,
    type SessionVendorPluginCatalogListResponseV1,
    type BackendTargetRefV1,
    type PreflightSessionCatalogsV1,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '@/sync/domains/state/storage';
import { MetadataSchema } from '@/sync/domains/state/storageTypes';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { machineCapabilitiesInvoke } from './capabilities';
import type { AgentId } from '@/agents/catalog/catalog';

export type MachineSessionCatalogProbeParams = Readonly<{
    machineId: string;
    serverId: string;
    accountId?: string | null;
    agentId: AgentId;
    backendTarget: BackendTargetRefV1;
    capabilityParams: Readonly<Record<string, unknown>>;
}>;

/** An unsupported older daemon has no native pre-session catalog; transport failures retry. */
export async function probeMachineSessionCatalogs(
    params: MachineSessionCatalogProbeParams,
): Promise<PreflightSessionCatalogsV1 | null> {
    const result = await machineCapabilitiesInvoke(params.machineId, {
        id: `cli.${params.agentId}`,
        method: 'probeCatalogs',
        params: { ...params.capabilityParams, backendTarget: params.backendTarget },
    }, {
        serverId: params.serverId,
        accountId: params.accountId,
        ...(typeof params.capabilityParams.timeoutMs === 'number' ? { timeoutMs: params.capabilityParams.timeoutMs } : {}),
    });
    if (!result.supported) {
        if (result.reason === 'not-supported') return null;
        throw new Error('Pre-session catalog transport unavailable');
    }
    if (!result.response.ok) {
        if (result.response.error.code === 'unsupported-method') return null;
        throw new Error(`Pre-session catalog discovery failed (${result.response.error.code ?? 'unknown'})`);
    }
    const parsed = PreflightSessionCatalogsV1Schema.safeParse(result.response.result);
    if (!parsed.success) throw new Error('Invalid pre-session catalog response');
    return parsed.data;
}

export type SessionSuggestionCatalogRequest = Readonly<{
    vendorPlugins?: boolean;
    skills?: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSessionCwd(sessionId: string): string | undefined {
    const path = storage.getState().sessions[sessionId]?.metadata?.path;
    return typeof path === 'string' && path.trim().length > 0 ? path.trim() : undefined;
}

function isInactiveSession(sessionId: string): boolean {
    return storage.getState().sessions[sessionId]?.active === false;
}

function hasCatalogSnapshot(metadata: unknown, key: 'sessionVendorPluginCatalogV1' | 'sessionSkillCatalogV1'): boolean {
    if (!isRecord(metadata)) return false;
    const value = metadata[key];
    if (Array.isArray(value)) return true;
    if (!isRecord(value)) return false;
    if (value.unsupported === true) return true;
    if (key === 'sessionVendorPluginCatalogV1') {
        return Array.isArray(value.vendorPlugins) || Array.isArray(value.plugins) || Array.isArray(value.items);
    }
    return Array.isArray(value.skills) || Array.isArray(value.items);
}

async function listVendorPluginCatalog(
    sessionId: string,
    cwd: string | undefined,
): Promise<SessionVendorPluginCatalogListResponseV1 | undefined> {
    try {
        const response = isInactiveSession(sessionId)
            ? await listInactiveVendorPluginCatalog(sessionId)
            : await sessionRpcWithServerScope<unknown, { cwd?: string }>({
                sessionId,
                serverId: resolvePreferredServerIdForSessionId(sessionId),
                method: SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST,
                payload: cwd ? { cwd } : {},
            });
        const parsed = SessionVendorPluginCatalogListResponseV1Schema.safeParse(response);
        if (parsed.success) return parsed.data;
    } catch {
        return undefined;
    }
    return undefined;
}

async function listSkillCatalog(
    sessionId: string,
    cwd: string | undefined,
): Promise<SessionSkillCatalogListResponseV1 | undefined> {
    try {
        const response = isInactiveSession(sessionId)
            ? await listInactiveSkillCatalog(sessionId)
            : await sessionRpcWithServerScope<unknown, { cwd?: string }>({
                sessionId,
                serverId: resolvePreferredServerIdForSessionId(sessionId),
                method: SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST,
                payload: cwd ? { cwd } : {},
            });
        const parsed = SessionSkillCatalogListResponseV1Schema.safeParse(response);
        if (parsed.success) return parsed.data;
    } catch {
        return undefined;
    }
    return undefined;
}

async function listInactiveVendorPluginCatalog(sessionId: string): Promise<unknown> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return undefined;
    return await machineRpcWithServerScope<unknown, { sessionId: string; cwd?: string }>({
        machineId: target.machineId,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
        method: RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST,
        payload: { sessionId, cwd: target.basePath },
    });
}

async function listInactiveSkillCatalog(sessionId: string): Promise<unknown> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) return undefined;
    return await machineRpcWithServerScope<unknown, { sessionId: string; cwd?: string }>({
        machineId: target.machineId,
        serverId: resolvePreferredServerIdForSessionId(sessionId),
        method: RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST,
        payload: { sessionId, cwd: target.basePath },
    });
}

function applyCatalogSnapshots(
    sessionId: string,
    snapshots: Readonly<{
        vendorPluginCatalog?: SessionVendorPluginCatalogListResponseV1;
        skillCatalog?: SessionSkillCatalogListResponseV1;
    }>,
): void {
    if (!snapshots.vendorPluginCatalog && !snapshots.skillCatalog) return;
    const session = storage.getState().sessions[sessionId];
    if (!session) return;
    const metadata = MetadataSchema.parse({
        ...(session.metadata ?? {}),
        ...(snapshots.vendorPluginCatalog
            ? { sessionVendorPluginCatalogV1: snapshots.vendorPluginCatalog }
            : {}),
        ...(snapshots.skillCatalog
            ? { sessionSkillCatalogV1: snapshots.skillCatalog }
            : {}),
    });
    storage.getState().applySessions([
        {
            ...session,
            metadata,
        },
    ]);
}

export async function ensureSessionSuggestionCatalogs(
    sessionId: string,
    request: SessionSuggestionCatalogRequest,
): Promise<void> {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    const shouldLoadVendorPlugins = request.vendorPlugins === true
        && !hasCatalogSnapshot(metadata, 'sessionVendorPluginCatalogV1');
    const shouldLoadSkills = request.skills === true
        && !hasCatalogSnapshot(metadata, 'sessionSkillCatalogV1');

    if (!shouldLoadVendorPlugins && !shouldLoadSkills) return;

    const cwd = readSessionCwd(sessionId);
    const [vendorPluginCatalog, skillCatalog] = await Promise.all([
        shouldLoadVendorPlugins ? listVendorPluginCatalog(sessionId, cwd) : Promise.resolve(undefined),
        shouldLoadSkills ? listSkillCatalog(sessionId, cwd) : Promise.resolve(undefined),
    ]);

    applyCatalogSnapshots(sessionId, {
        ...(vendorPluginCatalog ? { vendorPluginCatalog } : {}),
        ...(skillCatalog ? { skillCatalog } : {}),
    });
}
