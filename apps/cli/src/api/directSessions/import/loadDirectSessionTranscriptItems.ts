import {
  resolveDirectTranscriptContinuation,
  type DirectTranscriptRawMessageV1,
  type DirectTranscriptTruncationReason,
} from '@happier-dev/protocol';

export type DirectTranscriptImportPage = Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
  truncationReason?: DirectTranscriptTruncationReason;
}>;

export async function loadDirectSessionTranscriptItems(params: Readonly<{
  readPage: (cursor: string | undefined) => Promise<DirectTranscriptImportPage>;
  maxPages?: number;
  signal?: AbortSignal;
}>): Promise<DirectTranscriptRawMessageV1[]> {
  const pages: DirectTranscriptRawMessageV1[][] = [];
  const maxPages = params.maxPages ?? 10_000;
  let cursor: string | undefined;
  let complete = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    params.signal?.throwIfAborted();
    const page = await params.readPage(cursor);
    params.signal?.throwIfAborted();

    if (resolveDirectTranscriptContinuation(page) === 'source_discontinuity') {
      pages.length = 0;
      cursor = undefined;
      continue;
    }

    if (page.items.length > 0) {
      pages.push(page.items.slice());
    }
    if (!page.hasMore) {
      complete = true;
      break;
    }
    if (!page.nextCursor) {
      throw new Error('Direct-session transcript continuation page omitted its cursor');
    }
    cursor = page.nextCursor;
  }

  if (!complete) {
    throw new Error('Direct-session transcript paging exceeded its page budget');
  }

  const ordered: DirectTranscriptRawMessageV1[] = [];
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    ordered.push(...pages[index]!);
  }
  return ordered;
}
