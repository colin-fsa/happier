import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

import type { ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './types';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';
import type { SessionMessageCommitResult } from '../sessionMessageCommitResult';
import {
  buildStreamedTranscriptSegmentSnapshotBody,
  buildStreamedTranscriptSegmentSnapshotMeta,
} from './buildStreamedTranscriptSegmentSnapshot';

export function commitStreamedTranscriptSegmentSnapshot(params: {
  provider: ACPProvider;
  session: StreamedTranscriptWriterSession;
  segment: StreamedTranscriptSegmentRuntime;
  state: StreamedTranscriptSegmentState;
  interruptedReason?: string;
  admissionOnly?: boolean;
  failureRetryDelayMs?: number;
  onStreamingCommitFailure?: () => void;
}) {
  const { provider, session, segment, state, interruptedReason } = params;

  if (segment.isCommittingDurable && params.admissionOnly !== true) {
    segment.pendingDurableCommit = { state, interruptedReason };
    return;
  }

  if (params.admissionOnly !== true) {
    segment.isCommittingDurable = true;
  } else {
    // The terminal snapshot supersedes a coalesced streaming checkpoint. Its call
    // below synchronously enters the session-owned commit queue; only the resulting
    // server acknowledgement is detached from the provider-event queue.
    segment.pendingDurableCommit = null;
  }

  const nowMs = Date.now();
  const commitVersion = segment.textVersion;
  const commitText = segment.accumulatedText;
  const commitTextLen = segment.accumulatedText.length;
  const durableLocalId = segment.segmentLocalId;
  const body = buildStreamedTranscriptSegmentSnapshotBody(segment);
  const meta = buildStreamedTranscriptSegmentSnapshotMeta({ segment, state, interruptedReason, nowMs });

  const markDurablyPersisted = (commitResult: SessionMessageCommitResult | null) => {
    // Admission may overlap an earlier checkpoint ACK. That checkpoint must not
    // downgrade an already acknowledged terminal snapshot.
    if (state === 'streaming' && segment.lastCommittedState !== null && segment.lastCommittedState !== 'streaming') return;
    segment.didWriteDurable = true;
    segment.lastDurableText = commitText;
    segment.lastCheckpointAtMs = Date.now();
    segment.lastCheckpointTextLen = commitTextLen;
    segment.appendOnlySinceLastDurableSnapshot = true;
    segment.lastCommittedTextVersion = commitVersion;
    segment.lastCommittedState = state;
    segment.lastCommitError = null;
    segment.lastCommitResult = commitResult;
    segment.durableRetryNotBeforeMs = 0;
    const recovered = segment.durableCommitFailure;
    segment.durableCommitFailure = null;
    if (recovered) {
      logger.debug('[StreamedTranscriptWriter] Durable snapshot commit recovered', {
        failureCount: recovered.count,
        suppressedFailureCount: recovered.suppressedCount,
        firstError: recovered.firstError,
        localId: durableLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
      });
    }
  };

  let committedSnapshotPromise: Promise<Readonly<{
    persisted: boolean;
    commitResult: SessionMessageCommitResult | null;
  }>>;
  try {
    // The causal outbox is opt-in at the producer boundary: only a producer that supplied
    // explicit provenance may enter it. Unmigrated producers keep their established direct
    // commit path instead of accumulating permanently blocked outbox records.
    if (segment.commitMode === 'exact') {
      if (typeof session.sendAgentMessageCommittedExact !== 'function') {
        throw new Error('sendAgentMessageCommittedExact unavailable for exact transcript segment');
      }
      committedSnapshotPromise = session
        .sendAgentMessageCommittedExact(provider, body, {
          localId: durableLocalId,
          meta,
        })
        .then((commitResult) => {
          if (commitResult.localId !== durableLocalId) {
            throw new Error(`Exact transcript segment ACK localId mismatch for ${durableLocalId}`);
          }
          return { persisted: true, commitResult };
        });
    } else if (segment.provenance && typeof session.enqueueAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .enqueueAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          provenance: segment.provenance,
        })
        .then((result) => ({ persisted: result.persisted, commitResult: null }));
    } else if (typeof session.sendAgentMessageCommitted === 'function') {
      committedSnapshotPromise = session
        .sendAgentMessageCommitted(provider, body, {
          localId: durableLocalId,
          meta,
          ...(segment.provenance ? { provenance: segment.provenance } : {}),
        })
        .then(() => ({ persisted: true, commitResult: null }));
    } else {
      throw new Error('sendAgentMessageCommitted unavailable');
    }
  } catch (error) {
    committedSnapshotPromise = Promise.reject(error);
  }

  let commitFailed = false;
  const observeCommitFailure = (error: unknown) => {
    commitFailed = true;
    if (state === 'streaming' && segment.lastCommittedState !== null && segment.lastCommittedState !== 'streaming') return;
    segment.lastCommitFailedAtMs = Date.now();
    segment.lastCommitError = error;
    if (state === 'streaming' && params.failureRetryDelayMs !== undefined) {
      segment.durableRetryNotBeforeMs = Date.now() + params.failureRetryDelayMs;
    }
    const serializedError = serializeAxiosErrorForLog(error);
    const failure = segment.durableCommitFailure;
    if (failure) {
      failure.count += 1;
      failure.suppressedCount += 1;
      return;
    }
    segment.durableCommitFailure = {
      firstError: serializedError,
      count: 1,
      suppressedCount: 0,
    };
    logger.debug(
      segment.commitMode === 'exact'
        ? '[StreamedTranscriptWriter] Exact durable snapshot commit failed'
        : '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)',
      {
        error: serializedError,
        localId: durableLocalId,
        segmentLocalId: segment.segmentLocalId,
        kind: segment.kind,
        sidechainId: segment.sidechainId,
        state,
        textLength: commitTextLen,
        textVersion: commitVersion,
        lastCommittedTextVersion: segment.lastCommittedTextVersion,
        lastCommittedState: segment.lastCommittedState,
        admissionOnly: params.admissionOnly === true,
      },
    );
  };

  return committedSnapshotPromise
    .then((result) => {
      if (result.persisted) markDurablyPersisted(result.commitResult);
    })
    .catch(observeCommitFailure)
    .finally(() => {
      if (params.admissionOnly === true) return;
      segment.isCommittingDurable = false;
      const pendingCommit = segment.pendingDurableCommit;
      segment.pendingDurableCommit = null;
      if (pendingCommit && (!commitFailed || pendingCommit.state !== 'streaming')) {
        commitStreamedTranscriptSegmentSnapshot({
          provider,
          session,
          segment,
          state: pendingCommit.state,
          interruptedReason: pendingCommit.interruptedReason,
          failureRetryDelayMs: params.failureRetryDelayMs,
          onStreamingCommitFailure: params.onStreamingCommitFailure,
        });
        return;
      }
      if (commitFailed && state === 'streaming') {
        params.onStreamingCommitFailure?.();
      }
      if (segment.idleWaiters.length === 0) return;
      const waiters = segment.idleWaiters.splice(0, segment.idleWaiters.length);
      for (const waiter of waiters) {
        waiter();
      }
    });
}
