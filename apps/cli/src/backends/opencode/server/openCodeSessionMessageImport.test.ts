import { describe, expect, it } from 'vitest';

import { extractOpenCodeTextHistoryItems, reconcileOpenCodeCommittedHistoryIdentities } from './openCodeSessionMessageImport';

describe('reconcileOpenCodeCommittedHistoryIdentities', () => {
  it('does not confuse opaque import identities from different native sessions', () => {
    const items = [{ messageId: 'a:mid', role: 'assistant' as const, createdAtMs: 1, text: 'current answer' }];
    const result = reconcileOpenCodeCommittedHistoryIdentities({ remoteSessionId: 'sid', items, metadata: {},
      baseline: { complete: true, rows: [{ localId: 'opencode:import:history:sid:a:mid', role: 'agent',
        provider: 'opencode', meta: { remoteSessionId: 'sid:a' } }] } });
    expect([...result.observedMessageIds]).toEqual([]);
    expect(result.complete).toBe(true);
    const legacy = reconcileOpenCodeCommittedHistoryIdentities({ remoteSessionId: 'sid', items, metadata: {},
      baseline: { complete: true, rows: [{ localId: 'opencode:import:history:sid:a:mid', role: 'agent',
        provider: 'opencode', meta: { remoteSessionId: 'sid' } }] } });
    expect([...legacy.observedMessageIds]).toEqual(['a:mid']);
    const unwitnessed = reconcileOpenCodeCommittedHistoryIdentities({ remoteSessionId: 'sid', items, metadata: {},
      baseline: { complete: true, rows: [{ localId: 'opencode:import:history:sid:a:mid', role: 'agent',
        provider: 'opencode', meta: null }] } });
    expect([...unwitnessed.observedMessageIds]).toEqual([]);
    expect(unwitnessed.complete).toBe(false);
  });
});

describe('extractOpenCodeTextHistoryItems', () => {
  it('includes inline assistant text from non-reasoning parts', () => {
    expect(extractOpenCodeTextHistoryItems([
      {
        info: { id: 'msg_assistant_1', role: 'assistant', time: { created: 2 } },
        parts: [
          { type: 'reasoning', text: 'should stay hidden' },
          { type: 'step', text: 'VISIBLE_INLINE_TEXT' },
        ],
      },
    ])).toEqual([
      {
        messageId: 'msg_assistant_1',
        role: 'assistant',
        createdAtMs: 2,
        text: 'VISIBLE_INLINE_TEXT',
      },
    ]);
  });

  it('ignores incidental text on non-renderable parts', () => {
    expect(extractOpenCodeTextHistoryItems([
      {
        info: { id: 'msg_assistant_2', role: 'assistant', time: { created: 3 } },
        parts: [
          { type: 'tool', text: 'TOOL_STATUS_SHOULD_NOT_IMPORT' },
          { type: 'step', text: 'VISIBLE_STEP_TEXT' },
          { type: 'status', text: 'STATUS_SHOULD_NOT_IMPORT' },
        ],
      },
    ])).toEqual([
      {
        messageId: 'msg_assistant_2',
        role: 'assistant',
        createdAtMs: 3,
        text: 'VISIBLE_STEP_TEXT',
      },
    ]);
  });

  it('ignores OpenCode compaction summary assistant messages', () => {
    expect(extractOpenCodeTextHistoryItems([
      {
        info: {
          id: 'msg_compaction_summary',
          role: 'assistant',
          mode: 'compaction',
          agent: 'compaction',
          summary: true,
          time: { created: 4 },
        },
        parts: [
          { type: 'text', text: 'SUMMARY_TEXT_SHOULD_NOT_IMPORT' },
        ],
      },
      {
        info: { id: 'msg_normal_answer', role: 'assistant', time: { created: 5 } },
        parts: [
          { type: 'text', text: 'NORMAL_ANSWER_TEXT' },
        ],
      },
    ])).toEqual([
      {
        messageId: 'msg_normal_answer',
        role: 'assistant',
        createdAtMs: 5,
        text: 'NORMAL_ANSWER_TEXT',
      },
    ]);
  });

  it('does not hide visible messages just because user or custom agent metadata says compaction', () => {
    expect(extractOpenCodeTextHistoryItems([
      {
        info: {
          id: 'msg_user_compaction_named',
          role: 'user',
          mode: 'compaction',
          agent: 'compaction',
          summary: true,
          time: { created: 6 },
        },
        parts: [
          { type: 'text', text: 'USER_TEXT_STILL_VISIBLE' },
        ],
      },
      {
        info: {
          id: 'msg_assistant_custom_agent',
          role: 'assistant',
          mode: 'compaction',
          agent: 'worker',
          time: { created: 7 },
        },
        parts: [
          { type: 'text', text: 'CUSTOM_AGENT_TEXT_STILL_VISIBLE' },
        ],
      },
    ])).toEqual([
      {
        messageId: 'msg_user_compaction_named',
        role: 'user',
        createdAtMs: 6,
        text: 'USER_TEXT_STILL_VISIBLE',
      },
      {
        messageId: 'msg_assistant_custom_agent',
        role: 'assistant',
        createdAtMs: 7,
        text: 'CUSTOM_AGENT_TEXT_STILL_VISIBLE',
      },
    ]);
  });

  it('filters synthetic ignored and internal text parts from history imports', () => {
    expect(extractOpenCodeTextHistoryItems([
      {
        info: { id: 'msg_assistant_filtered_parts', role: 'assistant', time: { created: 8 } },
        parts: [
          { type: 'text', text: 'SYNTHETIC_SHOULD_NOT_IMPORT', synthetic: true },
          { type: 'text', text: 'IGNORED_SHOULD_NOT_IMPORT', ignored: true },
          { type: 'step', text: 'INTERNAL_SHOULD_NOT_IMPORT', internal: true },
          { type: 'text', text: 'VISIBLE_TEXT' },
        ],
      },
    ])).toEqual([
      {
        messageId: 'msg_assistant_filtered_parts',
        role: 'assistant',
        createdAtMs: 8,
        text: 'VISIBLE_TEXT',
      },
    ]);
  });
});
