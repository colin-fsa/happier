import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export function createLoopbackReadinessProbe(params: Readonly<{
  serverUrl: string;
  token: string;
}>): () => Promise<ReadinessProbeResult> {
  const serverUrl = resolveLoopbackHttpUrl(params.serverUrl).replace(/\/+$/, '');

  return async () => {
    try {
      const snapshot = await observeServerFeaturesSnapshot({
        serverUrl,
        token: params.token,
      });

      if (
        snapshot.status === 'error'
        && snapshot.httpStatus !== undefined
        && isAuthenticationStatus(snapshot.httpStatus)
      ) {
        return {
          status: 'auth_failed',
          statusCode: snapshot.httpStatus,
          errorMessage: `Authenticated probe returned ${snapshot.httpStatus}`,
        };
      }

      if (
        snapshot.status === 'error'
        && snapshot.reason === 'response_status'
        && (snapshot.httpStatus ?? 0) >= 500
      ) {
        return {
          status: 'retry_later',
          errorMessage: `Authenticated probe returned ${snapshot.httpStatus}`,
        };
      }

      if (snapshot.status !== 'ready') {
        return {
          status: 'server_unreachable',
          errorMessage: snapshot.status === 'error' && snapshot.httpStatus
            ? `Authenticated probe returned ${snapshot.httpStatus}`
            : `Authenticated probe failed: ${snapshot.reason}`,
        };
      }

      return { status: 'ready' };
    } catch (error) {
      return {
        status: 'server_unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
