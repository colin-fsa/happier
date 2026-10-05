import type { TerminalHostKind, TerminalHostLaunchFailure } from './_types';
import { TerminalHostUnavailableSpawnErrorDetailSchema, type TerminalHostUnavailableSpawnErrorDetail } from '@happier-dev/protocol';

/** The host may have accepted its command before its creation reply failed. */
export class TerminalHostCreationError extends AggregateError implements TerminalHostLaunchFailure {
  readonly code: string = 'terminal_host_creation_failed';
  readonly launchDisposition: TerminalHostLaunchFailure['launchDisposition'];
  readonly cleanupIncomplete: boolean;

  constructor(errors: readonly unknown[], failure: TerminalHostLaunchFailure, message: string) {
    super(errors, message, { cause: errors[0] });
    this.name = 'TerminalHostCreationError';
    this.launchDisposition = failure.launchDisposition;
    this.cleanupIncomplete = failure.cleanupIncomplete;
  }
}

export type TerminalHostStartupFailureReason =
  | 'installation_unavailable'
  | 'server_version_unsupported'
  | 'startup_action_timeout'
  | 'startup_action_failed'
  | 'recovery_probe_inconclusive'
  | 'live_attachment_adoption_unavailable'
  | 'bootstrap_cleanup_did_not_converge'
  | 'pane_disappeared_after_bootstrap_cleanup';

export type TerminalHostStartupErrorParams = Readonly<{
  hostKind: TerminalHostKind;
  reason: TerminalHostStartupFailureReason;
  message: string;
  diagnostics?: Readonly<Record<string, unknown>> | undefined;
  cause?: unknown;
  launchFailure?: TerminalHostLaunchFailure;
}>;

export class TerminalHostStartupError extends Error {
  readonly code = 'terminal_host_startup_failed';
  readonly hostKind: TerminalHostKind;
  readonly reason: TerminalHostStartupFailureReason;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;
  readonly launchFailure?: TerminalHostLaunchFailure;

  constructor(params: TerminalHostStartupErrorParams) {
    super(params.message, { cause: params.cause });
    this.name = 'TerminalHostStartupError';
    this.hostKind = params.hostKind;
    this.reason = params.reason;
    this.diagnostics = params.diagnostics;
    this.launchFailure = params.launchFailure;
  }
}

/** Process-local creation evidence; an unclassified failure never proves non-creation. */
export function resolveTerminalHostLaunchFailure(error: unknown): TerminalHostLaunchFailure | null {
  if (error instanceof TerminalHostCreationError) return error;
  if (error instanceof TerminalHostStartupError) return error.launchFailure ?? null;
  return null;
}

export function isTerminalHostStartupError(error: unknown): error is TerminalHostStartupError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<TerminalHostStartupError>;
  return candidate.code === 'terminal_host_startup_failed'
    && typeof candidate.hostKind === 'string'
    && typeof candidate.reason === 'string';
}

export function isRecoveryProbeInconclusiveError(error: unknown): error is TerminalHostStartupError {
  return isTerminalHostStartupError(error) && error.reason === 'recovery_probe_inconclusive';
}

/** Publish only protocol-owned setup failures; process diagnostics never cross this seam. */
export function resolveTerminalHostUnavailableSpawnErrorDetail(error: unknown): TerminalHostUnavailableSpawnErrorDetail | undefined {
  if (!isTerminalHostStartupError(error)) return undefined;
  const detail = TerminalHostUnavailableSpawnErrorDetailSchema.safeParse({
    kind: 'terminal_host_unavailable', host: error.hostKind, reason: error.reason,
  });
  return detail.success ? detail.data : undefined;
}
