import { describe, expect, it } from 'vitest';

import type { ProviderTraceEvent } from '../types';
import { checkMaxTraceEvents, hasTraceForKey, scenarioSatisfiedByTrace } from './traceSatisfaction';

describe('providers: traceSatisfaction.checkMaxTraceEvents', () => {
  it('caps by distinct callId (streaming tool-call updates do not count as extra calls)', () => {
    const events: ProviderTraceEvent[] = [
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-result', payload: { callId: 'c1', output: 'ok' } },
    ];

    expect(checkMaxTraceEvents(events, { toolCalls: 1, toolResults: 1 })).toEqual({ ok: true });
  });

  it('treats missing callId as a distinct event (fail-safe)', () => {
    const events: ProviderTraceEvent[] = [
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { name: 'Bash' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { name: 'Bash' } },
    ];

    expect(checkMaxTraceEvents(events, { toolCalls: 1 })).toEqual({
      ok: false,
      reason: 'Exceeded max toolCalls (2 > 1)',
    });
  });

  it('counts identical callIds from different sessions separately', () => {
    const events: ProviderTraceEvent[] = [
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
      { v: 1, sessionId: 's2', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
    ];

    expect(checkMaxTraceEvents(events, { toolCalls: 1 })).toEqual({
      ok: false,
      reason: 'Exceeded max toolCalls (2 > 1)',
    });
  });
});

describe('providers: traceSatisfaction.hasTraceForKey', () => {
  it('matches tool-call names case-insensitively', () => {
    const events: ProviderTraceEvent[] = [
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'opencode', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
    ];

    expect(hasTraceForKey(events, 'acp/opencode/tool-call/bash')).toBe(true);
  });
});

describe('providers: traceSatisfaction completed resume phase', () => {
  const toolEvents: ProviderTraceEvent[] = [
    { v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'tool-call', payload: { callId: 'c1', name: 'Bash' } },
    { v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'tool-result', payload: { callId: 'c1', output: 'PHASE1' } },
  ];
  const satisfaction = { requiredFixtureKeys: ['acp/codebuddy/tool-result/Bash'] };

  it('keeps a successful resume phase running after its tool result until the turn completes', () => {
    const completion = {
      providerProtocol: 'acp',
      decodedMessagesSeen: [],
      taskCompleteCountAtStepSatisfaction: 1,
    };
    const previousCompletion: ProviderTraceEvent = {
      v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'task_complete', payload: {},
    };
    expect(scenarioSatisfiedByTrace([previousCompletion, ...toolEvents], satisfaction, completion)).toBe(false);
    const currentCompletion: ProviderTraceEvent = { ...previousCompletion, payload: { id: 'completed-current-turn' } };
    expect(scenarioSatisfiedByTrace([previousCompletion, ...toolEvents, currentCompletion], satisfaction, completion)).toBe(true);
  });

  it('accepts message completion and preserves tool-only satisfaction when no completion gate is requested', () => {
    expect(scenarioSatisfiedByTrace(toolEvents, satisfaction, {
      providerProtocol: 'acp',
      decodedMessagesSeen: [{ type: 'task_complete', id: 'completed-turn' }],
      taskCompleteCountAtStepSatisfaction: 0,
    })).toBe(true);
    expect(scenarioSatisfiedByTrace(toolEvents, satisfaction)).toBe(true);
    expect(scenarioSatisfiedByTrace(toolEvents, satisfaction, {
      providerProtocol: 'acp',
      allowInFlightSteer: true,
      decodedMessagesSeen: [],
      taskCompleteCountAtStepSatisfaction: null,
    })).toBe(true);
  });
});
