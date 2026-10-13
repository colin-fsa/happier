import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout } from './fetchWithTimeout';

afterEach(() => vi.unstubAllGlobals());

describe('voice HTTP cancellation', () => {
  it.each([false, true])('preserves caller cancellation before/after request start (already aborted: %s)', async (alreadyAborted) => {
    const controller = new AbortController();
    const abortError = new DOMException('cancelled', 'AbortError');
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(abortError);
      else init?.signal?.addEventListener('abort', () => reject(abortError), { once: true });
    })));
    if (alreadyAborted) controller.abort();
    const pending = fetchWithTimeout('https://speech.test/v1', { signal: controller.signal }, 15000, 'stt_timeout');
    if (!alreadyAborted) controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
