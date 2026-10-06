import { parseSpecialCommand } from '@/cli/parsers/specialCommands';

export type SpecialCommandQueue<Mode, Message> = {
  push: (
    message: Message,
    mode: Mode,
    opts?: {
      userMessageSeq?: number | null;
      userMessageLocalId?: string | null;
      userMessageLocalIds?: readonly string[] | null;
      providerAcceptancePending?: boolean | null;
      pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
      pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
    },
  ) => void;
  unshift: (
    message: Message,
    mode: Mode,
    opts?: {
      userMessageSeq?: number | null;
      userMessageLocalId?: string | null;
      userMessageLocalIds?: readonly string[] | null;
      providerAcceptancePending?: boolean | null;
      pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
      pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
    },
  ) => void;
  pushIsolateAndClear: (
    message: Message,
    mode: Mode,
    opts?: {
      userMessageSeq?: number | null;
      userMessageLocalId?: string | null;
      userMessageLocalIds?: readonly string[] | null;
      providerAcceptancePending?: boolean | null;
      pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
      pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
    },
  ) => void;
};

/**
 * Push user input to a mode-aware queue, handling slash-style clear commands consistently.
 */
export function pushMessageToQueueWithSpecialCommands<Mode, Message>(opts: {
  queue: SpecialCommandQueue<Mode, Message>;
  message: Message;
  text: string;
  mode: Mode;
  userMessageSeq?: number | null;
  userMessageLocalId?: string | null;
  userMessageLocalIds?: readonly string[] | null;
  providerAcceptancePending?: boolean | null;
  pendingProviderAction?: import('@/agent/runtime/modeMessageQueue').PendingProviderAction;
  pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
  prioritize?: boolean;
}): void {
  const special = parseSpecialCommand(opts.text);
  const queueOptions = {
    userMessageSeq: opts.userMessageSeq ?? null,
    userMessageLocalId: opts.userMessageLocalId ?? null,
    userMessageLocalIds: opts.userMessageLocalIds ?? null,
    ...(opts.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
    ...(opts.pendingProviderAction ? { pendingProviderAction: opts.pendingProviderAction } : {}),
    ...(opts.pendingRequestedAction ? { pendingRequestedAction: opts.pendingRequestedAction } : {}),
  };
  if (special.type === 'clear') {
    opts.queue.pushIsolateAndClear(opts.message, opts.mode, queueOptions);
    return;
  }
  if (opts.prioritize) {
    opts.queue.unshift(opts.message, opts.mode, queueOptions);
  } else {
    opts.queue.push(opts.message, opts.mode, queueOptions);
  }
}
