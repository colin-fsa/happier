import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeServerRuntimeClient } from './client';

/**
 * Wire fixtures are pinned to released OpenCode v2.0.15
 * (github.com/anomalyco/opencode @ 6f3639d82ed0760091792189b78f8eeb44f699b1), derived from
 * `packages/protocol/openapi.json`, `packages/schema/src/**` and frames captured from the real
 * binary. Anything the release does not publish must not appear on the wire here.
 */
type Call = { path: string; method: string; search: string; body?: unknown };

function stubReleasedV2Server(
  handle: (call: Call, url: URL) => Response | undefined,
): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      path: url.pathname,
      method: init?.method ?? 'GET',
      search: url.search,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    // The release exposes `/api/info`; `/api/health` and `/global/health` do not exist.
    if (url.pathname === '/api/info') {
      return Response.json({ version: '2.0.15', pid: 4242, urls: ['http://127.0.0.1:9999'], paths: { tmp: '/tmp' } });
    }
    if (url.pathname === '/api/health' || url.pathname === '/global/health' || url.pathname === '/mcp') {
      return new Response('{}', { status: 404 });
    }
    return handle(call, url) ?? (url.pathname === '/api/integration'
      ? Response.json({ data: [] }) : new Response(null, { status: 204 }));
  }));
  return { calls };
}

async function makeReleasedV2Client(env: NodeJS.ProcessEnv = {}) {
  return await createOpenCodeServerRuntimeClient({
    directory: '/repo',
    messageBuffer: { push: () => {} } as never,
    env: { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:9999', ...env },
  });
}

describe('OpenCodeServerRuntimeClient released V2 contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retains V1 frontend-local selection without writing unsupported native model routes', async () => {
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') writes.push(url.pathname);
      return url.pathname === '/global/health'
        ? Response.json({ healthy: true, version: '1.18.33' })
        : new Response(null, { status: 404 });
    }));
    const client = await makeReleasedV2Client();
    try {
      await client.sessionSetModel({
        sessionId: 'ses_v1', model: { providerID: 'openai', modelID: 'cheap-model' }, variant: 'low',
      });
      await client.sessionSetAgent({ sessionId: 'ses_v1', agent: 'plan' });
      expect(writes).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it.each([
    ['/api/provider', {}], ['/api/model', {}],
    ['/api/provider', { data: [{}] }], ['/api/model', { data: [{}] }],
  ])('rejects malformed %s inventory (%j) instead of observing an empty inventory', async (malformedPath, payload) => {
    stubReleasedV2Server((call) => Response.json(call.path === malformedPath ? payload : { data: [] }));
    const client = await makeReleasedV2Client();
    await expect(client.providersList()).rejects.toThrow(/provider inventory/i);
  });

  it('preserves V1 synthetic text and native agent parts without changing the legacy envelope', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        search: url.search,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.pathname === '/global/health') return Response.json({ healthy: true, version: '1.18.33' });
      if (url.pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    }));
    const client = await makeReleasedV2Client();
    const parts = [
      { type: 'skill', id: 'vendor-skill-id', text: 'Use the reviewer skill.' },
      { type: 'text', text: 'Review this change' },
      { type: 'agent', name: 'reviewer' },
    ];
    try {
      await client.sessionPromptAsync({ sessionId: 'ses_v1', messageId: 'msg_1', parts });
      expect(calls.find((call) => call.path.endsWith('/prompt_async'))).toEqual({
        path: '/session/ses_v1/prompt_async',
        method: 'POST',
        search: '?directory=%2Frepo',
        body: { messageID: 'msg_1', parts: [
          { type: 'text', text: 'Use the reviewer skill.', synthetic: true },
          { type: 'text', text: 'Review this change' },
          { type: 'agent', name: 'reviewer' },
        ] },
      });
    } finally {
      await client.dispose();
    }
  });

  it('accepts an explicitly empty provider and model inventory', async () => {
    stubReleasedV2Server(() => Response.json({ data: [] }));
    const client = await makeReleasedV2Client();
    await expect(client.providersList()).resolves.toEqual([]);
  });

  it('drives the released session lifecycle with released routes, payloads and envelopes', async () => {
    const session = { id: 'ses_1', location: { directory: '/repo' }, title: 'first' };
    const { calls } = stubReleasedV2Server((call, url) => {
      if (call.path === '/api/session' && call.method === 'POST') return Response.json({ data: session });
      if (call.path === '/api/session' && call.method === 'GET') {
        return url.searchParams.get('cursor') === 'page-2'
          ? Response.json({ data: [{ id: 'ses_2', location: { directory: '/repo' } }], cursor: {} })
          : Response.json({ data: [session], cursor: { next: 'page-2' } });
      }
      if (call.path === '/api/session/ses_1' && call.method === 'GET') return Response.json({ data: session });
      if (call.path === '/api/session/ses_1' && call.method === 'PATCH') return new Response(null, { status: 204 });
      if (call.path === '/api/session/ses_1/diff') return Response.json({ data: [{ file: 'a.ts', patch: '@@', additions: 1, deletions: 0, status: 'modified' }] });
      if (call.path === '/api/session/ses_1/fork') return Response.json({ data: { id: 'ses_forked', location: { directory: '/repo' } } });
      if (call.path === '/api/session/ses_1/compact') return Response.json({ data: { id: 'inb_1', type: 'compaction' } });
      if (call.path === '/api/session/ses_1/interrupt') return Response.json({ interrupted: true });
      if (call.path === '/api/model/default') return Response.json({ location: { directory: '/repo' }, data: { id: 'gpt-5', modelID: 'gpt-5', providerID: 'openai' } });
      return undefined;
    });

    const client = await makeReleasedV2Client();
    const ruleset = [{ permission: 'bash', pattern: '*', action: 'ask' }];

    await expect(client.sessionCreate({ permission: ruleset })).resolves.toEqual({ id: 'ses_1', directory: '/repo', title: 'first' });
    // `Permission.Rule` is `{ action, resource, effect }`; Happier's V1 ruleset shape is renamed here.
    expect(calls.find((c) => c.path === '/api/session' && c.method === 'POST')?.body).toEqual({
      location: { directory: '/repo' },
      permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
    });

    // `GET /api/session` returns the newest 50 by default, so every page must be followed.
    await expect(client.sessionList()).resolves.toEqual([
      { id: 'ses_1', directory: '/repo', title: 'first' },
      { id: 'ses_2', directory: '/repo' },
    ]);
    const listCalls = calls.filter((c) => c.path === '/api/session' && c.method === 'GET');
    expect(listCalls.map((c) => c.search)).toEqual(['?directory=%2Frepo&order=asc', '?cursor=page-2']);

    await client.sessionUpdate({ sessionId: 'ses_1', title: 'renamed', permission: ruleset });
    expect(calls.find((c) => c.path === '/api/session/ses_1' && c.method === 'PATCH')?.body).toEqual({
      title: 'renamed',
      permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
    });

    await expect(client.sessionDiff({ sessionId: 'ses_1', messageId: 'msg_u1' })).resolves.toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/session/ses_1/diff')?.search).toBe('?from=msg_u1');

    await expect(client.sessionFork({ sessionId: 'ses_1', messageId: 'msg_u1' })).resolves.toEqual({ id: 'ses_forked', directory: '/repo' });
    expect(calls.find((c) => c.path === '/api/session/ses_1/fork')?.body).toEqual({ before: 'msg_u1' });

    // Manual compaction exists in the release; it is not "unavailable".
    await client.sessionSummarize({ sessionId: 'ses_1', model: { providerID: 'openai', modelID: 'gpt-5' }, auto: false });
    expect(calls.find((c) => c.path === '/api/session/ses_1/compact')?.body).toEqual({ delivery: 'steer' });

    await client.sessionAbort({ sessionId: 'ses_1' });
    // `session.interrupt` declares no payload and parses strictly.
    expect(calls.find((c) => c.path === '/api/session/ses_1/interrupt')?.body).toBeUndefined();

    await expect(client.globalConfigGet()).resolves.toEqual({ model: 'openai/gpt-5' });

    expect(calls.map((c) => c.path)).not.toContain('/api/session/ses_1/history');
    expect(calls.map((c) => c.path)).not.toContain('/session/ses_1/diff');
    expect(calls.map((c) => c.path)).not.toContain('/session/ses_1/fork');
    await client.dispose();
  });

  it('sends a flat released prompt payload and pages messages into anchored turns', async () => {
    const { calls } = stubReleasedV2Server((call, url) => {
      if (call.path === '/api/session/ses_1/message') {
        return url.searchParams.get('cursor') === 'next'
          ? Response.json({
            data: [
              { id: 'msg_s1', type: 'synthetic', time: { created: 2 }, text: '<subagent-completion>private injected result</subagent-completion>', metadata: { source: 'subagent', childID: 'ses_child' } },
              { id: 'msg_a1', type: 'assistant', time: { created: 3 }, agent: 'build', content: [{ type: 'text', id: 'prt_1', text: 'hi' }] },
            ],
            cursor: {},
          })
          : Response.json({
            data: [{ id: 'msg_u1', type: 'user', time: { created: 1 }, text: 'hello' }],
            cursor: { next: 'next' },
          });
      }
      if (call.path === '/api/session/ses_1/prompt') return Response.json({ data: { id: 'msg_u2', type: 'user' } });
      return undefined;
    });

    const client = await makeReleasedV2Client();

    await client.sessionPromptAsync({
      sessionId: 'ses_1',
      messageId: 'msg_u2',
      parts: [
        { type: 'text', text: 'Use the reviewer skill.', synthetic: true },
        { type: 'text', text: 'ship it' },
        { type: 'file', url: 'file:///repo/a.png', mime: 'image/png', filename: 'a.png' },
      ],
      model: { providerID: 'openai', modelID: 'gpt-5' },
      variant: 'high',
      agent: 'build',
      delivery: 'steer',
    });

    // `PromptInput` is flat: nesting it under `prompt` is rejected by the released schema.
    expect(calls.find((c) => c.path === '/api/session/ses_1/prompt')?.body).toEqual({
      id: 'msg_u2',
      text: 'Use the reviewer skill.\n\nship it',
      files: [{ uri: 'file:///repo/a.png', name: 'a.png' }],
      delivery: 'steer',
    });
    expect(calls.find((c) => c.path === '/api/session/ses_1/agent')?.body).toEqual({ agent: 'build' });
    expect(calls.find((c) => c.path === '/api/session/ses_1/model')?.body).toEqual({
      model: { id: 'gpt-5', providerID: 'openai', variant: 'high' },
    });

    // Released assistant messages carry no parentID; the turn anchor is inferred across pages.
    const messages = await client.sessionMessagesList({ sessionId: 'ses_1' }) as Array<{ info: Record<string, unknown>; parts: unknown[] }>;
    expect(messages.map((m) => m.info.id)).toEqual(['msg_u1', 'msg_s1', 'msg_a1']);
    expect(messages[1]).toMatchObject({ info: { role: 'synthetic' }, parts: [] });
    expect(messages[2]!.info.parentID).toBe('msg_u1');
    expect(messages[2]!.parts).toMatchObject([{ type: 'text', text: 'hi' }]);
    await client.dispose();
  });

  it.each(['steer', 'queue'] as const)('preserves native agent attachments with %s delivery', async (delivery) => {
    const { calls } = stubReleasedV2Server(() => undefined);
    const client = await makeReleasedV2Client();
    try {
      await client.sessionPromptAsync({
        sessionId: 'ses_1',
        parts: [
          { type: 'text', text: 'Review this change' },
          { type: 'agent', name: 'reviewer' },
          { type: 'skill', id: 'vendor-skill-id', text: 'Use the reviewer skill.' },
        ],
        delivery,
      });
      expect(calls.find((call) => call.path === '/api/session/ses_1/prompt')?.body).toEqual({
        text: 'Review this change',
        agents: [{ name: 'reviewer' }],
        skills: [{ id: 'vendor-skill-id' }],
        delivery,
      });
    } finally {
      await client.dispose();
    }
  });

  it.each(['v1', 'v2'] as const)('discovers catalogs from the %s directory-scoped endpoint after native readiness', async (generation) => {
    const calls: Call[] = [];
    const commands = [{ name: 'review', description: 'Review the current change' }];
    const skills = [{ id: 'native-review', name: 'reviewer', path: '/repo/SKILL.md' }];
    let ready = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', search: url.search });
      if (url.pathname === '/global/health' && generation === 'v1') {
        return Response.json({ healthy: true, version: '1.18.33' });
      }
      if (url.pathname === '/api/info' && generation === 'v2') {
        return Response.json({ version: '2.0.15', pid: 4242, urls: ['http://127.0.0.1:9999'], paths: { tmp: '/tmp' } });
      }
      if (url.pathname === '/command' && generation === 'v1') return Response.json(commands);
      if (url.pathname === '/skill' && generation === 'v1') return Response.json(skills);
      if (url.pathname === '/api/integration' && generation === 'v2') {
        expect(url.searchParams.get('location[directory]')).toBe('/repo');
        ready = true;
        return Response.json({ location: { directory: '/repo' }, data: [] });
      }
      if (url.pathname === '/api/command' && generation === 'v2') return Response.json({ data: ready ? commands : [] });
      if (url.pathname === '/api/skill' && generation === 'v2') return Response.json({ data: ready ? skills : [] });
      return new Response(null, { status: 404 });
    }));
    const client = await makeReleasedV2Client();
    try {
      await expect(client.appCommands()).resolves.toEqual(commands);
      // A directory-scoped read must still wait after a later native reload.
      ready = false;
      await expect(client.appSkills()).resolves.toEqual(skills);
      expect(calls.find((call) => call.path.endsWith('/command'))).toEqual({
        path: generation === 'v2' ? '/api/command' : '/command',
        method: 'GET',
        search: generation === 'v2' ? '?location%5Bdirectory%5D=%2Frepo' : '?directory=%2Frepo',
      });
    } finally {
      await client.dispose();
    }
  });

  it('does not publish an empty catalog when V2 native readiness fails', async () => {
    const { calls } = stubReleasedV2Server((call) => call.path === '/api/integration'
      ? new Response(null, { status: 503 }) : Response.json({ data: [] }));
    const client = await makeReleasedV2Client();
    try {
      await expect(client.appSkills()).rejects.toThrow(/503/);
      expect(calls.some((call) => call.path === '/api/skill')).toBe(false);
    } finally {
      await client.dispose();
    }
  });

  it('executes V1 native commands with the legacy arguments and file envelope', async () => {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', search: url.search,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.pathname === '/global/health') return Response.json({ healthy: true, version: '1.18.33' });
      if (url.pathname.endsWith('/command')) return Response.json({ info: { id: 'msg_native' }, parts: [] });
      return new Response(null, { status: 404 });
    }));
    const client = await makeReleasedV2Client();
    const parts = [{ type: 'file', url: 'file:///repo/a.png', mime: 'image/png', filename: 'a.png' }];
    try {
      await client.sessionCommand({ sessionId: 'ses_1', command: 'review', arguments: 'main', messageId: 'msg_1',
        parts, model: { providerID: 'openai', modelID: 'gpt-5' }, agent: 'build', variant: 'high' });
      expect(calls.find((call) => call.path.endsWith('/command'))).toEqual({
        path: '/session/ses_1/command', method: 'POST', search: '?directory=%2Frepo',
        body: { command: 'review', arguments: 'main', messageID: 'msg_1', parts,
          model: 'openai/gpt-5', agent: 'build', variant: 'high' },
      });
    } finally { await client.dispose(); }
  });

  it.each(['steer', 'queue'] as const)('executes V2 native command callbacks with %s delivery and prompt attachments', async (delivery) => {
    const { calls } = stubReleasedV2Server(() => undefined);
    const client = await makeReleasedV2Client();
    try {
      await client.sessionCommand({ sessionId: 'ses_1', command: 'review', arguments: 'main', messageId: 'msg_local',
        delivery, model: { providerID: 'openai', modelID: 'gpt-5' }, agent: 'build', variant: 'high', parts: [
          { type: 'skill', id: 'vendor-skill-id', text: 'Use the reviewer skill.' },
          { type: 'file', url: 'file:///repo/a.png', mime: 'image/png', filename: 'a.png' },
          { type: 'agent', name: 'reviewer' },
        ] });
      expect(calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
        '/api/session/ses_1/agent', '/api/session/ses_1/model', '/api/session/ses_1/command',
      ]);
      expect(calls.find((call) => call.path.endsWith('/command'))?.body).toEqual({
        name: 'review', text: 'main', files: [{ uri: 'file:///repo/a.png', name: 'a.png' }],
        agents: [{ name: 'reviewer' }], skills: [{ id: 'vendor-skill-id' }], delivery,
      });
    } finally { await client.dispose(); }
  });

  it.each([
    { delivery: 'steer' as const, reason: 'delivery' },
    { parts: [{ type: 'agent', name: 'reviewer' }], reason: 'attachments' },
    { parts: [{ type: 'skill', id: 'vendor-skill-id', text: 'Skill instructions' }], reason: 'attachments' },
  ])('rejects unsupported V1 command input before any write: $reason', async ({ reason, ...input }) => {
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') writes.push(new URL(String(url)).pathname);
      return new URL(String(url)).pathname === '/global/health'
        ? Response.json({ healthy: true, version: '1.18.33' }) : new Response(null, { status: 404 });
    }));
    const client = await makeReleasedV2Client();
    try {
      await expect(client.sessionCommand({ sessionId: 'ses_1', command: 'review', arguments: '', ...input }))
        .rejects.toMatchObject({ code: 'opencode_command_unsupported', reason });
      expect(writes).toEqual([]);
    } finally { await client.dispose(); }
  });

  it('does not replay a native command after ambiguous transport loss', async () => {
    let attempts = 0;
    stubReleasedV2Server((call) => {
      if (call.path.endsWith('/command')) { attempts += 1; throw new TypeError('fetch failed'); }
      return undefined;
    });
    const client = await makeReleasedV2Client();
    try {
      await expect(client.sessionCommand({ sessionId: 'ses_1', command: 'review', arguments: '' })).rejects.toThrow('fetch failed');
      expect(attempts).toBe(1);
    } finally { await client.dispose(); }
  });

  it.each(['prompt', 'command'] as const)('rejects a V2 skill without native identity before %s selection or admission writes', async (operation) => {
    const { calls } = stubReleasedV2Server((call) => call.path === '/api/skill' ? Response.json({ data: [] }) : undefined);
    const client = await makeReleasedV2Client();
    try {
      const input = { sessionId: 'ses_1', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5' },
        parts: [{ type: 'skill', name: 'Legacy Skill', text: 'Legacy skill context' }] };
      const outcome = operation === 'prompt' ? client.sessionPromptAsync(input)
        : client.sessionCommand({ ...input, command: 'review', arguments: '' });
      await expect(outcome).rejects.toMatchObject({ code: 'opencode_skill_identity_missing' });
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    } finally { await client.dispose(); }
  });

  it.each(['prompt', 'command'] as const)('resolves legacy V2 skill names and paths against the same native catalog before %s admission', async (operation) => {
    const skillPath = '/repo/.opencode/skills/folder/SKILL.md';
    const { calls } = stubReleasedV2Server((call) => call.path === '/api/skill' ? Response.json({ data: [
      { id: 'exact-native-id', name: 'Reviewer Skill', path: skillPath, content: 'Instructions' },
      { id: 'other-native-id', name: 'Reviewer Skill', path: '/other/SKILL.md', content: 'Other instructions' },
    ] }) : undefined);
    const client = await makeReleasedV2Client();
    try {
      const parts = [{ type: 'skill', name: 'Reviewer Skill', path: skillPath, text: 'Legacy fallback instructions' }];
      if (operation === 'prompt') await client.sessionPromptAsync({ sessionId: 'ses_1', parts: [{ type: 'text', text: 'Review this' }, ...parts] });
      else await client.sessionCommand({ sessionId: 'ses_1', command: 'review', arguments: 'Review this', parts });
      expect(calls.find((call) => call.path === `/api/session/ses_1/${operation}`)?.body).toEqual({
        ...(operation === 'command' ? { name: 'review' } : {}), text: 'Review this', skills: [{ id: 'exact-native-id' }],
      });
      expect(calls.filter((call) => call.path === '/api/skill')).toHaveLength(1);
    } finally { await client.dispose(); }
  });

  it.each([
    { name: 'Reviewer Skill' },
    { name: 'Reviewer Skill', path: '/missing/SKILL.md' },
  ])('rejects ambiguous or unmatched legacy V2 skill identity without native effects: %j', async (legacy) => {
    const { calls } = stubReleasedV2Server((call) => call.path === '/api/skill' ? Response.json({ data: [
      { id: 'one', name: 'Reviewer Skill', path: '/one/SKILL.md' },
      { id: 'two', name: 'Reviewer Skill', path: '/two/SKILL.md' },
    ] }) : undefined);
    const client = await makeReleasedV2Client();
    try {
      await expect(client.sessionPromptAsync({ sessionId: 'ses_1', agent: 'build', parts: [
        { type: 'skill', text: 'Fallback instructions', ...legacy },
      ] })).rejects.toMatchObject({ code: 'opencode_skill_identity_missing' });
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    } finally { await client.dispose(); }
  });

  it('resolves a legacy name-only V2 skill when its native catalog identity is unique', async () => {
    const { calls } = stubReleasedV2Server((call) => call.path === '/api/skill'
      ? Response.json({ data: [{ id: 'exact-native-id', name: 'Reviewer Skill', path: '/repo/folder/SKILL.md' }] }) : undefined);
    const client = await makeReleasedV2Client();
    try {
      await client.sessionPromptAsync({ sessionId: 'ses_1', parts: [
        { type: 'text', text: 'Review this' }, { type: 'skill', name: 'Reviewer Skill', text: 'Fallback instructions' },
      ] });
      expect(calls.find((call) => call.path === '/api/session/ses_1/prompt')?.body).toEqual({
        text: 'Review this', skills: [{ id: 'exact-native-id' }],
      });
    } finally { await client.dispose(); }
  });

  it.each(['v1', 'v2'] as const)('keeps a %s native command alive past the control timeout and cancels its transport on disposal', async (generation) => {
    const observation: { signal: AbortSignal | null } = { signal: null };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/global/health' && generation === 'v1') return Response.json({ healthy: true, version: '1.18.33' });
      if (path === '/api/info' && generation === 'v2') return Response.json({ version: '2.0.15', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      if (path.endsWith('/command')) {
        observation.signal = init?.signal ?? null;
        return await new Promise<Response>((_resolve, reject) => {
          observation.signal?.addEventListener('abort', () => reject(new DOMException('Request aborted', 'AbortError')), { once: true });
        });
      }
      return new Response(null, { status: 404 });
    }));
    const client = await makeReleasedV2Client({ HAPPIER_OPENCODE_SERVER_HTTP_TIMEOUT_MS: '1000' });
    vi.useFakeTimers();
    const outcome = client.sessionCommand({ sessionId: 'ses_1', command: 'review', arguments: '' })
      .then(() => null, (error: unknown) => error);
    try {
      await vi.waitFor(() => expect(observation.signal).not.toBeNull());
      await vi.advanceTimersByTimeAsync(1001);
      expect(observation.signal?.aborted).toBe(false);
      await client.dispose();
      expect(observation.signal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ name: 'AbortError' });
    } finally {
      await client.dispose();
      vi.useRealTimers();
    }
  });

  it('answers permissions and forms through the released routes and payloads', async () => {
    const form = {
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 'Configure',
      fields: [
        { key: 'region', type: 'string', title: 'Region', options: [{ value: 'eu-west', label: 'Europe' }] },
        { key: 'tags', type: 'multiselect', title: 'Tags', options: [{ value: 't1', label: 'One' }, { value: 't2', label: 'Two' }] },
        { key: 'telemetry', type: 'boolean', title: 'Telemetry', default: true, hidden: true },
      ],
    };
    const { calls } = stubReleasedV2Server((call) => {
      if (call.path === '/api/form') return Response.json({ location: { directory: '/repo' }, data: [form] });
      if (call.path === '/api/permission/request') {
        return Response.json({
          location: { directory: '/repo' },
          data: [{ id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['git status'], save: ['git *'], source: { type: 'tool', messageID: 'msg_a1', id: 'call_1' } }],
        });
      }
      return undefined;
    });

    const client = await makeReleasedV2Client();

    // `Permission.Request` renames every field Happier reads, and its tool source uses `id`.
    await expect(client.permissionList()).resolves.toEqual([{
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'bash',
      patterns: ['git status'],
      always: ['git *'],
      metadata: {},
      tool: { messageID: 'msg_a1', callID: 'call_1' },
    }]);

    await expect(client.permissionReply({ requestId: 'per_1', reply: 'once' })).resolves.toBe(true);
    expect(calls.find((c) => c.path === '/api/session/ses_1/permission/per_1/reply')?.body).toEqual({ decision: 'once' });

    // Questions became forms: `/api/question/request` does not exist in the release.
    const questions = await client.questionList() as Array<{ id: string; questions: Array<Record<string, unknown>> }>;
    expect(calls.map((c) => c.path)).toContain('/api/form');
    expect(calls.map((c) => c.path)).not.toContain('/api/question/request');
    expect(questions[0]!.id).toBe('frm_1');
    // The hidden field is not asked; it still contributes its default to the reply.
    expect(questions[0]!.questions.map((q) => q.header)).toEqual(['Region', 'Tags']);

    await expect(client.questionReply({ requestId: 'frm_1', answers: [['Europe'], ['One', 'Two']] })).resolves.toBe(true);
    expect(calls.find((c) => c.path === '/api/session/ses_1/form/frm_1/reply')?.body).toEqual({
      answer: { telemetry: true, region: 'eu-west', tags: ['t1', 't2'] },
    });

    await expect(client.questionReject({ requestId: 'frm_1' })).resolves.toBe(true);
    // Cancelling is a DELETE; there is no `/reject` route.
    expect(calls).toContainEqual(expect.objectContaining({ path: '/api/session/ses_1/form/frm_1', method: 'DELETE' }));
    await client.dispose();
  });

  it('registers dynamic MCP through the released experimental route and reports real readiness', async () => {
    let status: Record<string, unknown> = { status: 'pending' };
    const { calls } = stubReleasedV2Server((call) => {
      if (call.path === '/api/experimental/mcp/happier') return new Response(null, { status: 204 });
      if (call.path === '/api/mcp') {
        const body = Response.json({ location: { directory: '/repo' }, data: [{ name: 'happier', status }] });
        status = { status: 'connected' };
        return body;
      }
      return undefined;
    });

    const client = await makeReleasedV2Client();
    // Dynamic MCP exists on a pure released V2 server; it must not be declared unavailable.
    await expect(client.mcpAdd({
      name: 'happier',
      config: { type: 'local', enabled: true, command: ['happier', 'mcp'], environment: { A: 'b' } },
    })).resolves.toEqual({ status: 'connected' });

    const put = calls.find((c) => c.path === '/api/experimental/mcp/happier');
    expect(put?.method).toBe('PUT');
    expect(put?.search).toBe('?location%5Bdirectory%5D=%2Frepo');
    // `Mcp.LocalConfig` has no `enabled`; a strict parse rejects the unknown key.
    expect(put?.body).toEqual({ config: { type: 'local', command: ['happier', 'mcp'], environment: { A: 'b' } } });
    await client.mcpDisconnect({ directory: '/repo/other', name: 'happier' });
    expect(calls).toContainEqual(expect.objectContaining({
      path: '/api/experimental/mcp/happier',
      method: 'DELETE',
      search: '?location%5Bdirectory%5D=%2Frepo%2Fother',
    }));
    expect(calls.map((c) => c.path)).not.toContain('/mcp');
    await client.dispose();
  });

  it('surfaces a released MCP failure status truthfully instead of reporting readiness', async () => {
    stubReleasedV2Server((call) => {
      if (call.path === '/api/experimental/mcp/happier') return new Response(null, { status: 204 });
      if (call.path === '/api/mcp') {
        return Response.json({ location: { directory: '/repo' }, data: [{ name: 'happier', status: { status: 'failed', error: 'spawn ENOENT' } }] });
      }
      return undefined;
    });

    const client = await makeReleasedV2Client();
    await expect(client.mcpAdd({ name: 'happier', config: { type: 'local', command: ['nope'] } }))
      .resolves.toEqual({ status: 'failed', error: 'spawn ENOENT' });
    await client.dispose();
  });

  it('translates the released global event vocabulary into the runtime vocabulary', async () => {
    // Frames captured from the real v2.0.15 binary. Durable-definition frames arrive here too:
    // `Bus` defaults to `persist: false`, so the durable log holds nothing and dropping frames
    // that carry `durable` would discard every terminal, text and tool event.
    const frames = [
      { id: 'evt_0', type: 'server.connected', data: {} },
      { id: 'evt_1', type: 'session.execution.started', durable: { aggregateID: 'ses_1', seq: 1, version: 1 }, data: { sessionID: 'ses_1' } },
      { id: 'evt_2', type: 'session.text.started', durable: { aggregateID: 'ses_1', seq: 2, version: 1 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0 }, location: { directory: '/repo' } },
      { id: 'evt_3', type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 0, delta: 'hel' }, location: { directory: '/repo' } },
      { id: 'evt_4', type: 'session.reasoning.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', ordinal: 1, delta: 'thinking' }, location: { directory: '/repo' } },
      { id: 'evt_5', type: 'session.tool.success', durable: { aggregateID: 'ses_1', seq: 3, version: 2 }, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a1', id: 'call_1', executed: true, content: [{ type: 'text', text: 'ok' }] }, location: { directory: '/repo' } },
      { id: 'evt_6', type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['git status'] }, location: { directory: '/repo' } },
      { id: 'evt_7', type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Pick', fields: [{ key: 'k', type: 'string', title: 'K' }] } }, location: { directory: '/repo' } },
      { id: 'evt_8', type: 'session.execution.succeeded', durable: { aggregateID: 'ses_1', seq: 4, version: 1 }, data: { sessionID: 'ses_1' } },
    ];
    const { calls } = stubReleasedV2Server((call) => {
      if (call.path !== '/api/event') return undefined;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });

    const client = await makeReleasedV2Client();
    const abort = new AbortController();
    const received: Array<{ type: string; properties: any; provenance: string }> = [];
    await client.subscribeGlobalEvents({
      sessionId: 'ses_1',
      signal: abort.signal,
      onEvent: (event, delivery) => {
        received.push({ type: event.payload.type, properties: event.payload.properties, provenance: delivery.provenance });
        if (event.payload.type === 'session.idle') abort.abort();
      },
    });
    await vi.waitFor(() => expect(received.map((e) => e.type)).toContain('session.idle'), { timeout: 8_000 });

    // The release has no per-session durable stream worth reading, and no `/history` page.
    expect(calls.map((c) => c.path)).toContain('/api/event');
    expect(calls.map((c) => c.path).some((p) => p.includes('/log'))).toBe(false);
    expect(calls.map((c) => c.path).some((p) => p.includes('/history'))).toBe(false);

    expect(received.map((e) => e.type)).toEqual([
      'server.connected',
      'session.status',
      'session.next.text.started',
      'message.part.delta',
      'message.part.delta',
      'session.next.tool.success',
      'permission.asked',
      'question.asked',
      'session.idle',
    ]);
    expect(received[0]!.provenance).toBe('connection-boundary');
    expect(received.slice(1).every((e) => e.provenance === 'accepted-live')).toBe(true);

    // V2 identifies a streamed part by (assistantMessageID, ordinal) and states the part kind so a
    // live delta never depends on the `*.started` frame having arrived first.
    expect(received[3]!.properties).toEqual({ sessionID: 'ses_1', messageID: 'msg_a1', partID: 'msg_a1:text:0', delta: 'hel', partType: 'text' });
    expect(received[4]!.properties).toEqual({ sessionID: 'ses_1', messageID: 'msg_a1', partID: 'msg_a1:reasoning:1', delta: 'thinking', partType: 'reasoning' });
    expect(received[1]!.properties).toEqual({ sessionID: 'ses_1', status: { type: 'busy' } });
    expect(received[5]!.properties).toMatchObject({ id: 'call_1', assistantMessageID: 'msg_a1' });
    expect(received[6]!.properties).toMatchObject({ id: 'per_1', permission: 'bash', patterns: ['git status'] });
    expect(received[7]!.properties).toMatchObject({ id: 'frm_1', sessionID: 'ses_1' });
    await client.dispose();
  });
});
