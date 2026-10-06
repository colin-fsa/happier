import { describe, expect, it } from 'vitest';

import { ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS } from './accountSessionReminderSettingDefinitions';
import { settingsParse } from '@/sync/domains/settings/settings';

describe('ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS', () => {
    it('defaults old settings to clearing due reminders on open and preserves manual mode', () => {
        expect(settingsParse({})).toHaveProperty('sessionReminderAutoClearOnOpen', true);
        expect(settingsParse({ sessionReminderAutoClearOnOpen: false }))
            .toHaveProperty('sessionReminderAutoClearOnOpen', false);
    });
    it('owns semantic reminder presets as an account-synced ordered collection', () => {
        const definition = ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS.sessionReminderPresetsV1;
        expect(definition.storageScope).toBe('account');
        expect(definition.default).toEqual([]);
        expect(definition.schema.parse([
            { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 14 * 60 } },
        ])).toEqual([
            { rule: { kind: 'relative_day', daysAhead: 1, minuteOfDay: 14 * 60 } },
        ]);
    });
});
