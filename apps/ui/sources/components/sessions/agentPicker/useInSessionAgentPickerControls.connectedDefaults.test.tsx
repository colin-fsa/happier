import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInput/agentInputTestHelpers';

installAgentInputCommonModuleMocks();

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_machineId: string, _request: unknown) => ({
    supported: true,
    response: { ok: true, result: { availableModels: [{ id: 'probed-model', name: 'Probed model' }], supportsFreeform: false } },
})) }));

// Capability and continuation inspection transports are genuine network boundaries.
vi.mock('@/sync/ops/capabilities', () => ({ machineCapabilitiesInvoke: invoke }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (params: { payload: { selections: readonly unknown[] } }) => ({
        v: 1, inspections: params.payload.selections.map(() => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true })),
    }),
}));
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: () => {} }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: () => null }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('react-native-svg', () => ({ SvgXml: 'SvgXml' }));

const [{ useInSessionAgentPickerControls }, { getResolvedBackendCatalogEntries }, { settingsDefaults }] = await Promise.all([
    import('./useInSessionAgentPickerControls'),
    import('@/agents/backendCatalog/getResolvedBackendCatalogEntries'),
    import('@/sync/domains/settings/settings'),
]);
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');

describe('continuation target account discovery', () => {
    it.each(['work', 'missing-profile'])('probes the configured target account even when its profile is unavailable (%s)', async (profileId) => {
        invoke.mockClear();
        resetDynamicModelProbeCacheForTests();
        const settings = {
            ...settingsDefaults,
            connectedServicesDefaultAuthByAgentIdV1: {
                v: 1 as const,
                bindingsByAgentId: { codex: { v: 1 as const, bindingsByServiceId: {
                    'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId },
                } } },
            },
        };
        const hook = await renderHook(() => useInSessionAgentPickerControls({
            sessionId: 'account-discovery',
            accountScope: null,
            currentAgentId: 'claude',
            currentAgentLabel: 'Claude',
            entries: getResolvedBackendCatalogEntries({ enabledAgentIds: ['claude', 'codex'], acpCatalogSettingsV1: settings.acpCatalogSettingsV1 }),
            featureDecision: { state: 'enabled' },
            source: { currentBackendTargetKey: 'builtInAgent:claude', storageKind: 'persisted', canEditSession: true, machinePresence: 'online', hasConversationToCarry: true },
            machine: { machineId: 'machine-1', serverId: 'server-1', connectionGeneration: 1, daemonGeneration: 1 },
            detail: {
                settings, capabilityServerId: 'server-1', machineId: 'machine-1', cwd: '/repo',
                accountProfileConnectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{
                    profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'work@example.com',
                    providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
                }], groups: [] }], connectedServicesFeatureEnabled: true, accountGroupsFeatureEnabled: true,
            },
        }));
        await act(async () => { hook.getCurrent().onAgentPickerVisibilityChange(true); });
        await act(async () => { await Promise.resolve(); });
        const option = hook.getCurrent().composeAgentPickerOptions([]).find((row) => row.id.includes('codex'));
        expect(option?.disabled).not.toBe(true);
        expect(option?.renderDetailContent).toBeDefined();
        const detail = option!.renderDetailContent!();
        if (!React.isValidElement(detail)) throw new Error('Expected target Agent detail content');
        const screen = await renderScreen(detail);
        await act(async () => { await Promise.resolve(); });
        expect(invoke.mock.calls.some((args) => {
            const request = args[1] as { id?: string; method?: string };
            return request.id === 'cli.codex' && request.method === 'probeModels';
        })).toBe(true);
        const modelRequest = invoke.mock.calls.map((args) => args[1] as { id?: string; method?: string; params?: unknown })
            .find((request) => request.id === 'cli.codex' && request.method === 'probeModels');
        expect(modelRequest?.params).toMatchObject({ connectedServices: { v: 1, bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'profile', profileId },
        } } });
        await screen.unmount();
        await hook.unmount();
    });
});
