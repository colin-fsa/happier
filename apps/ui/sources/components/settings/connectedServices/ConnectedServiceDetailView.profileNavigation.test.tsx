import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
    connectedServicesModuleState,
    installConnectedServiceDetailShellMocks,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsSpy = vi.fn(async () => {});

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'openai-codex' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: vi.fn(async () => null),
                alert: vi.fn(async () => {}),
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
});
installConnectedServiceDetailShellMocks();

vi.mock('@/auth/context/AuthContext', () => {
  // AuthProvider retains credentials between renders; quota effects rely on that identity.
  const credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
  return { useAuth: () => ({ credentials }) };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureId !== 'connectedServices.accountGroups',
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com' }],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceDetailView profile navigation', () => {
  it('opens account detail via the AccountBlock open action', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    const screen = await renderScreen(<ConnectedServiceDetailView />);

    // Opening the account is now the `open` kebab action on the shared AccountBlock.
    const actionHost = screen.tree.root
      .findAll((node) => (node.type as unknown) === 'ItemRowActions')
      .find((host) => ((host.props?.actions ?? []) as ReadonlyArray<{ id: string }>).some((action) => action.id === 'open'));
    const openAction = ((actionHost?.props?.actions ?? []) as ReadonlyArray<{ id: string; onPress: () => void }>)
      .find((action) => action.id === 'open');
    expect(openAction).toBeTruthy();

    await act(async () => {
      openAction?.onPress();
    });

    expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/settings/connected-services/profile',
        params: expect.objectContaining({ serviceId: 'openai-codex', profileId: 'work' }),
      }),
    );
  });
});
