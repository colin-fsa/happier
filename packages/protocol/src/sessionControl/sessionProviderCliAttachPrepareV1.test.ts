import { describe, expect, it } from 'vitest';

import { SessionProviderCliAttachPrepareRequestV1Schema } from './sessionProviderCliAttachPrepareV1.js';

describe('native client admission request', () => {
  const observation = {
    attached: true,
    herdr: { sessionName: 'work', socketPath: '/private/herdr.sock', paneId: 'w1:p1', terminalId: 'restored-terminal' },
    launcher: { pid: 123, processInstanceFingerprint: 'linux-proc:123:456' },
  };

  it('admits an exact restored client observation through the strict preparation owner', () => {
    expect(SessionProviderCliAttachPrepareRequestV1Schema.safeParse({
      providerSessionId: 'same-conversation', terminalClient: observation,
    }).success).toBe(true);
  });

  it('rejects incomplete or unrecognized custody before calling the runtime', () => {
    for (const terminalClient of [
      { ...observation, launcher: { pid: 123 } },
      { ...observation, herdr: { ...observation.herdr, paneId: undefined } },
      { ...observation, launcher: { ...observation.launcher, pid: -1 } },
      { ...observation, disposeOwnedPane: true },
    ]) {
      expect(SessionProviderCliAttachPrepareRequestV1Schema.safeParse({
        providerSessionId: 'same-conversation', terminalClient,
      }).success).toBe(false);
    }
  });
});
