import { ProviderUsageGaugeSettingsGroup } from './ProviderUsageGaugeSettingsGroup';
import * as React from 'react';
import { View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { SvgXml } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useProfile, useSettingMutable, useSettings } from '@/sync/store/hooks';
import { Modal } from '@/modal';
import { CONNECTED_SERVICES_REGISTRY, getConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { AGENT_IDS, getAgentCore } from '@/agents/catalog/catalog';
import {
    ConnectedServicesProviderStateSharingSettingsV1Schema,
    isConnectedServiceCredentialHealthStatusUsable,
    type ConnectedServiceId,
} from '@happier-dev/protocol';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ConnectedServiceQuotaBadgesView } from '@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView';
import { useConnectedServiceQuotaBadges } from '@/hooks/server/connectedServices/useConnectedServiceQuotaBadges';
import { connectedServiceProfileKey, resolveConnectedServiceDefaultProfileId } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceBrandIconXml } from '@/agents/registry/resolveConnectedServiceBrandIconXml';
import { deriveAccountHealth, type AccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import { resolveConnectedServiceCredentialHealthStatus } from '@/sync/domains/connectedServices/resolveConnectedServiceCredentialHealthStatus';
import {
  readConnectedServiceProfileKindFromServices,
  resolveConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { resolveAccountHealthDotColor } from './account/accountBlockModel';
import { resolveConnectedServiceDisplayName } from './model/resolveConnectedServiceDisplayName';
import { ConnectedServicesDefaultAuthRow } from './ConnectedServicesDefaultAuthRow';
import { ConnectedServicesProviderStateSharingDefaultsGroup } from './ConnectedServicesProviderStateSharingSettings';
import { SettingsHeaderAddButton } from '../navigation/SettingsHeaderAddButton';
import { Icon } from '@/components/ui/icons/Icon';

const BRAND_ICON_SIZE = 24;

const stylesheet = StyleSheet.create((theme) => ({
    iconBox: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    healthDot: {
        position: 'absolute',
        bottom: -1,
        right: -1,
        borderWidth: 1.5,
        borderColor: theme.colors.surface.base,
    },
}));

const HEALTH_SEVERITY_RANK: Readonly<Record<AccountHealth, number>> = {
    error: 0,
    attention: 1,
    healthy: 2,
};

/**
 * Derive a provider row's health as the worst-of the credential statuses across
 * its profiles. Quota capacity is left out here — the index already surfaces
 * pinned-meter badges and does not mount per-account quota snapshots — so the
 * provider dot reflects connection health (reuses the canonical
 * `deriveAccountHealth` owner so the index never diverges from the detail view).
 */
function deriveProviderRowHealth(
    profiles: ReadonlyArray<{ status?: unknown }>,
): AccountHealth {
    let health: AccountHealth = 'healthy';
    for (const profile of profiles) {
        const candidate = deriveAccountHealth({
            status: resolveConnectedServiceCredentialHealthStatus(profile?.status),
            capacityPct: null,
        });
        if (HEALTH_SEVERITY_RANK[candidate] < HEALTH_SEVERITY_RANK[health]) {
            health = candidate;
        }
    }
    return health;
}

export const ConnectedServicesSettingsView = React.memo(function ConnectedServicesSettingsView() {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const profile = useProfile();
  const settings = useSettings();
  const [providerStateSharingSettings, setProviderStateSharingSettings] =
    useSettingMutable('connectedServicesProviderStateSharingSettingsV1');
  const [defaultAuthSettings, setDefaultAuthSettings] =
    useSettingMutable('connectedServicesDefaultAuthByAgentIdV1');
  const [poolAdoptionDismissedByKey, setPoolAdoptionDismissedByKey] =
    useSettingMutable('connectedServicesDefaultAuthPoolAdoptionDismissedByKey');
  const dismissPoolAdoptionSuggestion = React.useCallback((key: string) => {
    setPoolAdoptionDismissedByKey({
      ...(poolAdoptionDismissedByKey ?? {}),
      [key]: true,
    });
  }, [poolAdoptionDismissedByKey, setPoolAdoptionDismissedByKey]);
  const router = useRouter();
  const navigation = useNavigation();
  const connectedServicesEnabled = useFeatureEnabled('connectedServices');
  const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
  const normalizedProviderStateSharingSettings = React.useMemo(
    () => ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSettings),
    [providerStateSharingSettings],
  );
  const services = profile.connectedServicesV2;
  const serviceIdsFromProfile = services.map((svc) => svc.serviceId);
  const allServiceIds = Array.from(new Set<ConnectedServiceId>([
    ...CONNECTED_SERVICES_REGISTRY.map((entry) => entry.serviceId),
    ...serviceIdsFromProfile,
  ]));

  const quotaRequestedProfiles = React.useMemo(() => {
    if (!connectedServicesEnabled) return [];
    const next: Array<{ serviceId: ConnectedServiceId; profileId: string }> = [];
    for (const serviceId of allServiceIds) {
      const svc = services.find((s) => s.serviceId === serviceId) ?? null;
      const profiles = svc?.profiles ?? [];
      const connectedIds = profiles
        .filter((p) => isConnectedServiceCredentialHealthStatusUsable(resolveConnectedServiceCredentialHealthStatus(p.status)))
        .map((p) => p.profileId);
      const effectiveProfileId = resolveConnectedServiceDefaultProfileId({
        serviceId,
        connectedProfileIds: connectedIds,
        defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      });
      if (!effectiveProfileId) continue;
      next.push({ serviceId, profileId: effectiveProfileId });
    }
    return next;
  }, [allServiceIds, services, settings.connectedServicesDefaultProfileByServiceId]);

  const quotaBadgesByKey = useConnectedServiceQuotaBadges(connectedServicesEnabled ? quotaRequestedProfiles : []);

  const openServiceDetail = React.useCallback((serviceId: ConnectedServiceId, label: string, connectCommand: string) => {
    try {
      router.push({ pathname: '/settings/connected-services/[serviceId]', params: { serviceId } });
    } catch {
      // Fallback for environments without route support.
      void Modal.alert(
        t('connect.unsupported.connectTitle', { name: label }),
        t('connect.unsupported.runCommandInTerminal'),
        [{ text: connectCommand, style: 'default' }, { text: t('common.ok'), style: 'cancel' }],
      );
    }
  }, [router]);

  // Provider rows: brand mark + worst-of-status health dot, attention-first.
  const serviceRows = React.useMemo(() => allServiceIds
    .map((serviceId) => {
      const svc = services.find((s) => s.serviceId === serviceId) ?? null;
      const entry = getConnectedServiceRegistryEntry(serviceId);
      const label = resolveConnectedServiceDisplayName(serviceId, t);
      const profiles = svc?.profiles ?? [];
      const connected = profiles.filter((p) =>
        isConnectedServiceCredentialHealthStatusUsable(resolveConnectedServiceCredentialHealthStatus(p.status))
      );
      const connectedIds = connected.map((p) => p.profileId);
      const effectiveProfileId = resolveConnectedServiceDefaultProfileId({
        serviceId,
        connectedProfileIds: connectedIds,
        defaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
      });
      const quotaKey = effectiveProfileId ? connectedServiceProfileKey({ serviceId, profileId: effectiveProfileId }) : '';
      const badges = quotaKey ? (quotaBadgesByKey[quotaKey] ?? []) : [];
      const subtitle =
        connected.length > 0
          ? t('connectedServices.list.connectedCount', { count: connected.length })
          : profiles.length > 0
            ? t('connectedServices.list.needsReauth')
            : t('connectedServices.list.notConnected');
      // A provider with no profiles at all is "not connected" — neutral, sorted last.
      const health: AccountHealth = profiles.length > 0 ? deriveProviderRowHealth(profiles) : 'healthy';
      return { serviceId, entry, label, badges, subtitle, health, hasProfiles: profiles.length > 0 };
    })
    .sort((a, b) => {
      const rank = HEALTH_SEVERITY_RANK[a.health] - HEALTH_SEVERITY_RANK[b.health];
      if (rank !== 0) return rank;
      return a.label.localeCompare(b.label);
    }),
  [allServiceIds, services, settings.connectedServicesDefaultProfileByServiceId, quotaBadgesByKey]);

  // Header-right "+": start the connect/add flow by picking a provider to open
  // (the per-provider add-account flow lives on the [serviceId] detail screen).
  const handleHeaderAdd = React.useCallback(() => {
    const rows = serviceRows;
    if (rows.length === 0) return;
    if (rows.length === 1) {
      openServiceDetail(rows[0].serviceId, rows[0].label, rows[0].entry.connectCommand);
      return;
    }
    // NOTE: reuses existing typed keys (`connectedServices.title`) for the
    // picker. Dedicated copy keys are reported for the Wave-3 i18n lane:
    //   connectedServices.list.addServiceTitle = "Connect a service"
    //   connectedServices.list.addServiceMessage = "Choose a service to connect an account."
    void Modal.alert(
      t('connectedServices.title'),
      undefined,
      [
        ...rows.map((row) => ({
          text: row.label,
          style: 'default' as const,
          onPress: () => openServiceDetail(row.serviceId, row.label, row.entry.connectCommand),
        })),
        { text: t('common.cancel'), style: 'cancel' as const },
      ],
    );
  }, [serviceRows, openServiceDetail]);

  const canAddService = connectedServicesEnabled && serviceRows.length > 0;

  React.useLayoutEffect(() => {
    // `useNavigation` returns null when the view is rendered outside a navigator
    // (e.g. embedded previews / tests). Guard so the header wiring is opt-in.
    if (!navigation) return;
    navigation.setOptions({
      headerRight: canAddService
        ? () => (
          <SettingsHeaderAddButton
            testID="connected-services-index:header-add"
            accessibilityLabel={t('connectedServices.title')}
            onPress={handleHeaderAdd}
          />
        )
        : undefined,
    });
  }, [canAddService, handleHeaderAdd, navigation]);

  if (!connectedServicesEnabled) {
    return (
      <ItemList>
        <ItemGroup title={t('connectedServices.title')}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>
              {t('settings.connectedAccountsDisabled')}
            </Text>
          </View>
        </ItemGroup>
      </ItemList>
    );
  }

  return (
    <ItemList>
      <ItemGroup title={t('connectedServices.title')} columns={2}>
        {services.length === 0 && serviceRows.length === 0 ? (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.list.empty')}</Text>
          </View>
        ) : null}

        {serviceRows.map((row) => {
          const { serviceId, entry, label, badges, subtitle, health, hasProfiles } = row;
          const brandXml = resolveConnectedServiceBrandIconXml(serviceId, theme);
          const leadingIcon = (
            <View style={styles.iconBox}>
              {brandXml
                ? <SvgXml xml={brandXml} width={BRAND_ICON_SIZE} height={BRAND_ICON_SIZE} />
                : <Icon name="key" size={20} color={theme.colors.text.primary} />}
              {hasProfiles ? (
                <StatusDot
                  testID={`connected-services-index:${serviceId}:health-dot`}
                  color={resolveAccountHealthDotColor(theme, health)}
                  size={8}
                  style={styles.healthDot}
                />
              ) : null}
            </View>
          );

          return (
            <Item
              key={serviceId}
              title={label}
              subtitle={subtitle}
              leftElement={leadingIcon}
              rightElement={badges.length > 0 ? <ConnectedServiceQuotaBadgesView badges={badges} /> : undefined}
              onPress={() => openServiceDetail(serviceId, label, entry.connectCommand)}
            />
          );
        })}
      </ItemGroup>
      <ItemGroup
        title={t('connectedServices.defaultAuth.title')}
        footer={t('connectedServices.defaultAuth.footer')}
      >
        {AGENT_IDS.map((agentId) => {
          const agentCore = getAgentCore(agentId);
          if ((agentCore.connectedServices?.supportedServiceIds ?? []).length === 0) return null;
          return (
            <ConnectedServicesDefaultAuthRow
              key={agentId}
              agentId={agentId}
              agentTitle={t(agentCore.displayNameKey)}
              agentCore={agentCore}
              connectedServicesEnabled={connectedServicesEnabled}
              accountGroupsEnabled={accountGroupsEnabled}
              accountProfileConnectedServicesV2={services}
              settings={{
                connectedServicesProfileLabelByKey: settings.connectedServicesProfileLabelByKey,
                connectedServicesDefaultProfileByServiceId: settings.connectedServicesDefaultProfileByServiceId,
                connectedServicesDefaultAuthByAgentIdV1: defaultAuthSettings,
              }}
              setDefaultAuthSettings={setDefaultAuthSettings}
              onOpenConnectedServiceSettings={(serviceId) => router.push({
                pathname: '/settings/connected-services/[serviceId]',
                params: { serviceId },
              })}
              onReconnectConnectedServiceProfile={(serviceId, profileId) => router.push(
                resolveConnectedServiceProfileActionRoute({
                  serviceId,
                  profileId,
                  profileKind: readConnectedServiceProfileKindFromServices({
                    connectedServicesV2: services,
                    serviceId,
                    profileId,
                  }),
                }),
              )}
              dismissedPoolAdoptionSuggestionKeys={poolAdoptionDismissedByKey}
              onDismissPoolAdoptionSuggestion={dismissPoolAdoptionSuggestion}
            />
          );
        })}
      </ItemGroup>
      <ProviderUsageGaugeSettingsGroup />
      <ConnectedServicesProviderStateSharingDefaultsGroup
        settings={normalizedProviderStateSharingSettings}
        setSettings={setProviderStateSharingSettings}
        onOpenBackendOverrides={() => router.push('/settings/connected-services/provider-state-sharing')}
      />
    </ItemList>
  );
});
