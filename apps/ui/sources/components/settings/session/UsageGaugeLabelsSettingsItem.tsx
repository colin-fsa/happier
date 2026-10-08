import * as React from 'react';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

export const UsageGaugeLabelsSettingsItem = React.memo(function UsageGaugeLabelsSettingsItem() {
    const [labels, setLabels] = useSettingMutable('sessionUsageGaugeLabels');
    return <Item
        testID="settings-session-usage-gauge-labels"
        title={t('settingsSession.providerUsageGauge.labelsTitle')}
        subtitle={t('settingsSession.providerUsageGauge.labelsSubtitle')}
        rightElement={<Switch testID="settings-session-usage-gauge-labels-toggle" value={labels === true} onValueChange={setLabels} />}
        showChevron={false}
    />;
});

