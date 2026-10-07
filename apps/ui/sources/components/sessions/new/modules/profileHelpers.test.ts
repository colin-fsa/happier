import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema, SavedSecretSchema } from '@happier-dev/protocol';
import { buildProfileEnvironmentVariablesForSession } from './profileHelpers';

describe('profile environment materialization for launch and catalog discovery', () => {
    it('preserves session-only and prefer-machine choices over a saved profile binding', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'profile-a', name: 'Profile', isBuiltIn: false, createdAt: 0, updatedAt: 0, version: '1.0.0',
            environmentVariables: [{ name: 'CODEX_HOME', value: '/profile-home' }],
            envVarRequirements: [{ name: 'API_KEY', kind: 'secret', required: true }],
        });
        const secret = SavedSecretSchema.parse({
            id: 'secret-a', name: 'Saved key', kind: 'apiKey', createdAt: 0, updatedAt: 0,
            encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'c2F2ZWQ=' } },
        });
        const common = {
            profile, secrets: [secret], defaultBindings: { API_KEY: 'secret-a' },
            // Encryption is an adapter boundary; secret selection and profile normalization stay real.
            decryptSecretValue: () => 'saved-value',
        };
        expect(buildProfileEnvironmentVariablesForSession(common).environmentVariables)
            .toEqual({ CODEX_HOME: '/profile-home', API_KEY: 'saved-value' });
        expect(buildProfileEnvironmentVariablesForSession({ ...common, sessionOnlyValues: { API_KEY: 'session-value' } }).environmentVariables)
            .toEqual({ CODEX_HOME: '/profile-home', API_KEY: 'session-value' });
        expect(buildProfileEnvironmentVariablesForSession({
            ...common, selectedSecretIds: { API_KEY: '' }, machineEnvReadyByName: { API_KEY: true },
        }).environmentVariables).toEqual({ CODEX_HOME: '/profile-home' });
        expect(buildProfileEnvironmentVariablesForSession({
            ...common, selectedSecretIds: { API_KEY: '' }, machineEnvReadyByName: { API_KEY: false },
        }).satisfaction.isSatisfied).toBe(false);
    });
});
