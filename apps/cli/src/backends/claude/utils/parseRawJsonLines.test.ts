import { describe, expect, it } from 'vitest';

import { parseRawJsonLinesLine, parseRawJsonLinesObject } from './parseRawJsonLines';

describe('parseRawJsonLines', () => {
  it('projects a delivered native cross-session attachment with its sender and peer origin', () => {
    // Claude Code 2.1.292 delivered JSONL shape reported in #508.
    const parsed = parseRawJsonLinesObject({
      type: 'attachment', uuid: 'peer-delivered', sessionId: 'recipient', parentUuid: 'prior', isMeta: true,
      attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender" from-mode="prompting">Hello from another session</cross-session-message>' },
    });
    expect(parsed?.type).toBe('user');
    expect(parsed?.origin).toEqual({ kind: 'peer', from: 'uds:/tmp/sender.sock', name: 'Sender' });
    expect(parsed?.uuid).toBe('peer-delivered');
    expect(parsed?.parentUuid).toBe('prior');
    expect(parsed?.isMeta).not.toBe(true);
    expect(parsed?.attachment).toBeUndefined();
    if (!parsed || parsed.type !== 'user') throw new Error('Missing native peer message');
    expect(parsed.message.content).toBe('From Sender:\n\nHello from another session');
    expect(parseRawJsonLinesObject(parsed)).toEqual(parsed);
  });

  it.each([
    { type: 'queue-operation', operation: 'enqueue', content: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">queued</cross-session-message>' },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: 'ordinary queued prompt' } },
    { type: 'attachment', uuid: 'human-copied-wrapper', attachment: { type: 'queued_command', origin: { kind: 'human' },
      prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">copied queued text</cross-session-message>' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:/tmp/sender.sock">unterminated' } },
    { type: 'user', uuid: 'copied-peer', message: { content: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">copied text</cross-session-message>' } },
  ])('does not infer peer delivery from non-native or incomplete content', value => {
    expect(parseRawJsonLinesObject(value)?.origin).toBeUndefined();
  });

  it('uses a peer label when a native delivery has no display name without exposing its address', () => {
    const parsed = parseRawJsonLinesObject({ type: 'attachment', uuid: 'unnamed-peer', attachment: { type: 'queued_command',
      prompt: '<cross-session-message from="uds:/tmp/private-sender.sock">Delivered</cross-session-message>' } });
    expect(parsed).toMatchObject({ origin: { kind: 'peer', from: 'uds:/tmp/private-sender.sock' },
      message: { content: 'From Peer:\n\nDelivered' } });
  });

  it('preserves a quoted sender name containing angle brackets and the whole delivered body', () => {
    const parsed = parseRawJsonLinesObject({ type: 'attachment', uuid: 'quoted-peer', attachment: { type: 'queued_command',
      prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="<Sender>" from-mode="prompting">First line\n\n<code>body</code></cross-session-message>' } });
    expect(parsed).toMatchObject({ origin: { kind: 'peer', name: '<Sender>' },
      message: { content: 'From <Sender>:\n\nFirst line\n\n<code>body</code>' } });
  });

  it('returns null for empty lines', () => {
    expect(parseRawJsonLinesLine('')).toBeNull();
    expect(parseRawJsonLinesLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseRawJsonLinesLine('{')).toBeNull();
    expect(parseRawJsonLinesLine('not json')).toBeNull();
  });

  it('parses a valid assistant message and preserves unknown fields', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      extra_field: { nested: true },
    });
    const parsed = parseRawJsonLinesLine(line);
    expect(parsed?.type).toBe('assistant');
    expect((parsed as any).uuid).toBe('u1');
    expect((parsed as any).extra_field).toEqual({ nested: true });
  });

  it('parses a valid user message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'user',
      uuid: 'u2',
      message: { role: 'user', content: 'hello' },
    });
    expect(parsed?.type).toBe('user');
    expect((parsed as any).uuid).toBe('u2');
  });

  it('parses a progress message', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'progress',
      uuid: 'p1',
      status: 'running',
    });
    expect(parsed?.type).toBe('progress');
    expect((parsed as any)?.uuid).toBe('p1');
  });

  it('parses a goal_status attachment record and preserves the inner attachment object', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'attachment',
      uuid: 'a1',
      sessionId: 's1',
      timestamp: '2026-06-19T14:39:26.067Z',
      attachment: { type: 'goal_status', met: false, condition: 'ship it', sentinel: true },
    });
    expect(parsed?.type).toBe('attachment');
    expect((parsed as any)?.uuid).toBe('a1');
    expect((parsed as any)?.attachment).toEqual({
      type: 'goal_status',
      met: false,
      condition: 'ship it',
      sentinel: true,
    });
  });

  it('parses an attachment with an unknown subtype (forward-compatible)', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'attachment',
      attachment: { type: 'agent_listing_delta', agents: [] },
    });
    expect(parsed?.type).toBe('attachment');
    expect((parsed as any)?.attachment?.type).toBe('agent_listing_delta');
  });

  it('does not drop assistant messages when usage schema changes (invalid usage is ignored)', () => {
    const parsed = parseRawJsonLinesObject({
      type: 'assistant',
      uuid: 'u3',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          // Missing required token counts for our structured usage parser.
          output_tokens: 5,
          service_tier: null,
          something_new: true,
        },
      },
    });

    expect(parsed?.type).toBe('assistant');
    expect((parsed as any)?.uuid).toBe('u3');
    expect((parsed as any)?.message?.usage).toBeUndefined();
  });
});
