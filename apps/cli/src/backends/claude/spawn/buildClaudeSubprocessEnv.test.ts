import { describe, expect, it } from 'vitest';

import { buildClaudeSubprocessEnv } from './buildClaudeSubprocessEnv';

describe('buildClaudeSubprocessEnv', () => {
  it('drops inherited session attribution while preserving an explicit child entrypoint', () => {
    const baseEnv = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    expect(buildClaudeSubprocessEnv({ baseEnv }).CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    const child = buildClaudeSubprocessEnv({ baseEnv, envOverlay: { CLAUDE_CODE_ENTRYPOINT: 'happier', CLAUDECODE: '1' } });
    expect(child.CLAUDE_CODE_ENTRYPOINT).toBe('happier');
    expect(child.CLAUDECODE).toBeUndefined();
    expect(baseEnv.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
  });

  it('preserves only Claude\'s exact external sandbox assertion from the runner environment', () => {
    expect(buildClaudeSubprocessEnv({
      baseEnv: {
        PATH: '/bin',
        IS_SANDBOX: '1',
        UNRELATED_SECRET: 'do-not-forward',
      },
    })).toMatchObject({
      PATH: '/bin',
      IS_SANDBOX: '1',
    });

    expect(buildClaudeSubprocessEnv({
      baseEnv: {
        PATH: '/bin',
        IS_SANDBOX: '0',
      },
    })).toEqual({ PATH: '/bin' });
  });
});
