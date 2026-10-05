import type { TerminalAttachmentId, TerminalHostAdapter } from '@/integrations/terminalHost/_types';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import { logger } from '@/ui/logger';
import { retireTerminalClientProcess } from '@/terminal/runtime/terminalClientCustody';
import {
  readTerminalAttachmentInfo,
  readTerminalAttachmentState,
  removeTerminalAttachmentInfo,
  matchesLegacyTerminalAttachmentSnapshot,
  type ExactTerminalAttachmentInfo,
  type LegacyTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from './terminalAttachmentInfo';

export type TerminalHostDispositionIntent =
  | Readonly<{
      kind: 'preserve_host';
      reason: 'planned_runner_refresh' | 'wrapper_exit' | 'controller_failure' | 'auth_switch_handoff';
      runtimePhase: 'transfer_pending' | 'blocked';
    }>
  | Readonly<{
      kind: 'destroy_owned_host';
      reason: 'explicit_user_stop' | 'unrecoverable_control_recovery';
    }>
  | Readonly<{
      kind: 'retire_confirmed_dead_attachment';
      reason: 'positive_dead_recovery';
    }>
  | Readonly<{
      kind: 'release_borrowed_host';
      reason: 'provider_exit' | 'explicit_user_stop' | 'wrapper_exit';
    }>;

export type TerminalHostDispositionResult =
  | Readonly<{ status: 'preserved'; attachmentId: TerminalAttachmentId }>
  | Readonly<{ status: 'retired'; attachmentId: TerminalAttachmentId | null }>
  | Readonly<{
      status: 'destroyed';
      attachmentId: TerminalAttachmentId;
      descriptorRetained?: true;
      retirementFailed?: true;
    }>
  | Readonly<{
      status: 'parked';
      reason: 'legacy_attachment' | 'attachment_mismatch' | 'missing_topology_proof' | 'disposition_in_progress' | 'destroy_failed' | 'retirement_failed' | 'descriptor_retirement_failed';
    }>;

const activeDispositionClaims = new Set<string>();

export async function executeTerminalHostDisposition(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId: TerminalAttachmentId | string;
  /** Exact snapshot captured before the caller's physical runner-exit barrier. */
  expectedAttachmentInfo?: ExactTerminalAttachmentInfo;
  intent: TerminalHostDispositionIntent;
  adapter?: TerminalHostAdapter;
  readAttachmentInfo?: (input: Readonly<{ happyHomeDir: string; sessionId: string }>) => Promise<TerminalAttachmentInfo | null>;
  readAttachmentState?: typeof readTerminalAttachmentState;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId: TerminalAttachmentId | string;
    expectedTerminal: TerminalAttachmentInfo['terminal'];
  }>) => Promise<boolean>;
  /** Runs after physical retirement is proven and before the local retry identity is removed. */
  beforeDescriptorRetirement?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: ExactTerminalAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  const removeAttachment = input.removeAttachmentInfo ?? removeTerminalAttachmentInfo;
  const readCurrent = async (): Promise<TerminalAttachmentInfo | null> => {
    const target = { happyHomeDir: input.happyHomeDir, sessionId: input.sessionId };
    if (input.readAttachmentState || !input.readAttachmentInfo) {
      const state = await (input.readAttachmentState ?? readTerminalAttachmentState)(target);
      if (state.status === 'unreadable') throw new Error('terminal_attachment_unreadable');
      return state.status === 'present' ? state.info : null;
    }
    return await input.readAttachmentInfo(target);
  };
  const expected = input.expectedAttachmentInfo;
  const captured = expected
    && expected.sessionId === input.sessionId
    && expected.attachmentId === input.expectedAttachmentId
    && expected.handle.attachmentId === expected.attachmentId
    && ((expected.version === 2 && input.intent.kind === 'destroy_owned_host')
      || (expected.version === 3 && input.intent.kind === 'release_borrowed_host'))
    ? expected
    : null;
  let attachmentInfo: TerminalAttachmentInfo | null;
  try {
    attachmentInfo = await readCurrent() ?? captured;
  } catch {
    logger.infoFile('[TERMINAL HOST] Disposition could not read exact attachment evidence', { sessionId: input.sessionId, attachmentId: input.expectedAttachmentId });
    return { status: 'parked', reason: 'missing_topology_proof' };
  }
  if (!attachmentInfo || attachmentInfo.version === 1) {
    return { status: 'parked', reason: 'legacy_attachment' };
  }
  if (attachmentInfo.attachmentId !== input.expectedAttachmentId) {
    return { status: 'parked', reason: 'attachment_mismatch' };
  }
  if (input.intent.kind === 'preserve_host') {
    return { status: 'preserved', attachmentId: attachmentInfo.attachmentId };
  }

  const claimKey = `${input.happyHomeDir}\u0000${input.sessionId}\u0000${attachmentInfo.attachmentId}`;
  if (activeDispositionClaims.has(claimKey)) {
    return { status: 'parked', reason: 'disposition_in_progress' };
  }
  activeDispositionClaims.add(claimKey);
  try {
    let current: TerminalAttachmentInfo | null;
    try {
      current = await readCurrent() ?? captured;
    } catch {
      logger.infoFile('[TERMINAL HOST] Disposition could not read exact attachment evidence', {
        sessionId: input.sessionId, attachmentId: input.expectedAttachmentId,
      });
      return { status: 'parked', reason: 'missing_topology_proof' };
    }
    if (!current || current.version === 1 || current.attachmentId !== attachmentInfo.attachmentId) {
      return { status: 'parked', reason: 'attachment_mismatch' };
    }

    if (input.intent.kind === 'retire_confirmed_dead_attachment' || input.intent.kind === 'release_borrowed_host') {
      if (input.intent.kind === 'release_borrowed_host' && current.version !== 3) {
        return { status: 'parked', reason: 'attachment_mismatch' };
      }
      if (current.version === 3 && current.nativeClientProcess) {
        try {
          await retireTerminalClientProcess(current.nativeClientProcess);
        } catch {
          logger.infoFile('[TERMINAL HOST] Borrowed native client cleanup incomplete; retaining exact custody');
          return { status: 'parked', reason: 'destroy_failed' };
        }
      }
      try {
        await input.beforeDescriptorRetirement?.({
          happyHomeDir: input.happyHomeDir,
          sessionId: input.sessionId,
          attachmentInfo: current,
        });
      } catch {
        return { status: 'parked', reason: 'retirement_failed' };
      }
      try {
        const removed = await removeAttachment({
          happyHomeDir: input.happyHomeDir,
          sessionId: input.sessionId,
          expectedAttachmentId: current.attachmentId,
          expectedTerminal: current.terminal,
        });
        if (removed) return { status: 'retired', attachmentId: current.attachmentId };
        const retained = await readCurrent();
        if (retained === null && captured !== null) return { status: 'retired', attachmentId: current.attachmentId };
        if (retained?.version !== 1 && retained?.attachmentId === current.attachmentId) {
          logger.infoFile('[TERMINAL HOST] Exact attachment descriptor retirement failed; retaining evidence', {
            sessionId: input.sessionId, attachmentId: current.attachmentId,
          });
          return { status: 'parked', reason: 'descriptor_retirement_failed' };
        }
        return { status: 'parked', reason: 'attachment_mismatch' };
      } catch {
        logger.infoFile('[TERMINAL HOST] Exact attachment descriptor retirement failed; retaining evidence', {
          sessionId: input.sessionId, attachmentId: current.attachmentId,
        });
        return { status: 'parked', reason: 'descriptor_retirement_failed' };
      }
    }

    if (current.version !== 2) {
      return { status: 'parked', reason: 'missing_topology_proof' };
    }

    const handle = current.handle;
    if (
      !input.adapter
      || input.adapter.kind !== handle.kind
      || handle.attachmentId !== current.attachmentId
      || (handle.attachMetadata.topology === 'shared' && !handle.paneId?.trim())
    ) {
      return { status: 'parked', reason: 'missing_topology_proof' };
    }
    try {
      await input.adapter.dispose(handle);
    } catch (error) {
      const liveness = await evaluateTerminalHostLivenessForRecovery(input.adapter, handle);
      if (liveness.status !== 'dead') {
        logger.warn('[TERMINAL HOST] Failed to destroy exact terminal host; retaining descriptor for retry', {
          sessionId: input.sessionId,
          attachmentId: current.attachmentId,
          hostKind: handle.kind,
          error,
          livenessStatus: liveness.status,
          liveness: liveness.liveness,
        });
        return { status: 'parked', reason: 'destroy_failed' };
      }
    }
    try {
      await input.beforeDescriptorRetirement?.({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        attachmentInfo: current,
      });
    } catch {
      return {
        status: 'destroyed',
        attachmentId: current.attachmentId,
        descriptorRetained: true,
        retirementFailed: true,
      };
    }
    try {
      const removed = await removeAttachment({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
        expectedAttachmentId: current.attachmentId,
        expectedTerminal: current.terminal,
      });
      // Another positively completed disposition may already have removed this
      // exact descriptor. Absence is completion evidence only after disposal above.
      if (removed || (captured !== null && await readCurrent() === null)) {
        return { status: 'destroyed', attachmentId: current.attachmentId };
      }
    } catch {
      // Physical destruction is already proven; unreadable local evidence cannot undo it.
    }
    logger.infoFile('[TERMINAL HOST] Exact attachment descriptor retirement failed; retaining evidence', {
      sessionId: input.sessionId, attachmentId: current.attachmentId,
    });
    return { status: 'destroyed', attachmentId: current.attachmentId, descriptorRetained: true };
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}

export async function executeConfirmedDeadTerminalAttachmentRetirement(input: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentInfo: TerminalAttachmentInfo;
  readAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
  }>) => Promise<TerminalAttachmentInfo | null>;
  removeAttachmentInfo?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    expectedAttachmentId?: TerminalAttachmentId | string;
    expectedLegacyAttachment?: LegacyTerminalAttachmentInfo;
    expectedTerminal?: TerminalAttachmentInfo['terminal'];
  }>) => Promise<boolean>;
  beforeDescriptorRetirement?: (input: Readonly<{
    happyHomeDir: string;
    sessionId: string;
    attachmentInfo: ExactTerminalAttachmentInfo;
  }>) => Promise<void>;
}>): Promise<TerminalHostDispositionResult> {
  if (input.expectedAttachmentInfo.version !== 1) {
    return await executeTerminalHostDisposition({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedAttachmentId: input.expectedAttachmentInfo.attachmentId,
      intent: { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' },
      readAttachmentInfo: input.readAttachmentInfo,
      removeAttachmentInfo: input.removeAttachmentInfo,
      beforeDescriptorRetirement: input.beforeDescriptorRetirement,
    });
  }

  const readAttachment = input.readAttachmentInfo ?? readTerminalAttachmentInfo;
  const removeAttachment = input.removeAttachmentInfo ?? removeTerminalAttachmentInfo;
  const expected = input.expectedAttachmentInfo;
  const claimKey = `${input.happyHomeDir}\u0000${input.sessionId}\u0000legacy:${expected.updatedAt}`;
  if (activeDispositionClaims.has(claimKey)) {
    return { status: 'parked', reason: 'disposition_in_progress' };
  }
  activeDispositionClaims.add(claimKey);
  try {
    const current = await readAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
    });
    if (current?.version !== 1 || !matchesLegacyTerminalAttachmentSnapshot(current, expected)) {
      return { status: 'parked', reason: 'attachment_mismatch' };
    }
    const removed = await removeAttachment({
      happyHomeDir: input.happyHomeDir,
      sessionId: input.sessionId,
      expectedLegacyAttachment: current,
    });
    return removed
      ? { status: 'retired', attachmentId: null }
      : { status: 'parked', reason: 'attachment_mismatch' };
  } finally {
    activeDispositionClaims.delete(claimKey);
  }
}
