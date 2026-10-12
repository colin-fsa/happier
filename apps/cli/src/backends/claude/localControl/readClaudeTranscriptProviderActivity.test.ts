import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '@/backends/claude/types';
import { readClaudeTranscriptProviderActivity } from './readClaudeTranscriptProviderActivity';

describe('readClaudeTranscriptProviderActivity', () => {
  it('leaves async workflow launches to the workflow runtime-activity owner', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'user',
      sessionId: 'claude-session-1',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_wf',
          content: 'Workflow launched in background. Task ID: wyix5fc6b',
        }],
      },
      toolUseResult: {
        status: 'async_launched',
        taskId: 'wyix5fc6b',
        taskType: 'local_workflow',
      },
    } as unknown as RawJSONLines)).toBeNull();
  });

  it('does not infer Activity from Bash tool results', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'user',
      sessionId: 'claude-session-1',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_bash',
          content:
            'Command running in background with ID: b9c3fz9oq. Output is being written to: /tmp/b9c3fz9oq.output.',
          is_error: false,
        }],
      },
      toolUseResult: {
        stdout: '',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        backgroundTaskId: ' b9c3fz9oq ',
      },
    } as unknown as RawJSONLines)).toBeNull();
  });

  it('does not treat queued or copied prompt XML as delivered task activity', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'queue-operation',
      operation: 'enqueue',
      sessionId: 'claude-session-1',
      content:
        '<task-notification><task-id>task_1</task-id><tool-use-id>toolu_wf</tool-use-id><status>completed</status></task-notification>',
    } as unknown as RawJSONLines)).toBeNull();
    expect(readClaudeTranscriptProviderActivity({ type: 'user', uuid: 'copy', message: {
      content: '<task-notification><task-id>task_1</task-id><status>completed</status></task-notification>',
    } })).toBeNull();
  });

  it('detects terminal task notifications from queued_command attachment prompt XML', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'attachment',
      sessionId: 'claude-session-1',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        prompt:
          '<task-notification><task-id>task_1</task-id><tool-use-id>toolu_wf</tool-use-id><status>failed</status></task-notification>',
      },
    })).toEqual({
      type: 'task_notification',
      taskId: 'task_1',
      toolUseId: 'toolu_wf',
      terminal: true,
    });
  });

  it('detects terminal task notifications from scanner-preserved origin metadata', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'user',
      uuid: 'task-notification-rewritten',
      origin: {
        kind: 'task-notification',
        taskId: 'agent_1',
        status: 'completed',
      },
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_task',
          content: [{ type: 'text', text: 'Background result' }],
          is_error: false,
        }],
      },
    } as unknown as RawJSONLines)).toEqual({
      type: 'task_notification',
      taskId: 'agent_1',
      toolUseId: null,
      terminal: true,
    });
  });

  it('preserves missing task-notification status as unknown instead of inventing running', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'user', uuid: 'unknown-task', origin: { kind: 'task-notification' },
      message: { content: '<task-notification><task-id>task-unknown</task-id></task-notification>' },
    } as unknown as RawJSONLines)).toEqual({
      type: 'task_notification_unknown',
      taskId: 'task-unknown',
      toolUseId: null,
    });
  });

  it('preserves a tool-use-only task notification so workflow ownership can be classified', () => {
    expect(readClaudeTranscriptProviderActivity({
      type: 'user', uuid: 'unknown-tool', origin: { kind: 'task-notification' },
      message: { content: '<task-notification><tool-use-id>toolu-workflow</tool-use-id></task-notification>' },
    } as unknown as RawJSONLines)).toEqual({
      type: 'task_notification_unknown',
      taskId: null,
      toolUseId: 'toolu-workflow',
    });
  });
});
