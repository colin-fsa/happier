import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import {
  readTerminalAttachmentInfo as readDefaultTerminalAttachmentInfo,
  readTerminalAttachmentState,
  removeTerminalAttachmentInfo as removeDefaultTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
  type ExactTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { notifyTerminalAttachmentRetiredThroughCatalog, resolveTerminalAttachmentControlDescriptorStatusThroughCatalog } from '@/backends/catalog';
import { logger } from '@/ui/logger';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import type { SessionRunnerServiceabilityProbe } from './isSessionRunnerActive';
import type { TerminalAttachmentControlDescriptorStatus } from '@/backends/types';
import type { ExactTerminalControlServiceabilityRetirement } from './retireTerminalControlServiceability';
import type { TrackedSession } from '../types';
import { resolveTrackedSessionTerminalPresentation } from './resolveTrackedSessionTerminalPresentation';
import { resolveTrackedSessionCatalogAgentId } from './resolveTrackedSessionCatalogAgentId';
import { readTerminalClientProcessState } from '@/terminal/runtime/terminalClientCustody';

export type DisconnectedTerminalHostCandidate = Readonly<{
  sessionId: string;
  pid: number;
  activeTurnId?: string;
  happyHomeDir: string;
  attachmentId: NonNullable<TerminalHostHandle['attachmentId']>;
  handle: TerminalHostHandle & Readonly<{ attachmentId: NonNullable<TerminalHostHandle['attachmentId']> }>;
  /** Provider applicability and exact descriptor proof, distinct from immutable host identity. */
  controlDescriptorStatus: TerminalAttachmentControlDescriptorStatus;
  /** Captured admitted runtime selection; reconstructed through the existing respawn owner on restart. */
  spawnOptions?: TrackedSession['spawnOptions'];
}>;

export type DisconnectedTerminalHostSupervisionResult =
  | Readonly<{ state: 'servable' }>
  | Readonly<{ state: 'recoverable_unservable'; reason: string }>
  | Readonly<{ state: 'stopped' }>
  | Readonly<{ state: 'unknown'; reason: 'attachment_changed' | 'adapter_unavailable' | 'probe_inconclusive' | 'retirement_failed' }>;

export type DisconnectedTerminalHostResumeGate =
  | Readonly<{ action: 'resume' }>
  | Readonly<{ action: 'fence'; reason: string }>;

export function resolveDisconnectedTerminalHostResumeGate(
  result: DisconnectedTerminalHostSupervisionResult,
): DisconnectedTerminalHostResumeGate {
  return result.state === 'stopped' || result.state === 'servable'
    ? { action: 'resume' }
    : { action: 'fence', reason: result.reason };
}

type TerminalHostAdapters = Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>;

/** Optional-client recovery follows current custody, not its initial webhook. */
export async function shouldRetainTrackedTerminalHostExitMarker(input: Readonly<{
  tracked: TrackedSession;
  happyHomeDir: string;
}>): Promise<boolean> {
  const { tracked } = input;
  const sessionId = tracked.happySessionId?.trim();
  if (sessionId && (await resolveTrackedSessionTerminalPresentation(tracked))?.kind === 'provider_attach') {
    const attachment = await readTerminalAttachmentState({ happyHomeDir: input.happyHomeDir, sessionId });
    if (attachment.status === 'unreadable') {
      logger.infoFile('[DAEMON RUN] Retaining runner-exit marker because terminal custody is unreadable', {
        sessionId, reason: attachment.reason,
      });
      return true;
    }
    return attachment.status === 'present' && attachment.info.version !== 3;
  }
  if (tracked.publishedTerminalControlServiceabilityAttachmentLifecycle === 'borrowed') return false;
  const terminal = tracked.happySessionMetadataFromLocalWebhook?.terminal ?? tracked.hostedTerminal;
  return Boolean(tracked.publishedTerminalControlServiceabilityAttachmentId)
    || Boolean(terminal?.mode && terminal.mode !== 'plain');
}

/** The existing final-exit callback's owned-host candidate selection. Borrowed release is separate. */
export async function resolveTrackedSessionTerminalHostExitCandidate(input: Readonly<{
  tracked: TrackedSession;
  pid: number;
  happyHomeDir: string;
  attachmentInfo: TerminalAttachmentInfo | null;
}>): Promise<DisconnectedTerminalHostCandidate | null> {
  const { tracked, attachmentInfo } = input;
  const sessionId = tracked.happySessionId?.trim();
  if (!sessionId) return null;
  const optionalPresentation = (await resolveTrackedSessionTerminalPresentation(tracked))?.kind === 'provider_attach';
  const terminal = tracked.happySessionMetadataFromLocalWebhook?.terminal ?? tracked.hostedTerminal;
  if (attachmentInfo?.version !== 2) {
    if (!optionalPresentation && (tracked.publishedTerminalControlServiceabilityAttachmentId || (terminal?.mode && terminal.mode !== 'plain'))) {
      throw new Error('terminal_attachment_unavailable_after_runner_exit');
    }
    return null;
  }
  if (!optionalPresentation && tracked.publishedTerminalControlServiceabilityAttachmentId
    && tracked.publishedTerminalControlServiceabilityAttachmentId !== attachmentInfo.attachmentId) return null;
  const controlDescriptorStatus = await resolveTerminalAttachmentControlDescriptorStatusThroughCatalog(
    resolveTrackedSessionCatalogAgentId(tracked), {
      happyHomeDir: input.happyHomeDir, sessionId, attachmentId: attachmentInfo.attachmentId,
    },
  ).catch(() => 'missing' as const);
  return {
    sessionId, pid: input.pid, happyHomeDir: input.happyHomeDir,
    ...(tracked.activeTurnId ? { activeTurnId: tracked.activeTurnId } : {}),
    ...(tracked.spawnOptions ? { spawnOptions: tracked.spawnOptions } : {}),
    attachmentId: attachmentInfo.attachmentId, handle: attachmentInfo.handle, controlDescriptorStatus,
  };
}

/** The existing heartbeat observes optional client exit without terminalizing its live Session. */
export async function superviseTrackedOptionalTerminalPresentation(input: Readonly<{
  tracked: TrackedSession;
  isCurrent: () => boolean;
  happyHomeDir: string;
  loadTerminalHostAdapters: () => Promise<TerminalHostAdapters>;
  probeSessionServiceability?: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  retireExactTerminalControlServiceability: (input: Readonly<{
    happyHomeDir: string; sessionId: string; attachmentInfo: ExactTerminalAttachmentInfo;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
}>): Promise<void> {
  const sessionId = input.tracked.happySessionId;
  if (!sessionId || (await resolveTrackedSessionTerminalPresentation(input.tracked))?.kind !== 'provider_attach'
    || !input.isCurrent()) return;
  const attachment = await readDefaultTerminalAttachmentInfo({ happyHomeDir: input.happyHomeDir, sessionId });
  if (!input.isCurrent() || !attachment || attachment.version === 1) return;
  if (attachment.version === 3) {
    if (!attachment.nativeClientProcess || await readTerminalClientProcessState(attachment.nativeClientProcess) !== 'dead'
      || !input.isCurrent()) return;
    const result = await executeTerminalHostDisposition({ happyHomeDir: input.happyHomeDir, sessionId,
      expectedAttachmentId: attachment.attachmentId,
      intent: { kind: 'release_borrowed_host', reason: 'provider_exit' },
      beforeDescriptorRetirement: async fact => {
        if (!input.isCurrent()) throw new Error('Optional terminal presentation owner changed');
        await input.retireExactTerminalControlServiceability(fact);
      },
    });
    if (result.status !== 'retired') logger.infoFile('[terminal] Borrowed native client retirement incomplete', { status: result.status });
    return;
  }
  // Explicit attach replaces the optional client without replacing its headless runner.
  // The current exact descriptor, not the initial webhook publication cache, owns this probe.
  const terminalHostAdapters = await input.loadTerminalHostAdapters();
  if (!input.isCurrent()) return;
  await superviseDisconnectedTerminalHostCandidate({
    candidate: { sessionId, pid: input.tracked.pid, happyHomeDir: input.happyHomeDir,
      attachmentId: attachment.attachmentId, handle: attachment.handle, controlDescriptorStatus: 'not_applicable',
      spawnOptions: input.tracked.spawnOptions },
    terminalHostAdapters,
    probeSessionServiceability: input.probeSessionServiceability,
    retireExactTerminalControlServiceability: async (fact) => {
      if (!input.isCurrent()) throw new Error('Optional terminal presentation owner changed');
      return await input.retireExactTerminalControlServiceability(fact);
    },
  });
}

export async function superviseDisconnectedTerminalHostCandidate(input: Readonly<{
  candidate: DisconnectedTerminalHostCandidate;
  terminalHostAdapters: TerminalHostAdapters;
  readTerminalAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalAttachmentInfo | null>;
  removeTerminalAttachmentInfo?: typeof removeDefaultTerminalAttachmentInfo;
  probeSessionServiceability?: (sessionId: string) => Promise<SessionRunnerServiceabilityProbe>;
  onExactTerminalAttachmentRetired?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<void>;
  retireExactTerminalControlServiceability?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: BoundTerminalAttachmentInfo;
  }>) => Promise<ExactTerminalControlServiceabilityRetirement | void>;
}>): Promise<DisconnectedTerminalHostSupervisionResult> {
  const readAttachment = input.readTerminalAttachmentInfo ?? readDefaultTerminalAttachmentInfo;
  const retireExactTerminalControlServiceability = input.retireExactTerminalControlServiceability;
  const current = await readAttachment({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
  });
  if (
    current?.version !== 2
    || current.attachmentId !== input.candidate.attachmentId
    || current.handle.attachmentId !== input.candidate.attachmentId
  ) {
    return { state: 'unknown', reason: 'attachment_changed' };
  }

  const adapter = input.terminalHostAdapters[current.handle.kind];
  if (!adapter) return { state: 'unknown', reason: 'adapter_unavailable' };

  const probe = await evaluateTerminalHostLivenessForRecovery(adapter, current.handle);
  let destroyOptionalClient = false;
  if (probe.status === 'alive') {
    const optionalPresentation = (await resolveTrackedSessionTerminalPresentation({
      pid: input.candidate.pid, startedBy: 'daemon', happySessionId: input.candidate.sessionId,
      spawnOptions: input.candidate.spawnOptions,
    }))?.kind === 'provider_attach';
    if (!optionalPresentation && input.candidate.controlDescriptorStatus === 'missing') {
      return { state: 'recoverable_unservable', reason: 'control_descriptor_missing' };
    }
    if (!input.probeSessionServiceability) return { state: 'unknown', reason: 'probe_inconclusive' };
    const serviceability = await input.probeSessionServiceability(input.candidate.sessionId);
    if (serviceability.state === 'runner_absent') {
      if (!optionalPresentation) return { state: 'recoverable_unservable', reason: 'runner_absent' };
      // This client is not provider-server custody. Retire its exact owned pane
      // before recovering the headless controller; explicit Attach prepares a fresh endpoint.
      destroyOptionalClient = true;
    } else if (serviceability.state === 'runner_unknown') {
      return { state: 'unknown', reason: 'probe_inconclusive' };
    } else if (serviceability.control.state === 'servable') return { state: 'servable' };
    else if (serviceability.control.state === 'recoverable_unservable') {
      return { state: 'recoverable_unservable', reason: serviceability.control.reason };
    } else return { state: 'unknown', reason: 'probe_inconclusive' };
  }
  if (probe.status === 'inconclusive') return { state: 'unknown', reason: 'probe_inconclusive' };

  const disposition = await executeTerminalHostDisposition({
    happyHomeDir: input.candidate.happyHomeDir,
    sessionId: input.candidate.sessionId,
    expectedAttachmentId: input.candidate.attachmentId,
    intent: destroyOptionalClient
      ? { kind: 'destroy_owned_host', reason: 'unrecoverable_control_recovery' }
      : { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
    adapter,
    ...(input.readTerminalAttachmentInfo ? { readAttachmentInfo: input.readTerminalAttachmentInfo } : {}),
    removeAttachmentInfo: input.removeTerminalAttachmentInfo ?? removeDefaultTerminalAttachmentInfo,
    beforeDescriptorRetirement: retireExactTerminalControlServiceability ? async ({ attachmentInfo }) => {
      if (attachmentInfo.version !== 2) {
        throw new Error('borrowed_terminal_attachment_is_not_recoverable');
      }
      try {
        await retireExactTerminalControlServiceability({
          happyHomeDir: input.candidate.happyHomeDir,
          sessionId: input.candidate.sessionId,
          attachmentInfo,
        });
      } catch (error) {
        logger.debug('[DAEMON RUN] Confirmed-dead terminal host retained for serviceability retirement retry', {
          sessionId: input.candidate.sessionId,
          attachmentId: input.candidate.attachmentId,
          error,
        });
        throw error;
      }
    } : undefined,
  });
  if (disposition.status !== 'retired' && (disposition.status !== 'destroyed' || disposition.descriptorRetained)) {
    return { state: 'unknown', reason: 'retirement_failed' };
  }
  try {
    await (input.onExactTerminalAttachmentRetired ?? notifyTerminalAttachmentRetiredThroughCatalog)({
      happyHomeDir: input.candidate.happyHomeDir,
      sessionId: input.candidate.sessionId,
      attachmentInfo: current,
    });
  } catch (error) {
    logger.debug('[DAEMON RUN] Terminal host retired but provider cleanup remains pending', {
      sessionId: input.candidate.sessionId,
      attachmentId: input.candidate.attachmentId,
      error,
    });
  }
  return { state: 'stopped' };
}
