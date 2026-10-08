import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';

describe('Claude selection configuration sharing', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const roots: string[] = [];
  // This filesystem regression must not invoke the macOS login-keychain cleanup boundary.
  beforeEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
  });
  afterEach(async () => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(kind: 'profile' | 'group') {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-config-sharing-'));
    roots.push(root);
    const source = join(root, 'custom-claude');
    await mkdir(join(source, 'skills', 'example'), { recursive: true });
    await writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'original');
    await writeFile(join(source, 'settings.json'), '{"theme":"dark"}');
    await writeFile(join(source, 'CLAUDE.md'), 'native user instructions');
    await writeFile(join(source, '.credentials.json'), '{"ambientSecret":"must-not-import"}');
    const record = buildConnectedServiceCredentialRecord({
      now: Date.now(), serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
      expiresAt: Date.now() + 3_600_000,
      oauth: {
        accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE, tokenType: 'Bearer',
        providerAccountId: 'work-account', providerEmail: 'work@example.test',
      },
    });
    const materialize = async (configMode?: 'linked' | 'copied' | 'isolated') => {
      const result = await materializeClaudeConnectedServiceSelection({
        activeServerDir: join(root, 'server'), serviceId: 'claude-subscription',
        record, fallbackProfileId: 'work',
        selection: kind === 'group' ? {
          kind, serviceId: 'claude-subscription', groupId: 'pool', activeProfileId: 'work',
          fallbackProfileId: 'work', generation: 1, policy: {}, record,
        } : { kind, serviceId: 'claude-subscription', profileId: 'work', record },
        processEnv: { HOME: root, CLAUDE_CONFIG_DIR: source },
        ...(configMode ? { accountSettings: {
          connectedServicesProviderStateSharingSettingsV1: {
            v: 1, defaults: { configMode, stateMode: 'shared' },
          },
        } } : {}),
      });
      expect(result?.diagnostics).toEqual([]);
      if (!result) throw new Error('Expected a materialized Claude home');
      return result.targetMaterializedRoot;
    };
    return { source, materialize };
  }

  it.each(['profile', 'group'] as const)('refreshes copied %s configuration without changing credentials or replacing the live root', async (kind) => {
    const { source, materialize } = await fixture(kind);
    const target = await materialize('copied');
    const rootStat = await lstat(target);
    await writeFile(join(target, 'local-state'), 'preserve');
    const rootConfig = JSON.parse(await readFile(join(target, '.claude.json'), 'utf8'));
    await writeFile(join(target, '.claude.json'), JSON.stringify({
      ...rootConfig,
      oauthAccount: { ...rootConfig.oauthAccount, accessToken: 'must-remove' },
      projects: { '/existing-workspace': { hasTrustDialogAccepted: true } },
      modelAccessCache: { available: ['model'] },
    }));
    await writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'updated');
    await rm(join(source, 'settings.json'));
    await materialize('copied');
    expect(await readFile(join(target, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('updated');
    expect(await readFile(join(target, 'CLAUDE.md'), 'utf8')).toBe('native user instructions');
    await expect(lstat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(target)).ino).toBe(rootStat.ino);
    expect(await readFile(join(target, 'local-state'), 'utf8')).toBe('preserve');
    const refreshedRoot = JSON.parse(await readFile(join(target, '.claude.json'), 'utf8'));
    expect(refreshedRoot).toMatchObject({
      projects: { '/existing-workspace': { hasTrustDialogAccepted: true } },
      modelAccessCache: { available: ['model'] },
    });
    expect(refreshedRoot.oauthAccount).not.toHaveProperty('accessToken');
  });

  it.each(['profile', 'group'] as const)('reconciles an existing copied %s home to default linked configuration while keeping auth isolated', async (kind) => {
    const { source, materialize } = await fixture(kind);
    const target = await materialize();
    expect((await lstat(join(target, 'skills'))).isSymbolicLink()).toBe(true);
    await materialize('copied');
    expect((await lstat(join(target, 'skills'))).isSymbolicLink()).toBe(false);
    await materialize();
    expect((await lstat(join(target, 'skills'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    await writeFile(join(source, 'CLAUDE.md'), 'updated user instructions');
    expect(await readFile(join(target, 'CLAUDE.md'), 'utf8')).toBe('updated user instructions');
    await writeFile(join(source, 'skills', 'example', 'SKILL.md'), 'visible-without-rematerialization');
    expect(await readFile(join(target, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('visible-without-rematerialization');
    expect((await lstat(join(target, '.credentials.json'))).isSymbolicLink()).toBe(false);
    const credential = JSON.parse(await readFile(join(target, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('synthetic-access');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(credential).not.toHaveProperty('ambientSecret');
    expect((await lstat(join(target, '.claude.json'))).isSymbolicLink()).toBe(false);
  });

  it.each(['profile', 'group'] as const)('removes managed %s configuration when isolation is selected, without deleting session history', async (kind) => {
    const { materialize } = await fixture(kind);
    const target = await materialize('copied');
    await mkdir(join(target, 'projects', 'repo'), { recursive: true });
    await writeFile(join(target, 'projects', 'repo', 'session.jsonl'), 'session-history');
    await materialize('isolated');
    await expect(lstat(join(target, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(target, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(target, 'projects', 'repo', 'session.jsonl'), 'utf8')).toBe('session-history');
    expect((await lstat(join(target, '.credentials.json'))).isFile()).toBe(true);
  });
});
