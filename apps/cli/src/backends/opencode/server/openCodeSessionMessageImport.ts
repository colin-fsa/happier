import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { CommittedTranscriptIdentitySnapshot } from '@/api/session/transcriptQueries';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

import { classifyOpenCodeMessageForProjection, extractOpenCodeProjectedText } from '../transcriptProjection';
import { asRecord } from './openCodeParsing';
import { resolveOpenCodeUserMessageIdFromMetadata } from './openCodeUserMessageIds';

export type OpenCodeTextHistoryItem = Readonly<{
  messageId: string;
  role: 'user' | 'assistant';
  createdAtMs: number;
  text: string;
}>;

export function extractOpenCodeTextHistoryItems(rawMessages: unknown[]): OpenCodeTextHistoryItem[] {
  if (!Array.isArray(rawMessages)) return [];
  const items: OpenCodeTextHistoryItem[] = [];
  for (const msg of rawMessages) {
    const rec = asRecord(msg);
    if (!rec) continue;
    const projection = classifyOpenCodeMessageForProjection(rec);
    const role = projection.role;
    if (projection.kind !== 'user_transcript' && projection.kind !== 'assistant_transcript') continue;
    if (!role) continue;
    const messageId = projection.messageId;
    if (!messageId) continue;
    const parts = Array.isArray(rec.parts) ? rec.parts : [];
    const text = extractOpenCodeProjectedText(parts, { context: 'history_import' });
    if (!text) continue;
    items.push({
      messageId,
      role,
      createdAtMs: projection.createdAtMs,
      text,
    });
  }
  items.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return items;
}

function buildImportLocalId(params: { kind: 'history' | 'sidechain'; remoteSessionId: string; messageId: string; sidechainId?: string }): string {
  const tuple = [params.kind, params.remoteSessionId,
    params.kind === 'sidechain' ? params.sidechainId || null : null, params.messageId];
  // Preserve released IDs for unambiguous tuples. Opaque IDs containing the old
  // delimiter need an injective encoding, otherwise relay localId dedupe loses messages.
  if (tuple.some((part) => typeof part === 'string' && part.includes(':'))) {
    return `opencode:import:v2:${JSON.stringify(tuple)}`;
  }
  return buildLegacyImportLocalId(params);
}

// cli-v0.2.12 persisted this shape; compare the full ID with an exact saved SID
// witness rather than attempting to split opaque provider identifiers.
function buildLegacyImportLocalId(params: { kind: 'history' | 'sidechain'; remoteSessionId: string; messageId: string; sidechainId?: string }): string {
  const sidechainPart = params.kind === 'sidechain' && typeof params.sidechainId === 'string' && params.sidechainId ? `:${params.sidechainId}` : '';
  return `opencode:import:${params.kind}:${params.remoteSessionId}${sidechainPart}:${params.messageId}`;
}

export function reconcileOpenCodeCommittedHistoryIdentities(params: Readonly<{
  baseline: CommittedTranscriptIdentitySnapshot;
  metadata: unknown;
  remoteSessionId: string;
  items: ReadonlyArray<OpenCodeTextHistoryItem>;
}>): Readonly<{ observedMessageIds: ReadonlySet<string>; complete: boolean; unmappedUsers: number; unmappedAgents: number }> {
  const observedMessageIds = new Set<string>();
  const nativeUserIds = new Set(params.items.filter((item) => item.role === 'user').map((item) => item.messageId));
  const importedByLocalId = new Map(params.items.map((item) => [
    buildImportLocalId({ kind: 'history', remoteSessionId: params.remoteSessionId, messageId: item.messageId }), item,
  ]));
  const legacyImportedByLocalId = new Map(params.items.map((item) => [
    buildLegacyImportLocalId({ kind: 'history', remoteSessionId: params.remoteSessionId, messageId: item.messageId }), item,
  ]));
  let unmappedUsers = 0;
  let unmappedAgents = 0;
  for (const row of params.baseline.rows) {
    if (row.provider && row.provider !== 'opencode') continue;
    const remoteId = readNonBlankOpaqueIdentifier(row.meta?.opencodeRemoteSessionId)
      ?? readNonBlankOpaqueIdentifier(row.meta?.remoteSessionId);
    if (remoteId && remoteId !== params.remoteSessionId) continue;
    const imported = row.localId ? importedByLocalId.get(row.localId)
      ?? (remoteId === params.remoteSessionId ? legacyImportedByLocalId.get(row.localId) : undefined) : null;
    if (imported && (imported.role === 'user' ? 'user' : 'agent') === row.role) {
      observedMessageIds.add(imported.messageId);
      continue;
    }
    if (row.role === 'user') {
      const mapped = row.localId ? resolveOpenCodeUserMessageIdFromMetadata(params.metadata, row.localId) : null;
      if (mapped && nativeUserIds.has(mapped)) observedMessageIds.add(mapped);
      else unmappedUsers += 1;
      continue;
    }
    const messageId = readNonBlankOpaqueIdentifier(row.meta?.opencodeMessageId);
    if (remoteId === params.remoteSessionId && messageId) observedMessageIds.add(messageId);
    else unmappedAgents += 1;
  }
  return { observedMessageIds, complete: params.baseline.complete && unmappedUsers === 0 && unmappedAgents === 0,
    unmappedUsers, unmappedAgents };
}

export async function importOpenCodeTextHistoryCommitted(params: Readonly<{
  session: ApiSessionClient;
  provider: ACPProvider;
  remoteSessionId: string;
  items: ReadonlyArray<OpenCodeTextHistoryItem>;
  importedFrom: 'acp-history' | 'acp-sidechain';
  sidechainId?: string;
}>): Promise<void> {
  // Only formerly ambiguous sidechain keys need an upgrade baseline. Ordinary
  // released keys stay unchanged, and main-history reconciliation already owns its baseline.
  const sidechainBaseline = params.importedFrom === 'acp-sidechain' && params.sidechainId
    && params.items.some((item) => buildImportLocalId({ kind: 'sidechain', remoteSessionId: params.remoteSessionId,
      sidechainId: params.sidechainId, messageId: item.messageId }) !== buildLegacyImportLocalId({ kind: 'sidechain',
      remoteSessionId: params.remoteSessionId, sidechainId: params.sidechainId, messageId: item.messageId }))
    ? await params.session.fetchCommittedTranscriptIdentitySnapshot({ sidechainId: params.sidechainId }) : null;
  if (sidechainBaseline && !sidechainBaseline.complete) {
    throw new Error('OpenCode sidechain committed identities are incomplete');
  }
  for (const item of params.items) {
    const localId = buildImportLocalId({
      kind: params.importedFrom === 'acp-sidechain' ? 'sidechain' : 'history',
      remoteSessionId: params.remoteSessionId,
      sidechainId: params.sidechainId,
      messageId: item.messageId,
    });
    if (sidechainBaseline) {
      const legacyId = buildLegacyImportLocalId({ kind: 'sidechain', remoteSessionId: params.remoteSessionId,
        sidechainId: params.sidechainId, messageId: item.messageId });
      const candidates = sidechainBaseline.rows.filter((row) => row.localId === localId || row.localId === legacyId);
      if (candidates.some((row) => readNonBlankOpaqueIdentifier(row.meta?.remoteSessionId) === params.remoteSessionId
        && row.meta?.sidechainId === params.sidechainId && row.role === (item.role === 'user' ? 'user' : 'agent')
        && (!row.provider || row.provider === params.provider))) continue;
      if (candidates.some((row) => !readNonBlankOpaqueIdentifier(row.meta?.remoteSessionId))) {
        throw new Error('OpenCode legacy sidechain identity is unproven');
      }
    }
    const meta: Record<string, unknown> = {
      // Prevent imported user messages from being delivered into the agent queue.
      source: 'cli',
      sentFrom: 'cli',
      importedFrom: params.importedFrom,
      remoteSessionId: params.remoteSessionId,
      ...(params.importedFrom === 'acp-sidechain' && params.sidechainId ? { sidechainId: params.sidechainId } : {}),
    };

    if (item.role === 'user') {
      await params.session.sendUserTextMessageCommitted(item.text, { localId, meta });
      continue;
    }
    await params.session.sendAgentMessageCommitted(
      params.provider,
      { type: 'message', message: item.text, ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}) },
      { localId, meta },
    );
  }
}
