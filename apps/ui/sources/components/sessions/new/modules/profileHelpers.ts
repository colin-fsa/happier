import React from 'react';
import { getProfileEnvironmentVariables, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getSecretSatisfaction, type SecretSatisfactionParams } from '@/utils/secrets/secretSatisfaction';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

// Optimized profile lookup utility
export const useProfileMap = (profiles: AIBackendProfile[]) => {
    return React.useMemo(() =>
        new Map(profiles.map(p => [p.id, p])),
        [profiles]
    );
};

// Environment variable transformation helper
// Returns ALL profile environment variables - daemon will use them as-is
export const transformProfileToEnvironmentVars = (profile: AIBackendProfile) => {
    // getProfileEnvironmentVariables already returns ALL env vars from profile
    // including custom environmentVariables array
    return getProfileEnvironmentVariables(profile);
};

/** Launch and pre-session discovery must inject exactly the same selected profile secrets. */
export function buildProfileEnvironmentVariablesForSession(params: SecretSatisfactionParams & Readonly<{
    profile: AIBackendProfile;
    decryptSecretValue: (value: SavedSecret['encryptedValue'] | null) => string | null;
}>) {
    const satisfaction = getSecretSatisfaction(params);
    const environmentVariables = { ...transformProfileToEnvironmentVars(params.profile) };
    if (!satisfaction.isSatisfied) return { satisfaction, environmentVariables };
    for (const item of satisfaction.items) {
        if (!item.isSatisfied) continue;
        let injected: string | null | undefined = null;
        if (item.satisfiedBy === 'sessionOnly') {
            injected = params.sessionOnlyValues?.[item.envVarName];
        } else if (
            item.satisfiedBy === 'selectedSaved' || item.satisfiedBy === 'rememberedSaved' || item.satisfiedBy === 'defaultSaved'
        ) {
            const secret = item.savedSecretId ? params.secrets.find((key) => key.id === item.savedSecretId) : null;
            injected = params.decryptSecretValue(secret?.encryptedValue ?? null);
        }
        if (typeof injected === 'string' && injected.length > 0) environmentVariables[item.envVarName] = injected;
    }
    return { satisfaction, environmentVariables };
}
