import { readClaudeTaskLifecycleEnvelope } from '@/backends/claude/taskNotifications/claudeTaskLifecycleEnvelope';
import type { RawJSONLines } from '@/backends/claude/types';

export type ClaudeTranscriptProviderActivity =
  | Readonly<{ type: 'task_notification'; taskId: string | null; toolUseId: string | null; terminal: boolean }>
  | Readonly<{ type: 'task_notification_unknown'; taskId: string | null; toolUseId: string | null }>;

export function isClaudeTranscriptTaskNotification(message: RawJSONLines): boolean {
  return readClaudeTaskLifecycleEnvelope(message)?.subtype === 'task_notification';
}

export function readClaudeTranscriptProviderActivity(message: RawJSONLines): ClaudeTranscriptProviderActivity | null {
  const envelope = readClaudeTaskLifecycleEnvelope(message);
  if (envelope?.subtype !== 'task_notification') return null;
  const { taskId, toolUseId, status } = envelope;
  if (status === 'unknown') return { type: 'task_notification_unknown', taskId, toolUseId };
  return { type: 'task_notification', taskId, toolUseId,
    terminal: status === 'complete' || status === 'failed' || status === 'cancelled' };
}
