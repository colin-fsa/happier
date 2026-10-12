import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import type { ProviderUnderTest } from '../../src/testkit/providers/types';

describe('providers: resume scenario permission auto-approve policy', () => {
  const kimiProvider = {
    id: 'kimi',
    protocol: 'acp',
    enableEnvVar: 'HAPPIER_E2E_PROVIDER_KIMI',
    traceProvider: 'kimi',
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } },
    cli: { subcommand: 'kimi' },
  } satisfies ProviderUnderTest;

  it('enables permission auto-approve in yolo for resume load-session scenario', () => {
    const scenario = scenarioCatalog.acp_resume_load_session(kimiProvider);
    expect(scenario.yolo).toBe(true);
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
  });

  it('enables permission auto-approve in yolo for resume fresh-session scenario', () => {
    const scenario = scenarioCatalog.acp_resume_fresh_session_imports_history({
      ...kimiProvider,
      id: 'opencode',
      enableEnvVar: 'HAPPIER_E2E_PROVIDER_OPENCODE',
      traceProvider: 'opencode',
      cli: { subcommand: 'opencode' },
    });
    expect(scenario.yolo).toBe(true);
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
  });
});
