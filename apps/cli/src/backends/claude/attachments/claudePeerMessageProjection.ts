import { RawJSONLinesSchema, type RawJSONLines } from '../types';
import { parseClaudeQueuedCommandAttachment } from './claudeAttachmentTypes';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readCrossSessionMessage(text: string) {
  const match = /^\s*<cross-session-message\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/cross-session-message>\s*$/i.exec(text);
  if (!match) return null;
  const attribute = (name: string) => {
    const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(match[1]);
    return nonBlank(value?.[2]);
  };
  const from = attribute('from');
  return from ? { from, name: attribute('from-name'), text: match[2] } : null;
}

export function formatClaudePeerMessageText(name: string | null, text: string): string {
  return `From ${name ?? 'Peer'}:\n\n${text}`;
}

/** Native delivery attachments and SDK peer input share the same conversation projection. */
export function projectClaudePeerMessage(value: unknown): RawJSONLines | null {
  const row = record(value);
  if (!row) return null;
  const attachment = record(row.attachment);
  const nativeOrigin = record(row.origin) ?? record(attachment?.origin);
  const command = parseClaudeQueuedCommandAttachment(value);
  if (command && nativeOrigin && nativeOrigin.kind !== 'peer') return null;
  const message = record(row.message);
  const content = message?.content;
  const peerInput = row.type === 'user' && nativeOrigin?.kind === 'peer';
  const peerTextBlocks = peerInput && Array.isArray(content) && content.length > 0
    && content.every(block => record(block)?.type === 'text' && typeof record(block)?.text === 'string')
    ? content.map(block => record(block)?.text).join('\n') : null;
  const prompt = command?.prompt ?? (peerInput && typeof content === 'string' ? content : peerTextBlocks);
  if (prompt === null) return null;
  const wrapped = readCrossSessionMessage(prompt);
  // A queued attachment proves delivery only for the native cross-session wrapper. Queue
  // operations, ordinary human prompts and unknown attachment kinds remain internal.
  if (!wrapped && peerTextBlocks === null) return null;
  const from = nonBlank(nativeOrigin?.from) ?? wrapped?.from;
  if (!from) return null;
  const name = nonBlank(nativeOrigin?.name) ?? wrapped?.name ?? null;
  const body = wrapped?.text ?? peerTextBlocks;
  if (body === null) return null;
  const { attachment: _attachment, rendered: _rendered, isMeta: _isMeta,
    isCompactSummary: _compact, isVisibleInTranscriptOnly: _transcriptOnly, ...base } = row;
  const projected = RawJSONLinesSchema.safeParse({
    ...base,
    type: 'user',
    origin: { ...nativeOrigin, kind: 'peer', from, ...(name ? { name } : {}) },
    // The UI's existing user-output path renders string content. Projected rows no longer
    // carry the native wrapper, so parsing replayed output does not add the sender twice.
    message: { ...message, role: 'user', content: formatClaudePeerMessageText(name, body) },
  });
  return projected.success ? projected.data : null;
}
