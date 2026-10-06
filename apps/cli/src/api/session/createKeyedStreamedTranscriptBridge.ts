import type { ACPProvider } from './sessionMessageTypes';
import {
  createStreamedTranscriptWriter,
  type StreamedTranscriptFlushSummary,
  type StreamedTranscriptWriter,
  type StreamedTranscriptWriterSession,
} from './streamedTranscriptWriter';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

type KeyedStreamArgs = Readonly<{
  streamKey: string;
  sidechainId: string | null;
}>;

type KeyedStreamWriterEntry<TArgs extends KeyedStreamArgs> = Readonly<{
  args: TArgs;
  writer: StreamedTranscriptWriter;
}>;

type KeyedStreamFlushArgs<TArgs extends KeyedStreamArgs> = Readonly<{
  reason: FlushReason;
  interruptedReason?: string;
  matches: (args: TArgs) => boolean;
}>;

export function createKeyedStreamedTranscriptBridge<TArgs extends KeyedStreamArgs>(params: Readonly<{
  provider: ACPProvider;
  createSessionForStream: (args: TArgs) => StreamedTranscriptWriterSession;
  initialCheckpointDelayMs?: number | null;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
  liveSnapshotIntervalMs?: number | null;
  liveSnapshotMinChars?: number | null;
  durableCommitsRequireExplicitEnable?: boolean | ((args: TArgs) => boolean);
}>) {
  const writerByStreamKey = new Map<string, KeyedStreamWriterEntry<TArgs>>();

  const releaseDrainedWriter = (streamKey: string, entry: KeyedStreamWriterEntry<TArgs>) => {
    if (writerByStreamKey.get(streamKey) === entry && !entry.writer.hasPendingSegments()) {
      writerByStreamKey.delete(streamKey);
    }
  };

  const getOrCreateWriter = (args: TArgs): StreamedTranscriptWriter => {
    const existing = writerByStreamKey.get(args.streamKey);
    if (existing) return existing.writer;

    const durableCommitsRequireExplicitEnable = typeof params.durableCommitsRequireExplicitEnable === 'function'
      ? params.durableCommitsRequireExplicitEnable(args)
      : params.durableCommitsRequireExplicitEnable;
    const writer = createStreamedTranscriptWriter({
      provider: params.provider,
      session: params.createSessionForStream(args),
      initialCheckpointDelayMs: params.initialCheckpointDelayMs,
      checkpointIntervalMs: params.checkpointIntervalMs,
      checkpointMinChars: params.checkpointMinChars,
      liveSnapshotIntervalMs: params.liveSnapshotIntervalMs,
      liveSnapshotMinChars: params.liveSnapshotMinChars,
      durableCommitsRequireExplicitEnable,
    });
    writerByStreamKey.set(args.streamKey, { args, writer });
    return writer;
  };

  return {
    appendAssistantDelta(args: TArgs & Readonly<{ deltaText: string }>) {
      getOrCreateWriter(args).appendAssistantDelta(args.deltaText, { sidechainId: args.sidechainId });
    },

    appendThinkingDelta(args: TArgs & Readonly<{ deltaText: string }>) {
      getOrCreateWriter(args).appendThinkingDelta(args.deltaText, { sidechainId: args.sidechainId });
    },

    overrideAssistantText(args: TArgs & Readonly<{ text: string }>) {
      getOrCreateWriter(args).overrideAssistantText(args.text, { sidechainId: args.sidechainId });
    },

    overrideThinkingText(args: TArgs & Readonly<{ text: string }>) {
      getOrCreateWriter(args).overrideThinkingText(args.text, { sidechainId: args.sidechainId });
    },

    mergeAssistantMeta(args: TArgs & Readonly<{ meta: Record<string, unknown> }>) {
      return getOrCreateWriter(args).mergeAssistantMeta(args.meta, { sidechainId: args.sidechainId });
    },

    enableDurableCommitsForStream(args: TArgs) {
      getOrCreateWriter(args).enableDurableCommits();
    },

    discardStream(args: TArgs) {
      const entry = writerByStreamKey.get(args.streamKey);
      if (!entry) return;
      entry.writer.discard();
      writerByStreamKey.delete(args.streamKey);
    },

    async flushStreamsMatching(args: KeyedStreamFlushArgs<TArgs>): Promise<ReadonlyArray<StreamedTranscriptFlushSummary>> {
      const entries = Array.from(writerByStreamKey.entries())
        .filter(([, entry]) => args.matches(entry.args));
      const flushArgs = {
        reason: args.reason,
        ...(args.interruptedReason ? { interruptedReason: args.interruptedReason } : {}),
      };
      const summaries = await Promise.all(entries.map(async ([streamKey, entry]) => {
        const summary = await entry.writer.flushAll(flushArgs);
        releaseDrainedWriter(streamKey, entry);
        return summary;
      }));
      return summaries;
    },

    async flushStreamsMatchingThroughDurableAdmission(args: KeyedStreamFlushArgs<TArgs>): Promise<void> {
      const entries = Array.from(writerByStreamKey.entries())
        .filter(([, entry]) => args.matches(entry.args));
      const flushArgs = {
        reason: args.reason,
        ...(args.interruptedReason ? { interruptedReason: args.interruptedReason } : {}),
      };
      await Promise.all(entries.map(async ([streamKey, entry]) => {
        await entry.writer.flushAllThroughDurableAdmission(flushArgs);
        releaseDrainedWriter(streamKey, entry);
      }));
    },

    async flushAll(args: Readonly<{ reason: FlushReason; interruptedReason?: string }>) {
      return await Promise.all(Array.from(writerByStreamKey.entries(), async ([streamKey, entry]) => {
        const summary = await entry.writer.flushAll(args);
        releaseDrainedWriter(streamKey, entry);
        return summary;
      }));
    },

    clear() {
      for (const entry of writerByStreamKey.values()) {
        entry.writer.discard();
      }
      writerByStreamKey.clear();
    },
  };
}
