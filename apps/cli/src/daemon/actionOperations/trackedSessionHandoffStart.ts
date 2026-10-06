import {
  SessionHandoffStartRequestSchema,
  type ActionExecuteResult,
  type SessionHandoffStartRequest,
} from '@happier-dev/protocol';

import type { ActionOperationRunner } from './actionOperationRunner';
import type { ActionOperationAccessScope } from './actionOperationTypes';

type OperationContext = Readonly<{
  signal: AbortSignal;
  update: (value: Readonly<{
    progress?: import('@happier-dev/protocol').ActionOperationProgressV1;
    domainRef?: import('@happier-dev/protocol').ActionOperationDomainRefV1;
  }>) => void;
}>;

type HistoricalStart = (
  request: SessionHandoffStartRequest,
  options?: Readonly<{
    onProgress?: (progress: import('@happier-dev/protocol').ActionOperationProgressV1) => void;
  }>,
) => Promise<unknown>;

export function createTrackedSessionHandoffStart(params: Readonly<{
  runner: ActionOperationRunner;
  getScope: () => Promise<ActionOperationAccessScope>;
  startUntracked: HistoricalStart;
  coordinate: (
    request: SessionHandoffStartRequest,
    context: OperationContext,
    startSource: HistoricalStart,
  ) => Promise<ActionExecuteResult | Readonly<{ kind: 'cancelled' }>>;
}>) {
  type Result = ActionExecuteResult | Readonly<{ kind: 'cancelled' }>;
  return async (raw: unknown): Promise<unknown> => {
    const parsed = SessionHandoffStartRequestSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.requestId) return await params.startUntracked(raw as SessionHandoffStartRequest);
    const request = parsed.data;
    const scope = await params.getScope();
    const started = params.runner.startHistorical<Result, unknown>({
      request: {
        actionId: 'session.handoff',
        input: request,
        requestId: request.requestId,
        scope: { sessionId: request.sessionId },
      },
      scope,
      title: 'Hand off session',
      cancellation: 'supported',
      scopeSessionId: request.sessionId,
      execute: async (context) => {
        return await params.coordinate(request, context, async (startRequest) => {
          const response = await params.startUntracked(startRequest, {
            onProgress: (progress) => context.update({ progress }),
          });
          context.acknowledge(response);
          return response;
        });
      },
      projectResult: (result) => result,
    });
    if (started.kind === 'conflict') throw new Error('Action operation conflicts with an active action');
    return await started.receipt;
  };
}
