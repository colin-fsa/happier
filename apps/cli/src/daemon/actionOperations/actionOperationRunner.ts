import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { ActionOperationDomainRefV1Schema } from '@happier-dev/protocol';
import type {
  ActionOperationDomainRefV1,
  ActionOperationProgressV1,
  ActionOperationSnapshotV1,
} from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol';

import type { ActionOperationStore } from './actionOperationStore';
import type {
  ActionOperationAccessScope,
  ActionOperationCancelResult,
  ActionOperationExecutionRequest,
} from './actionOperationTypes';
import { parseActionOperationProgress } from './actionOperationProgress';

type Task = Readonly<{
  scope: ActionOperationAccessScope;
  controller: AbortController;
  actionId: string;
  request: ActionOperationExecutionRequest;
  exclusiveKey?: string;
  receipt: Promise<unknown>;
  completion: Promise<unknown>;
}>;

function isInScope(
  snapshot: Readonly<{ scope: ActionOperationAccessScope }>,
  scope: ActionOperationAccessScope,
): boolean {
  return snapshot.scope.accountId === scope.accountId && snapshot.scope.machineId === scope.machineId;
}

function normalizeThrownFailure(): ActionExecuteResult {
  // Thrown values are not an executor-owned public failure projection. Neither
  // their message nor their code is safe to expose through operation RPCs.
  return { ok: false, errorCode: 'action_failed', error: 'Action failed' };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isCancelledResult(
  result: ActionExecuteResult | Readonly<{ kind: 'cancelled' }>,
): result is Readonly<{ kind: 'cancelled' }> {
  return 'kind' in result && result.kind === 'cancelled';
}

export type ActionOperationRunner = ReturnType<typeof createActionOperationRunner>;

export function createActionOperationRunner(params: Readonly<{
  store: ActionOperationStore;
  createOperationId?: () => string;
  now?: () => number;
}>) {
  const createOperationId = params.createOperationId ?? randomUUID;
  const now = params.now ?? Date.now;
  const tasks = new Map<string, Task>();
  const operationIdsByCorrelation = new Map<string, string>();

  const correlationKey = (request: ActionOperationExecutionRequest, scope: ActionOperationAccessScope): string | null => (
    request.requestId
      ? JSON.stringify([scope.accountId, scope.machineId, request.actionId, request.requestId])
      : null
  );

  const cleanPrunedTasks = () => {
    for (const [operationId, task] of tasks) {
      if (!params.store.get(operationId, task.scope)) {
        tasks.delete(operationId);
        for (const [key, correlatedOperationId] of operationIdsByCorrelation) {
          if (correlatedOperationId === operationId) operationIdsByCorrelation.delete(key);
        }
      }
    }
  };

  const settle = (
    operationId: string,
    result: ActionExecuteResult | Readonly<{ kind: 'cancelled' }>,
    resolveDomainRef?: (result: ActionExecuteResult) => ActionOperationDomainRefV1 | undefined,
  ) => {
    const settledAt = now();
    const projectedDomainRef = !isCancelledResult(result) && resolveDomainRef
      ? ActionOperationDomainRefV1Schema.safeParse(resolveDomainRef(result))
      : null;
    const domainRef = projectedDomainRef?.success ? projectedDomainRef.data : undefined;
    if (isCancelledResult(result)) {
      params.store.update(operationId, (snapshot) => ({
        ...snapshot,
        state: 'cancelled',
        settledAt,
      }));
      return;
    }
    if (result.ok === true) {
      params.store.update(operationId, (snapshot) => ({
        ...snapshot,
        state: 'succeeded',
        settledAt,
        result: result.result,
        ...(domainRef ? { domainRef } : {}),
      }));
      return;
    }
    params.store.update(operationId, (snapshot) => ({
      ...snapshot,
      state: 'failed',
      settledAt,
      error: {
        errorCode: result.errorCode.slice(0, 200) || 'action_failed',
        error: result.error.slice(0, 10_000) || 'action_failed',
      },
      ...(domainRef ? { domainRef } : {}),
    }));
  };

  const cancel = (operationId: string, scope: ActionOperationAccessScope): ActionOperationCancelResult => {
    const snapshot = params.store.get(operationId, scope);
    if (!snapshot) return { kind: 'not_found' };
    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      return { kind: 'already_settled' };
    }
    if (snapshot.cancellation === 'unsupported') return { kind: 'unsupported' };
    const task = tasks.get(operationId);
    if (!task || !isInScope(snapshot, task.scope)) return { kind: 'not_found' };
    params.store.update(operationId, (current) => ({
      ...current, cancellation: 'unsupported',
      progress: { kind: 'phase', phase: 'cancelling', label: 'Stopping action' },
    }));
    task.controller.abort();
    return { kind: 'requested' };
  };

  type ExecutionInput<T, R = T> = Readonly<{
    request: ActionOperationExecutionRequest;
    scope: ActionOperationAccessScope;
    title: string;
    cancellation: 'unsupported' | 'supported';
    scopeSessionId?: string | null;
    exclusiveKey?: string;
    domainRef?: ActionOperationDomainRefV1;
    execute: (context: Readonly<{
      signal: AbortSignal;
      acknowledge: (value: R) => void;
      update: (update: Readonly<{
        progress?: ActionOperationProgressV1;
        domainRef?: ActionOperationDomainRefV1;
        cancellation?: 'unsupported' | 'supported';
      }>) => void;
    }>) => Promise<T>;
    projectResult: (value: T) => ActionExecuteResult | Readonly<{ kind: 'cancelled' }>;
  }>;
  type StartResult<T, R = T> = Readonly<{ kind: 'conflict' }> | Readonly<{
    // Domain admission may acknowledge before final completion; otherwise its
    // historical receipt is the completed result. Both deliveries belong here.
    kind: 'started'; operation: ActionOperationSnapshotV1; receipt: Promise<T | R>; completion: Promise<T>;
  }>;
  const startHistorical = <T, R = T>(input: ExecutionInput<T, R>): StartResult<T, R> => {
    cleanPrunedTasks();
    const key = correlationKey(input.request, input.scope);
    const correlatedOperationId = key ? operationIdsByCorrelation.get(key) : undefined;
    for (const [existingId, task] of tasks) {
      const snapshot = params.store.get(existingId, input.scope);
      if (!snapshot) continue;
      const active = snapshot.state === 'accepted' || snapshot.state === 'running';
      const sameResource = active && input.exclusiveKey !== undefined && task.exclusiveKey === input.exclusiveKey;
      if (existingId !== correlatedOperationId && !sameResource) continue;
      if (task.actionId !== input.request.actionId) return { kind: 'conflict' };
      if (existingId === correlatedOperationId && (!isDeepStrictEqual(task.request.input, input.request.input)
        || !isDeepStrictEqual(task.request.scope, input.request.scope))) return { kind: 'conflict' };
      // A scoped action owns its receipt and completion contracts; admission
      // only joins that same action, so those private result types are unchanged.
      return { kind: 'started', operation: snapshot, receipt: task.receipt as Promise<T | R>, completion: task.completion as Promise<T> };
    }
    const operationId = createOperationId();
    const resolvedScope = {
      accountId: input.scope.accountId,
      machineId: input.scope.machineId,
      ...(input.scopeSessionId ? { sessionId: input.scopeSessionId } : {}),
    };
    params.store.create({
      version: 1,
      operationId,
      ...(input.request.requestId ? { requestId: input.request.requestId } : {}),
      revision: 1,
      actionId: input.request.actionId,
      state: 'accepted',
      scope: resolvedScope,
      title: input.title,
      createdAt: now(),
      cancellation: input.cancellation,
      ...(input.domainRef ? { domainRef: input.domainRef } : {}),
    });
    const controller = new AbortController();
    if (key) operationIdsByCorrelation.set(key, operationId);
    params.store.update(operationId, (snapshot) => ({ ...snapshot, state: 'running', startedAt: now() }));
    const update = (candidate: Readonly<{
      progress?: ActionOperationProgressV1;
      domainRef?: ActionOperationDomainRefV1;
      cancellation?: 'supported' | 'unsupported';
    }>) => {
      const progress = candidate.progress === undefined ? undefined : parseActionOperationProgress(candidate.progress);
      const domainRef = candidate.domainRef === undefined
        ? undefined
        : ActionOperationDomainRefV1Schema.safeParse(candidate.domainRef);
      if (candidate.progress !== undefined && !progress) return;
      if (candidate.domainRef !== undefined && !domainRef?.success) return;
      // Cancellation keeps its shared status until acknowledged, while domain
      // references may still arrive from the owner during cooperative cleanup.
      if (controller.signal.aborted && !domainRef?.success) return;
      params.store.update(operationId, (snapshot) => ({
        ...snapshot,
        ...(!controller.signal.aborted && candidate.cancellation ? { cancellation: candidate.cancellation } : {}),
        ...(!controller.signal.aborted && progress ? { progress } : {}),
        ...(domainRef?.success ? { domainRef: domainRef.data } : {}),
      }));
    };
    let receiptSettled = false;
    let resolveReceipt!: (value: T | R) => void;
    let rejectReceipt!: (error: unknown) => void;
    const receipt = new Promise<T | R>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    const acknowledge = (value: T | R) => {
      if (receiptSettled) return;
      receiptSettled = true;
      resolveReceipt(value);
    };
    const completion = Promise.resolve().then(async () => {
      try {
        const value = await input.execute({ signal: controller.signal, acknowledge, update });
        settle(operationId, input.projectResult(value));
        acknowledge(value);
        return value;
      } catch (error) {
        const acknowledgedCancellation = controller.signal.aborted && isAbortError(error);
        settle(operationId, acknowledgedCancellation ? { kind: 'cancelled' } : normalizeThrownFailure());
        if (!receiptSettled) { receiptSettled = true; rejectReceipt(error); }
        throw error;
      }
    });
    // Async start acknowledgements do not consume completion; keep failures observed
    // while preserving rejection for historical completion-waiting callers.
    void receipt.catch(() => {});
    void completion.catch(() => {});
    tasks.set(operationId, { scope: resolvedScope, controller, actionId: input.request.actionId, request: input.request,
      ...(input.exclusiveKey ? { exclusiveKey: input.exclusiveKey } : {}), receipt, completion });
    return { kind: 'started', operation: params.store.get(operationId, input.scope)!, receipt, completion };
  };
  const executeHistorical = async <T>(input: ExecutionInput<T>): Promise<T> => {
    const started = startHistorical(input);
    if (started.kind === 'conflict') throw new Error('Action operation conflicts with an active action');
    return await started.completion;
  };

  return { startHistorical, executeHistorical, cancel };
}
