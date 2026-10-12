import { z } from "zod";
import { clearConnectedServiceAuthGroupMemberRuntimeBlockers } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import {
    parseConnectedServiceAuthGroupPolicyJson,
    stringifyConnectedServiceAuthGroupPolicy,
    type ConnectedServiceAuthGroupPolicyV1,
} from "./authGroupPolicy";
import {
    AuthGroupResponseSchema,
    ConnectedServiceAuthGroupMemberStateSchema,
    ConnectedServiceAuthGroupStateSchema,
} from "./authGroupSchemas";
import {
    deleteConnectedServiceUsageSourcesForGroupMember,
    deleteConnectedServiceUsageSourcesForProfile,
} from "../providerAccountUsage";
import { resolveConnectedServiceCredentialRevision } from "../credentials/credentialRevision";

type AuthGroupState = z.infer<typeof ConnectedServiceAuthGroupStateSchema>;
type AuthGroupMemberState = z.infer<typeof ConnectedServiceAuthGroupMemberStateSchema>;
type AuthGroupResponse = z.infer<typeof AuthGroupResponseSchema>;
export type DeleteConnectedServiceCredentialResult =
    | "deleted"
    | "not_found"
    | "referenced"
    | "storage_mode_mismatch"
    | Readonly<{ type: "superseded"; credentialRevision: string }>;
export type AuthGroupGenerationConflictResult = Readonly<{ type: "generation_conflict"; generation: number }>;
export type AuthGroupRuntimeStateRevisionConflictResult = Readonly<{
    type: "runtime_state_revision_conflict";
    runtimeStateRevision: number;
}>;
export type CreateAuthGroupMemberResult = "created" | "group_not_found" | "profile_not_found" | AuthGroupGenerationConflictResult;
export type UpdateAuthGroupMemberResult = "updated" | "unchanged" | "not_found"
    | AuthGroupGenerationConflictResult
    | AuthGroupRuntimeStateRevisionConflictResult;
export type DeleteAuthGroupMemberResult = "deleted" | "not_found" | AuthGroupGenerationConflictResult;

type AuthGroupMemberRow = Readonly<{
    profileId: string;
    priority: number;
    enabled: boolean;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

type AuthGroupRow = Readonly<{
    id: string;
    vendor: string;
    groupId: string;
    displayName: string | null;
    policyJson: string;
    activeProfileId: string | null;
    generation: number;
    runtimeStateRevision: number;
    stateJson: string | null;
    createdAt: Date;
    updatedAt: Date;
    members: readonly AuthGroupMemberRow[];
}>;

const memberOrderBy = [
    { priority: "asc" as const },
    { profileId: "asc" as const },
];

type AuthGroupMemberActiveCandidate = Readonly<{
    profileId: string;
    priority: number;
    enabled: boolean;
}>;

function resolveFirstEnabledMemberProfileId(
    members: readonly AuthGroupMemberActiveCandidate[],
): string | null {
    return [...members]
        .filter((member) => member.enabled)
        .sort((left, right) => {
            if (left.priority !== right.priority) return left.priority - right.priority;
            return left.profileId.localeCompare(right.profileId);
        })[0]?.profileId ?? null;
}

export function stringifyAuthGroupState(state: AuthGroupState | null | undefined): string | null {
    if (state == null) return null;
    return JSON.stringify(ConnectedServiceAuthGroupStateSchema.parse(state));
}

export function stringifyAuthGroupMemberState(state: AuthGroupMemberState | null | undefined): string | null {
    if (state == null) return null;
    return JSON.stringify(ConnectedServiceAuthGroupMemberStateSchema.parse(state));
}

function parseAuthGroupStateJson(stateJson: string | null): AuthGroupState {
    if (!stateJson) return ConnectedServiceAuthGroupStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupStateSchema.parse({});
    }
}

/** Active-member mutations own switch provenance; runtime projections cannot replace it. */
export function encodeAuthGroupStateForActiveProfile(input: Readonly<{
    currentStateJson: string | null;
    nextState?: AuthGroupState;
    previousActiveProfileId: string | null;
    nextActiveProfileId: string | null;
    switchReason?: string;
}>): string {
    const previous = parseAuthGroupStateJson(input.currentStateJson);
    const next = input.nextState ?? previous;
    const changed = input.previousActiveProfileId !== input.nextActiveProfileId;
    return JSON.stringify(ConnectedServiceAuthGroupStateSchema.parse({
        ...next,
        lastSwitchReason: input.switchReason ?? (changed ? "manual" : previous.lastSwitchReason ?? next.lastSwitchReason),
        lastSwitchAt: changed ? Date.now() : previous.lastSwitchAt ?? next.lastSwitchAt,
    }));
}

function parseAuthGroupMemberStateJson(stateJson: string | null): AuthGroupMemberState {
    if (!stateJson) return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupMemberStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupMemberStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    }
}

export function toAuthGroupResponse(row: AuthGroupRow): AuthGroupResponse {
    const response = {
        v: 1,
        serviceId: row.vendor,
        groupId: row.groupId,
        displayName: row.displayName,
        policy: parseConnectedServiceAuthGroupPolicyJson(row.policyJson),
        activeProfileId: row.activeProfileId,
        generation: row.generation,
        runtimeStateRevision: row.runtimeStateRevision,
        state: parseAuthGroupStateJson(row.stateJson),
        members: row.members.map((member) => ({
            v: 1,
            serviceId: row.vendor,
            groupId: row.groupId,
            profileId: member.profileId,
            priority: member.priority,
            enabled: member.enabled,
            state: parseAuthGroupMemberStateJson(member.stateJson),
            createdAt: member.createdAt.getTime(),
            updatedAt: member.updatedAt.getTime(),
        })),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
    return AuthGroupResponseSchema.parse(response);
}

export async function listAuthGroupsForAccount(params: {
    accountId: string;
    serviceId: string;
}): Promise<AuthGroupResponse[]> {
    const rows = await db.connectedServiceAuthGroup.findMany({
        where: { accountId: params.accountId, vendor: params.serviceId },
        include: { members: { orderBy: memberOrderBy } },
        orderBy: [{ groupId: "asc" }],
    });
    return rows.map(toAuthGroupResponse);
}

export async function findAuthGroupForAccount(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
}): Promise<AuthGroupResponse | null> {
    const row = await db.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        include: { members: { orderBy: memberOrderBy } },
    });
    return row ? toAuthGroupResponse(row) : null;
}

export async function findAuthGroupWithStoredActiveProfileForAccount(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
}): Promise<{ group: AuthGroupResponse; storedActiveProfileId: string | null } | null> {
    const row = await db.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        include: { members: { orderBy: memberOrderBy } },
    });
    return row ? { group: toAuthGroupResponse(row), storedActiveProfileId: row.activeProfileId } : null;
}

export async function hasConnectedServiceProfile(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<boolean> {
    const row = await db.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    return row !== null;
}

export async function findAuthGroupMemberReference(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<{ groupId: string } | null> {
    return db.connectedServiceAuthGroupMember.findFirst({
        where: {
            accountId: params.accountId,
            vendor: params.serviceId,
            profileId: params.profileId,
        },
        select: { groupId: true },
    });
}

export async function isCredentialReferencedByAuthGroup(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
}): Promise<boolean> {
    return (await findAuthGroupMemberReference(params)) !== null;
}

export async function deleteConnectedServiceCredentialInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    profileId: string;
    allowReferencedGroupCleanup: boolean;
    storageMode: "plain" | "sealed";
    expectedCredentialRevision?: string;
}): Promise<DeleteConnectedServiceCredentialResult> {
    const existing = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true, metadata: true },
    });
    if (!existing) return "not_found";

    const credentialRevision = resolveConnectedServiceCredentialRevision({
        rowId: existing.id,
        metadata: existing.metadata,
    });
    if (
        params.expectedCredentialRevision !== undefined
        && params.expectedCredentialRevision !== credentialRevision
    ) {
        return { type: "superseded", credentialRevision };
    }

    if (!params.allowReferencedGroupCleanup) {
        const reference = await tx.connectedServiceAuthGroupMember.findFirst({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
            select: { id: true },
        });
        if (reference) return "referenced";
    }

    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    if (
        !account
        || (resolveEffectiveAccountEncryptionModeFromAccountRow(account) === "plain") !== (params.storageMode === "plain")
    ) {
        return "storage_mode_mismatch";
    }

    if (params.allowReferencedGroupCleanup) {
        const affectedMembers = await tx.connectedServiceAuthGroupMember.findMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
            select: { groupDbId: true },
        });
        const activeGroups = await tx.connectedServiceAuthGroup.findMany({
            where: {
                accountId: params.accountId,
                vendor: params.serviceId,
                activeProfileId: params.profileId,
            },
            select: { id: true },
        });
        const affectedGroupDbIds = [
            ...new Set([
                ...affectedMembers.map((member) => member.groupDbId),
                ...activeGroups.map((group) => group.id),
            ]),
        ];
        const affectedGroups = await tx.connectedServiceAuthGroup.findMany({
            where: {
                id: { in: affectedGroupDbIds },
                accountId: params.accountId,
                vendor: params.serviceId,
            },
            select: {
                id: true,
                activeProfileId: true,
                stateJson: true,
                members: {
                    select: { profileId: true, priority: true, enabled: true },
                },
            },
        });
        for (const group of affectedGroups) {
            const remainingMembers = group.members.filter((member) => member.profileId !== params.profileId);
            const nextActiveProfileId = (
                group.activeProfileId === params.profileId
                || group.activeProfileId === null
            )
                ? resolveFirstEnabledMemberProfileId(remainingMembers)
                : group.activeProfileId;
            await tx.connectedServiceAuthGroup.update({
                where: { id: group.id },
                data: {
                    generation: { increment: 1 },
                    ...(group.activeProfileId !== nextActiveProfileId
                        ? { activeProfileId: nextActiveProfileId, stateJson: encodeAuthGroupStateForActiveProfile({
                            currentStateJson: group.stateJson, previousActiveProfileId: group.activeProfileId,
                            nextActiveProfileId,
                        }) }
                        : {}),
                },
            });
        }
    }

    await deleteConnectedServiceUsageSourcesForProfile({
        accountId: params.accountId,
        serviceId: params.serviceId,
        profileId: params.profileId,
    }, tx);
    await tx.serviceAccountToken.delete({ where: { id: existing.id } });
    return "deleted";
}

export async function deleteConnectedServiceCredential(params: {
    accountId: string;
    serviceId: string;
    profileId: string;
    allowReferencedGroupCleanup: boolean;
    storageMode: "plain" | "sealed";
    expectedCredentialRevision?: string;
}): Promise<DeleteConnectedServiceCredentialResult> {
    return inTx(async (tx) => deleteConnectedServiceCredentialInTx(tx, params));
}

export function encodePolicyForStorage(policy: ConnectedServiceAuthGroupPolicyV1): string {
    return stringifyConnectedServiceAuthGroupPolicy(policy);
}

export async function createAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    priority: number;
    enabled: boolean;
    expectedGeneration: number;
}): Promise<CreateAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: {
            id: true,
            activeProfileId: true,
            stateJson: true,
            generation: true,
            members: {
                select: { profileId: true, priority: true, enabled: true },
            },
        },
    });
    if (!group) return "group_not_found";
    if (group.generation !== params.expectedGeneration) {
        return { type: "generation_conflict", generation: group.generation };
    }

    const profile = await tx.serviceAccountToken.findUnique({
        where: {
            accountId_vendor_profileId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                profileId: params.profileId,
            },
        },
        select: { id: true },
    });
    if (!profile) return "profile_not_found";

    const nextActiveProfileId = group.activeProfileId ?? resolveFirstEnabledMemberProfileId([
        ...group.members,
        {
            profileId: params.profileId,
            priority: params.priority,
            enabled: params.enabled,
        },
    ]);
    const generationUpdate = await tx.connectedServiceAuthGroup.updateMany({
        where: { id: group.id, generation: params.expectedGeneration },
        data: {
            generation: { increment: 1 },
            ...(group.activeProfileId !== nextActiveProfileId ? { activeProfileId: nextActiveProfileId,
                stateJson: encodeAuthGroupStateForActiveProfile({ currentStateJson: group.stateJson,
                    previousActiveProfileId: group.activeProfileId, nextActiveProfileId }) } : {}),
        },
    });
    if (generationUpdate.count !== 1) {
        const current = await tx.connectedServiceAuthGroup.findUnique({
            where: { id: group.id },
            select: { generation: true },
        });
        return { type: "generation_conflict", generation: current?.generation ?? group.generation };
    }

    await tx.connectedServiceAuthGroupMember.create({
        data: {
            groupDbId: group.id,
            accountId: params.accountId,
            vendor: params.serviceId,
            groupId: params.groupId,
            profileId: params.profileId,
            priority: params.priority,
            enabled: params.enabled,
            stateJson: null,
        },
    });
    return "created";
}

export async function updateAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    priority?: number;
    enabled?: boolean;
    state?: AuthGroupMemberState;
    expectedGeneration: number;
    expectedRuntimeStateRevision?: number;
}): Promise<UpdateAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: {
            id: true,
            activeProfileId: true,
            stateJson: true,
            generation: true,
            runtimeStateRevision: true,
            members: {
                select: { id: true, profileId: true, priority: true, enabled: true, stateJson: true },
            },
        },
    });
    if (!group) return "not_found";
    if (group.generation !== params.expectedGeneration) {
        return { type: "generation_conflict", generation: group.generation };
    }
    if (
        params.expectedRuntimeStateRevision !== undefined
        && group.runtimeStateRevision !== params.expectedRuntimeStateRevision
    ) {
        return {
            type: "runtime_state_revision_conflict",
            runtimeStateRevision: group.runtimeStateRevision,
        };
    }

    const member = group.members.find((candidate) => candidate.profileId === params.profileId) ?? null;
    if (!member) return "not_found";

    const changesCandidate = (params.priority !== undefined && params.priority !== member.priority)
        || (params.enabled !== undefined && params.enabled !== member.enabled);
    const nextMembers = group.members.map((candidate) => candidate.profileId === params.profileId
        ? {
            profileId: candidate.profileId,
            priority: params.priority ?? candidate.priority,
            enabled: params.enabled ?? candidate.enabled,
        }
        : candidate);
    const nextActiveProfileId = group.activeProfileId
        && nextMembers.some((candidate) => candidate.profileId === group.activeProfileId && candidate.enabled)
        ? group.activeProfileId
        : resolveFirstEnabledMemberProfileId(nextMembers);
    const changesActiveProfile = group.activeProfileId !== nextActiveProfileId;
    const clearAutomaticDisableState = params.state === undefined && params.enabled === true
        && member.enabled === false
        && (() => {
            if (!member.stateJson) return null;
            try {
                const state = ConnectedServiceAuthGroupMemberStateSchema.parse(JSON.parse(member.stateJson));
                return state.autoDisabledReason === "model_not_entitled"
                    ? clearConnectedServiceAuthGroupMemberRuntimeBlockers(state)
                    : null;
            } catch {
                return null;
            }
        })();
    const nextMemberState = params.state ?? clearAutomaticDisableState;
    const nextMemberStateJson = nextMemberState ? JSON.stringify(nextMemberState) : null;
    const changesRuntimeState = nextMemberState !== null
        && nextMemberStateJson !== member.stateJson;
    if (!changesCandidate && !changesActiveProfile && !changesRuntimeState) return "unchanged";

    const expectedRuntimeStateRevision = changesRuntimeState
        ? params.expectedRuntimeStateRevision ?? group.runtimeStateRevision
        : null;

    const generationUpdate = await tx.connectedServiceAuthGroup.updateMany({
        where: {
            id: group.id,
            generation: params.expectedGeneration,
            ...(expectedRuntimeStateRevision === null
                ? {}
                : { runtimeStateRevision: expectedRuntimeStateRevision }),
        },
        data: {
            generation: { increment: 1 },
            ...(changesRuntimeState
                ? { runtimeStateRevision: { increment: 1 } }
                : {}),
            ...(changesActiveProfile ? { activeProfileId: nextActiveProfileId,
                stateJson: encodeAuthGroupStateForActiveProfile({ currentStateJson: group.stateJson,
                    previousActiveProfileId: group.activeProfileId, nextActiveProfileId }) } : {}),
        },
    });
    if (generationUpdate.count !== 1) {
        const current = await tx.connectedServiceAuthGroup.findUnique({
            where: { id: group.id },
            select: { generation: true, runtimeStateRevision: true },
        });
        if (
            expectedRuntimeStateRevision !== null
            && current?.generation === group.generation
            && current.runtimeStateRevision !== expectedRuntimeStateRevision
        ) {
            return {
                type: "runtime_state_revision_conflict",
                runtimeStateRevision: current.runtimeStateRevision,
            };
        }
        return { type: "generation_conflict", generation: current?.generation ?? group.generation };
    }

    await tx.connectedServiceAuthGroupMember.update({
        where: { id: member.id },
        data: {
            ...(params.priority !== undefined ? { priority: params.priority } : {}),
            ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
            ...(changesRuntimeState ? { stateJson: nextMemberStateJson } : {}),
        },
    });
    return "updated";
}

export async function deleteAuthGroupMemberAndBumpGenerationInTx(tx: Tx, params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    profileId: string;
    expectedGeneration: number;
}): Promise<DeleteAuthGroupMemberResult> {
    const group = await tx.connectedServiceAuthGroup.findUnique({
        where: {
            accountId_vendor_groupId: {
                accountId: params.accountId,
                vendor: params.serviceId,
                groupId: params.groupId,
            },
        },
        select: {
            id: true,
            activeProfileId: true,
            stateJson: true,
            generation: true,
            members: {
                select: { id: true, profileId: true, priority: true, enabled: true },
            },
        },
    });
    if (!group) return "not_found";
    if (group.generation !== params.expectedGeneration) {
        return { type: "generation_conflict", generation: group.generation };
    }

    const member = group.members.find((candidate) => candidate.profileId === params.profileId) ?? null;
    if (!member) return "not_found";

    const remainingMembers = group.members.filter((candidate) => candidate.profileId !== params.profileId);
    const nextActiveProfileId = group.activeProfileId === params.profileId || group.activeProfileId === null
        ? resolveFirstEnabledMemberProfileId(remainingMembers)
        : group.activeProfileId;
    const generationUpdate = await tx.connectedServiceAuthGroup.updateMany({
        where: { id: group.id, generation: params.expectedGeneration },
        data: {
            generation: { increment: 1 },
            ...(group.activeProfileId !== nextActiveProfileId ? { activeProfileId: nextActiveProfileId,
                stateJson: encodeAuthGroupStateForActiveProfile({ currentStateJson: group.stateJson,
                    previousActiveProfileId: group.activeProfileId, nextActiveProfileId }) } : {}),
        },
    });
    if (generationUpdate.count !== 1) {
        const current = await tx.connectedServiceAuthGroup.findUnique({
            where: { id: group.id },
            select: { generation: true },
        });
        return { type: "generation_conflict", generation: current?.generation ?? group.generation };
    }

    await tx.connectedServiceAuthGroupMember.delete({ where: { id: member.id } });
    await deleteConnectedServiceUsageSourcesForGroupMember(params, tx);
    return "deleted";
}
