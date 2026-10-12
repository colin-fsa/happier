import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameV2, normalizeToolCallV2 } from './index';

describe('canonicalizeToolNameV2', () => {
  it('keeps Delete inference for write tool names', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'write',
        toolInput: { title: 'Delete foo.txt' },
      }),
    ).toBe('Delete');
  });

  it('keeps Delete inference for edit tool names', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'edit',
        toolInput: { title: 'Delete foo.txt' },
      }),
    ).toBe('Delete');
  });

  it('infers CodeSearch for unknown tool names that carry a query', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { query: 'SEARCH_ME', description: 'Searching for: SEARCH_ME' },
      }),
    ).toBe('CodeSearch');
  });

  it('does not infer CodeSearch for unknown tool names that only carry freeform text', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'Something went wrong' },
      }),
    ).toBe('unknown');
  });

  it('infers CodeSearch for unknown tool names when text is paired with a location hint', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'needle', path: 'src/index.ts' },
      }),
    ).toBe('CodeSearch');
  });

  it('does not infer CodeSearch when locations is present but empty', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'needle', locations: [] },
      }),
    ).toBe('unknown');
  });

  it('infers Read for unknown ACP tools labeled as ReadFile', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: {
          description: 'ReadFile',
          _acp: { title: 'ReadFile' },
          items: [{ content: { text: '{"path":"README.md"}', type: 'text' }, type: 'content' }],
        },
      }),
    ).toBe('Read');
  });
});

describe('normalizeToolCallV2', () => {
  it('keeps edit entries non-empty when file path is provided at the tool-call level', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'example-provider',
      toolName: 'edit',
      callId: 'tool-1',
      rawInput: {
        path: 'src/example.ts',
        edits: [{ oldText: 'before', newText: 'after' }],
      },
    });

    expect(normalized.canonicalToolName).toBe('MultiEdit');
    expect(normalized.input).toMatchObject({
      file_path: 'src/example.ts',
      edits: [
        {
          file_path: 'src/example.ts',
          old_string: 'before',
          new_string: 'after',
        },
      ],
      _happier: expect.objectContaining({
        protocol: 'acp',
        provider: 'example-provider',
        rawToolName: 'edit',
        canonicalToolName: 'MultiEdit',
      }),
    });
  });
});

describe('normalizeToolCallV2 (deferred tool execution wrapper)', () => {
  const deferredCall = (toolName: string, params: Record<string, unknown>) => ({
    toolName,
    params,
    locations: [],
    description: 'DeferExecuteTool',
    _acp: { kind: 'other', title: 'DeferExecuteTool', rawInput: { toolName, params } },
  });

  it('normalizes a deferred Happier MCP call as the inner tool with its params as input', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'codebuddy',
      toolName: 'other',
      rawInput: deferredCall('mcp__happier__change_title', { title: 'Renamed' }),
    });

    expect(normalized.canonicalToolName).toBe('change_title');
    expect(normalized.input).toMatchObject({
      title: 'Renamed',
      _happier: expect.objectContaining({ rawToolName: 'other', canonicalToolName: 'change_title' }),
    });
  });

  it('normalizes a deferred custom MCP call as that MCP tool', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'codebuddy',
      toolName: 'other',
      rawInput: deferredCall('mcp__github__search_issues', { query: 'is:open' }),
    });

    expect(normalized.canonicalToolName).toBe('mcp__github__search_issues');
    expect(normalized.input).toMatchObject({ query: 'is:open' });
  });

  it('keeps the generic identity while the inner tool name has not streamed yet', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'codebuddy',
      toolName: 'other',
      rawInput: { ...deferredCall('', {}), params: undefined },
    });

    expect(normalized.canonicalToolName).toBe('other');
  });

  it('preserves ordinary MCP arguments that resemble a deferred wrapper', () => {
    const rawInput = {
      title: 'DeferExecuteTool',
      toolName: 'Bash',
      params: { command: 'echo hello' },
      _acp: { kind: 'other', title: 'mcp__fixture__save_record' },
    };
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'codebuddy',
      toolName: 'mcp__fixture__save_record',
      rawInput,
    });

    expect(normalized.canonicalToolName).toBe('mcp__fixture__save_record');
    expect(normalized.input).toMatchObject(rawInput);
  });

  it('preserves non-ACP tool identity and arguments even with wrapper-shaped data', () => {
    const rawInput = deferredCall('mcp__happier__change_title', { title: 'Renamed' });
    const normalized = normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: 'mcp__fixture__save_record',
      rawInput,
    });

    expect(normalized.canonicalToolName).toBe('mcp__fixture__save_record');
    expect(normalized.input).toMatchObject(rawInput);
  });

  it('uses the extracted arguments for canonical shell tools too', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'codebuddy',
      toolName: 'other',
      rawInput: deferredCall('Bash', { command: 'echo hello' }),
    });

    expect(normalized.canonicalToolName).toBe('Bash');
    expect(normalized.input).toMatchObject({ command: 'echo hello' });
  });

  it('normalizes a deferred shell bridge using the existing inner tool and argument extraction', () => {
    const command = `node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{"title":"QA"}' --json`;
    const normalized = normalizeToolCallV2({
      protocol: 'acp', provider: 'codebuddy', toolName: 'other',
      rawInput: deferredCall('Bash', { command }),
    });
    expect(normalized.canonicalToolName).toBe('change_title');
    expect(normalized.input).toMatchObject({ title: 'QA', _happier: { rawToolName: 'other' } });
  });

  it('retains the inner task operation while preserving outer provenance', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp', provider: 'codebuddy', toolName: 'other',
      rawInput: deferredCall('TaskList', {}),
    });
    expect(normalized.canonicalToolName).toBe('SubAgent');
    expect(normalized.input).toMatchObject({ operation: 'list', _happier: { rawToolName: 'other' } });
  });

  it('preserves an ordinary MCP argument that happens to contain a Happier shell command', () => {
    const rawInput = { command: `node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{"title":"QA"}' --json` };
    const normalized = normalizeToolCallV2({
      protocol: 'acp', provider: 'codebuddy', toolName: 'mcp__fixture__save_record', rawInput,
    });
    expect(normalized.canonicalToolName).toBe('mcp__fixture__save_record');
    expect(normalized.input).toMatchObject(rawInput);
  });
});
