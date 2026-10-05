import { expect, it } from 'vitest';

import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { resolveClaudeCliPath } from './resolveClaudeCliPath';

it('preserves the canonical dependency error for an unavailable Claude executable', () => {
  const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH']);
  process.env.HAPPIER_CLAUDE_PATH = '/missing-private-claude-launcher';
  try {
    let error: unknown;
    try {
      resolveClaudeCliPath();
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(ReferenceError);
    expect(classifyPrimarySessionRuntimeIssue({ provider: 'claude', cause: 'session_error', error })).toMatchObject({
      source: 'dependency_failure',
      code: 'provider_cli_not_found',
      sanitizedPreview: expect.stringContaining('HAPPIER_CLAUDE_PATH'),
    });
    expect(JSON.stringify(classifyPrimarySessionRuntimeIssue({ error }))).not.toContain('/missing-private');
  } finally {
    env.restore();
  }
});
