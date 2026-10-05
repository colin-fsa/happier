import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: { get: axiosGet },
}));

import { createLoopbackReadinessProbe } from './createLoopbackReadinessProbe';

describe('createLoopbackReadinessProbe', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses the canonical authenticated feature observation without a separate health prerequisite', async () => {
    axiosGet.mockResolvedValueOnce({ status: 200 });
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'account-token',
    })()).resolves.toMatchObject({ status: 'auth_failed', statusCode: 401 });

    expect(axiosGet).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:48123/v1/features',
      expect.objectContaining({
        headers: { Authorization: 'Bearer account-token' },
        redirect: 'manual',
      }),
    );
  });

  it('accepts a successful readiness observation beyond the old five-second cutoff', async () => {
    vi.useFakeTimers();
    try {
      axiosGet.mockResolvedValue({ status: 200 });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ features: {}, capabilities: {} }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })), 6_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('timeout', 'AbortError'));
        }, { once: true });
      })));
      const readiness = createLoopbackReadinessProbe({
        serverUrl: 'http://127.0.0.1:48123', token: 'account-token',
      })();
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(readiness).resolves.toEqual({ status: 'ready' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let an unrelated health endpoint prevent authenticated feature readiness', async () => {
    axiosGet.mockRejectedValue(new Error('health check timed out'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123', token: 'account-token',
    })()).resolves.toEqual({ status: 'ready' });
  });

  it('keeps server failures retryable instead of admitting the connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(createLoopbackReadinessProbe({
      serverUrl: 'http://127.0.0.1:48123', token: 'account-token',
    })()).resolves.toMatchObject({ status: 'retry_later' });
  });
});
