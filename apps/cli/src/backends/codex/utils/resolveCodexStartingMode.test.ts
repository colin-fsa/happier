import { describe, expect, it } from 'vitest';

import { resolveCodexStartingMode } from './resolveCodexStartingMode';

describe('resolveCodexStartingMode', () => {
  it('honors optional native presentation without assigning the headless controller a TTY', () => {
    const hosted = { explicitStartingMode: 'local' as const, startedBy: 'daemon' as const,
      hasTtyForLocal: false, hasHostedTerminal: true, localControlEnabled: true };
    expect(resolveCodexStartingMode(hosted)).toBe('local');
    expect(resolveCodexStartingMode({ ...hosted, localControlEnabled: false })).toBe('remote');
  });
  it('respects an explicit startingMode override', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'remote',
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('remote');

    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'local',
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: false,
      }),
    ).toBe('local');
  });

  it('respects an explicit local startingMode override even without a TTY', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'local',
        startedBy: 'cli',
        hasTtyForLocal: false,
        localControlEnabled: true,
      }),
    ).toBe('local');
  });

  it('honors an explicit local mode for a daemon-hosted interactive terminal', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'local',
        startedBy: 'daemon',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('local');

    expect(
      resolveCodexStartingMode({
        explicitStartingMode: 'local',
        startedBy: 'daemon',
        hasTtyForLocal: false,
        localControlEnabled: true,
      }),
    ).toBe('remote');
  });

  it('defaults to remote when started by daemon', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'daemon',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('remote');
  });

  it('defaults to local when local control is enabled and a TTY is available', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: true,
      }),
    ).toBe('local');
  });

  it('defaults to remote when local control is disabled or a TTY is unavailable', () => {
    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'cli',
        hasTtyForLocal: true,
        localControlEnabled: false,
      }),
    ).toBe('remote');

    expect(
      resolveCodexStartingMode({
        explicitStartingMode: undefined,
        startedBy: 'cli',
        hasTtyForLocal: false,
        localControlEnabled: true,
      }),
    ).toBe('remote');
  });
});
