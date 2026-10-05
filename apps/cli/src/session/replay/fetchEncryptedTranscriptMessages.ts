import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export type RawTranscriptRow = Readonly<{
  id?: unknown;
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  content?: unknown;
  messageRole?: unknown;
  sidechainId?: unknown;
}>;

export type FetchEncryptedTranscriptMessagesPageResult = Readonly<{
  messages: readonly RawTranscriptRow[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
}>;

export async function fetchEncryptedTranscriptMessagesPage(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
  afterSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
}>): Promise<FetchEncryptedTranscriptMessagesPageResult> {
  const serverUrl = resolveServerHttpBaseUrl();
  const beforeSeq = typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq)
    ? Math.max(0, Math.floor(params.beforeSeq)) : undefined;
  const afterSeq = typeof params.afterSeq === 'number' && Number.isFinite(params.afterSeq)
    ? Math.max(0, Math.floor(params.afterSeq)) : undefined;
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: {
      limit: params.limit,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
      ...(params.role ? { role: params.role } : {}),
      ...(params.roles && params.roles.length > 0 ? { roles: params.roles.join(',') } : {}),
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, `Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  // Released server-v0.2.12 returns an explicit page and continuation. A malformed
  // successful response is not proof of empty/complete committed history.
  const data: unknown = response.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Invalid transcript messages page');
  }
  const page = data as Record<string, unknown>;
  if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid transcript messages page');
  }
  const messages: RawTranscriptRow[] = page.messages.map((row: unknown) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error('Invalid transcript message row');
    }
    return row as Record<string, unknown>;
  });
  const hasMore = page.hasMore;
  const readCursor = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid transcript page cursor');
    }
    return value;
  };
  const nextBeforeSeq = readCursor(page.nextBeforeSeq);
  const nextAfterSeq = readCursor(page.nextAfterSeq);
  if (hasMore && (messages.length === 0 || (afterSeq !== undefined
    ? nextAfterSeq === null || nextAfterSeq <= afterSeq
    : nextBeforeSeq === null || (beforeSeq !== undefined && nextBeforeSeq >= beforeSeq)))) {
    throw new Error('Transcript page continuation cannot advance');
  }

  return { messages, hasMore, nextBeforeSeq, nextAfterSeq };
}

export async function fetchEncryptedTranscriptMessages(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
  scope?: 'main' | 'sidechain' | 'all';
  sidechainId?: string | null;
  role?: 'user' | 'agent' | 'event' | 'unknown';
  roles?: readonly ('user' | 'agent' | 'event' | 'unknown')[];
}>): Promise<RawTranscriptRow[]> {
  return (await fetchEncryptedTranscriptMessagesPage(params)).messages as RawTranscriptRow[];
}
