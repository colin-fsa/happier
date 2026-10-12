import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isClaudeAsyncAgentLaunchToolResult } from '@happier-dev/protocol';

import { normalizeRawMessage } from '../typesRaw';
import { createReducer, reducer } from './reducer';

function fold(rows: readonly unknown[]) {
    const state = createReducer();
    rows.forEach((data, index) => {
        const raw = { role: 'agent', content: { type: 'output', data } };
        const normalized = normalizeRawMessage(`msg-${index}`, null, index + 1, raw as never, { seq: index + 1 });
        if (normalized) reducer(state, [normalized]);
    });
    return (toolId: string) => {
        const id = state.toolIdToMessageId.get(toolId);
        return id ? state.messages.get(id)?.tool : undefined;
    };
}

const launch = { type: 'assistant', uuid: 'launch', message: { content: [
    { type: 'tool_use', id: 'tool', name: 'Agent', input: { run_in_background: true } },
] } };
const ack = { type: 'user', uuid: 'ack', toolUseResult: { status: 'async_launched', agentId: 'task' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Async agent launched successfully.' }] } };
const persistedCompletion = { type: 'user', uuid: 'completion', isMeta: true,
    origin: { kind: 'task-notification', taskId: 'task', toolUseId: 'tool', status: 'completed' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text', text: 'final findings' }], is_error: false }] } };

describe('native task completion through normalization and reducer', () => {
    // cli-v0.2.16 (b8d1c449c46ab4dfa8637db36b66f643d149e66d), sessionScanner.ts:
    // released task-notification rewrite preserved origin.status but always wrote is_error:false.
    it.each(['completed', 'failed', 'stopped'] as const)('preserves released native task status %s', status => {
        const historicalCompletion = { ...persistedCompletion, origin: { ...persistedCompletion.origin, status } };
        const tool = fold([launch, ack, historicalCompletion, { ...ack, uuid: 'late-ack' }])('tool');
        expect(tool?.state).toBe(status === 'completed' ? 'completed' : 'error');
        expect(isClaudeAsyncAgentLaunchToolResult(tool?.result)).toBe(false);
        expect(JSON.stringify(tool?.result)).toContain('final findings');
    });

    it('reads previously persisted native metadata completions and replaces the acknowledgement once', () => {
        const tool = fold([launch, ack, persistedCompletion, { ...persistedCompletion, uuid: 'repeat' }, { ...ack, uuid: 'replayed-ack' }])('tool');
        expect(tool?.state).toBe('completed');
        expect(isClaudeAsyncAgentLaunchToolResult(tool?.result)).toBe(false);
        expect(JSON.stringify(tool?.result)).toContain('final findings');
        expect(tool?.completedAt).toBe(3);
    });

    it.each([
        { ...persistedCompletion, origin: undefined },
        { ...persistedCompletion, origin: { kind: 'task-notification', toolUseId: 'another-tool' } },
        { ...persistedCompletion, message: { content: [{ type: 'text', text: 'metadata' }] } },
    ])('keeps unrelated metadata inert', row => {
        expect(isClaudeAsyncAgentLaunchToolResult(fold([launch, ack, row])('tool')?.result)).toBe(true);
    });

    // The CLI regression emits these files only for the explicitly requested composed check.
    it.runIf(Boolean(process.env.HAPPIER_TASK_PROJECTION_TEST_OUTPUT)).each(['completed', 'failed', 'stopped'] as const)(
        'reduces real persisted scanner output for %s', async status => {
            const rows: unknown = JSON.parse(await readFile(`${process.env.HAPPIER_TASK_PROJECTION_TEST_OUTPUT}.${status}.json`, 'utf8'));
            if (!Array.isArray(rows)) throw new Error('Expected scanner transcript rows');
            const tool = fold(rows);
            for (const id of ['native-tool', 'early-tool']) {
                expect(tool(id)?.state).toBe(status === 'completed' ? 'completed' : 'error');
                expect(isClaudeAsyncAgentLaunchToolResult(tool(id)?.result)).toBe(false);
                expect(JSON.stringify(tool(id)?.result)).toContain(`native ${status}`);
            }
        },
    );
});
