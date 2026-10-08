import { defineSettingDefinitions } from '@happier-dev/protocol';
import { z } from 'zod';

import { SessionReminderPresetsV1Schema } from '@/sync/domains/session/organization/sessionReminderPreset';

export const ACCOUNT_SESSION_REMINDER_SETTING_DEFINITIONS = defineSettingDefinitions({
    sessionReminderAutoClearOnOpen: {
        schema: z.boolean(),
        default: true,
        description: 'Clear due session reminders when their session is opened',
        storageScope: 'account',
    },
    sessionReminderPresetsV1: {
        schema: SessionReminderPresetsV1Schema,
        default: [],
        description: 'Ordered account-synced semantic session reminder presets',
        storageScope: 'account',
    },
});
