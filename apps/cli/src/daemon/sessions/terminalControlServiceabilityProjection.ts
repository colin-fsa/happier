import type { SessionRunnerServiceabilityProbe } from './isSessionRunnerActive';
import type { Metadata } from '@/api/types';

export type TerminalControlServiceabilityEvidence = Readonly<{
  attachmentId: string;
  state: 'servable' | 'recoverable_unservable' | 'unknown';
  observedAt: number;
  reason?: string;
}>;

export function hasActiveReportedTerminalControlServiceability(params: Readonly<{
  terminal: Metadata['terminal'] | null | undefined;
  attachmentId: string;
}>): boolean {
  const existing = params.terminal?.controlServiceabilityV1;
  return existing?.v === 1
    && existing.retired !== true
    && existing.attachmentId === params.attachmentId;
}

export function shouldPublishReportedTerminalControlServiceability(params: Readonly<{
  terminal: Metadata['terminal'] | null | undefined;
  attachmentId: string | null | undefined;
  publishedAttachmentId: string | null | undefined;
}>): boolean {
  const attachmentId = typeof params.attachmentId === 'string' ? params.attachmentId.trim() : '';
  if (!attachmentId || !params.terminal || params.terminal.mode === 'plain') return false;
  if (hasActiveReportedTerminalControlServiceability({ terminal: params.terminal, attachmentId })) {
    return false;
  }
  return params.publishedAttachmentId !== attachmentId;
}

export function resolveRunnerTerminalControlServiceabilityEvidence(params: Readonly<{
  probe: SessionRunnerServiceabilityProbe;
  attachmentId: string;
  observedAt: number;
}>): TerminalControlServiceabilityEvidence | null {
  if (params.probe.state !== 'runner_present') return null;
  return {
    attachmentId: params.attachmentId,
    state: params.probe.control.state,
    observedAt: params.observedAt,
    ...('reason' in params.probe.control ? { reason: params.probe.control.reason } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Applies attachment-bound evidence in observation order. A metadata retry can invoke this
 * after a replacement runner has already published newer evidence; the delayed observation
 * must then become a no-op instead of relabelling the replacement unavailable.
 */
export function applyTerminalControlServiceabilityProjection(params: Readonly<{
  metadata: Record<string, unknown>;
  evidence: TerminalControlServiceabilityEvidence;
}>): Record<string, unknown> {
  const terminal = asRecord(params.metadata.terminal);
  if (!terminal) return params.metadata;

  const existing = asRecord(terminal.controlServiceabilityV1);
  const existingObservedAt = typeof existing?.observedAt === 'number' && Number.isFinite(existing.observedAt)
    ? existing.observedAt
    : Number.NEGATIVE_INFINITY;
  if (existing?.retired === true) {
    if (existing.attachmentId === params.evidence.attachmentId) return params.metadata;
    if (existingObservedAt > params.evidence.observedAt) return params.metadata;
  } else if (existingObservedAt >= params.evidence.observedAt) {
    return params.metadata;
  }

  return {
    ...params.metadata,
    terminal: {
      ...terminal,
      controlServiceabilityV1: {
        v: 1,
        attachmentId: params.evidence.attachmentId,
        state: params.evidence.state,
        observedAt: params.evidence.observedAt,
        ...(params.evidence.reason ? { reason: params.evidence.reason } : {}),
      },
    },
  };
}

/**
 * Tombstones only evidence owned by the attachment that has been physically retired. The fence
 * blocks an already-in-flight publisher from resurrecting it while allowing replacement evidence.
 */
export function clearTerminalControlServiceabilityProjection(params: Readonly<{
  metadata: Metadata;
  retiredAttachmentId: string;
  retiredAt: number;
  terminalMode?: NonNullable<Metadata['terminal']>['mode'];
}>): Metadata;
export function clearTerminalControlServiceabilityProjection(params: Readonly<{
  metadata: Record<string, unknown>;
  retiredAttachmentId: string;
  retiredAt: number;
  terminalMode?: NonNullable<Metadata['terminal']>['mode'];
}>): Record<string, unknown>;
export function clearTerminalControlServiceabilityProjection(params: Readonly<{
  metadata: Record<string, unknown>;
  retiredAttachmentId: string;
  retiredAt: number;
  terminalMode?: NonNullable<Metadata['terminal']>['mode'];
}>): Record<string, unknown> {
  const terminal = asRecord(params.metadata.terminal) ?? {};
  const existing = asRecord(terminal.controlServiceabilityV1);
  if (existing && existing.attachmentId !== params.retiredAttachmentId) return params.metadata;
  const existingObservedAt = typeof existing?.observedAt === 'number' && Number.isFinite(existing.observedAt)
    ? existing.observedAt
    : Number.NEGATIVE_INFINITY;

  return {
    ...params.metadata,
    terminal: {
      ...terminal,
      ...(typeof terminal.mode === 'string'
        ? { mode: terminal.mode }
        : params.terminalMode
          ? { mode: params.terminalMode }
          : {}),
      controlServiceabilityV1: {
        v: 1,
        attachmentId: params.retiredAttachmentId,
        state: 'unknown',
        observedAt: Math.max(params.retiredAt, existingObservedAt),
        reason: 'attachment_retired',
        retired: true,
      },
    },
  };
}
