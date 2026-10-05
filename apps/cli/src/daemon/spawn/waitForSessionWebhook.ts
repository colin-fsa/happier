import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

import type { TrackedSession } from '../types';

export const DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS = 5 * 60_000;
export type SessionWebhookCompletion = Promise<SpawnSessionResult> & Readonly<{
  getCurrentPid: () => number;
  promotePid: (pid: number) => void;
}>;
const SESSION_WEBHOOK_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS';

type WaitForSessionWebhookParams = {
  pid: number;
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
  pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
  timeoutMs?: number;
  timeoutErrorMessage: string;
  onTimeout?: () => void;
  onSuccess?: (session: TrackedSession) => void | Promise<void>;
};

export function resolveSessionStartupTimeoutMs(explicitTimeoutMs?: number): number {
  if (typeof explicitTimeoutMs === 'number' && explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }

  const rawEnvValue = String(process.env[SESSION_WEBHOOK_TIMEOUT_ENV_KEY] ?? '').trim();
  if (!rawEnvValue) {
    return DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawEnvValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
  }

  return parsed;
}

export function waitForSessionWebhook(
  params: WaitForSessionWebhookParams,
): SessionWebhookCompletion {
  const timeoutMs = resolveSessionStartupTimeoutMs(params.timeoutMs);
  let currentPid = params.pid;

  const completion = new Promise<SpawnSessionResult>((resolve) => {
    const clearTrackedState = () => {
      params.pidToAwaiter.delete(currentPid);
      params.pidToSpawnResultResolver.delete(currentPid);
      params.pidToSpawnWebhookTimeout.delete(currentPid);
    };

    params.pidToSpawnResultResolver.set(params.pid, resolve);

    const timeout = setTimeout(() => {
      clearTrackedState();
      params.onTimeout?.();
      resolve({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: params.timeoutErrorMessage,
      });
    }, timeoutMs);

    params.pidToSpawnWebhookTimeout.set(params.pid, timeout);

    params.pidToAwaiter.set(params.pid, async (completedSession) => {
      clearTimeout(timeout);
      const sessionId =
        typeof completedSession.happySessionId === 'string' ? completedSession.happySessionId.trim() : '';
      if (!sessionId) {
        clearTrackedState();
        resolve({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: `Session webhook did not include a sessionId (pid=${params.pid})`,
        });
        return;
      }
      try {
        await params.onSuccess?.(completedSession);
      } catch (error) {
        clearTrackedState();
        resolve({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      clearTrackedState();
      resolve({
        type: 'success',
        sessionId,
      });
    });
  });
  return Object.assign(completion, {
    getCurrentPid: () => currentPid,
    promotePid: (pid: number): void => {
      if (pid === currentPid) return;
      const awaiter = params.pidToAwaiter.get(currentPid);
      const resolver = params.pidToSpawnResultResolver.get(currentPid);
      const timeout = params.pidToSpawnWebhookTimeout.get(currentPid);
      params.pidToAwaiter.delete(currentPid);
      params.pidToSpawnResultResolver.delete(currentPid);
      params.pidToSpawnWebhookTimeout.delete(currentPid);
      if (awaiter) params.pidToAwaiter.set(pid, awaiter);
      if (resolver) params.pidToSpawnResultResolver.set(pid, resolver);
      if (timeout) params.pidToSpawnWebhookTimeout.set(pid, timeout);
      currentPid = pid;
    },
  });
}
