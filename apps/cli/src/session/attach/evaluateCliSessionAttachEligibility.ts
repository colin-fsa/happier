import {
  getAgentLocalControlCapabilityForSession,
  inferAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';
import { compareMachineHosts } from '@happier-dev/protocol';

import { getProviderAttachOps } from '@/backends/catalog';
import { probeSessionRunnerPresence } from '@/daemon/sessions/isSessionRunnerActive';
import type { Credentials } from '@/persistence';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalAttachPlan, type TerminalAttachPlan } from '@/terminal/attachment/terminalAttachPlan';
import type { Metadata } from '@/api/types';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionListRow, RawSessionRecord } from '@/session/transport/http/sessionsHttp';

export type CliSessionAttachEligibilityReasonCode =
  | 'archived'
  | 'inactive'
  | 'metadata_unavailable'
  | 'current_machine_unknown'
  | 'session_machine_unknown'
  | 'not_current_machine'
  | 'local_control_unsupported'
  | 'provider_attach_unavailable'
  | 'missing_local_attach_state'
  | 'terminal_not_attachable';

export type CliSessionAttachEligibility =
  | Readonly<{
      eligible: true;
      agentId: AgentId;
      attachStrategy: 'managed_provider_attach';
      attachScope: 'local';
      metadata: Record<string, unknown>;
      terminal: NonNullable<Metadata['terminal']>;
    }>
  | Readonly<{
      eligible: true;
      agentId: AgentId;
      attachStrategy: 'provider_attach';
      attachScope: 'local' | 'remote';
      metadata: Record<string, unknown>;
    }>
  | Readonly<{
      eligible: true;
      agentId: AgentId;
      attachStrategy: 'terminal_host';
      attachScope: 'local';
      terminal: NonNullable<Metadata['terminal']>;
      plan: Exclude<TerminalAttachPlan, { type: 'not-attachable' }>;
      metadata: Record<string, unknown> | null;
    }>
  | Readonly<{
      eligible: false;
      agentId: AgentId | null;
      reasonCode: CliSessionAttachEligibilityReasonCode;
      reason: string;
      metadata: Record<string, unknown> | null;
    }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function resolveArchivedAt(rawSession: RawSessionListRow | RawSessionRecord): number | null {
  const archivedAt = (rawSession as { archivedAt?: unknown }).archivedAt;
  return typeof archivedAt === 'number' && Number.isFinite(archivedAt) ? archivedAt : null;
}

function readMachineId(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.machineId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readHost(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.host;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMetadataTerminal(metadata: Record<string, unknown> | null): NonNullable<Metadata['terminal']> | null {
  if (!metadata) return null;
  const terminal = metadata.terminal;
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
  return terminal as NonNullable<Metadata['terminal']>;
}

function resolveAgentId(metadata: Record<string, unknown> | null): AgentId | null {
  return metadata ? inferAgentIdFromSessionMetadata(metadata) : null;
}

function buildTerminalAttachEligibility(params: Readonly<{
  metadata: Record<string, unknown> | null;
  localAttachmentInfo: TerminalAttachmentInfo | null;
  metadataTerminal?: NonNullable<Metadata['terminal']> | null;
  insideTmux: boolean;
  currentTmuxSocketPath?: string | null;
}>): CliSessionAttachEligibility {
  const localTerminal = params.localAttachmentInfo?.terminal ?? null;
  const terminal = localTerminal ?? params.metadataTerminal ?? null;

  if (terminal) {
    const plan = createTerminalAttachPlan({
      terminal,
      insideTmux: params.insideTmux,
      currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
    });
    if (plan.type === 'not-attachable') {
      return {
        eligible: false,
        agentId: resolveAgentId(params.metadata),
        reasonCode: 'terminal_not_attachable',
        reason: plan.reason,
        metadata: params.metadata,
      };
    }
    return {
      eligible: true,
      agentId: resolveAgentId(params.metadata) ?? 'claude',
      attachStrategy: 'terminal_host',
      attachScope: 'local',
      terminal,
      plan,
      metadata: params.metadata,
    };
  }

  return {
    eligible: false,
    agentId: resolveAgentId(params.metadata),
    reasonCode: 'missing_local_attach_state',
    reason: 'No local attachment info found for this session on this computer.',
    metadata: params.metadata,
  };
}

export async function evaluateCliSessionAttachEligibility(params: Readonly<{
  credentials: Credentials;
  rawSession: RawSessionListRow | RawSessionRecord;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  localAttachmentInfo: TerminalAttachmentInfo | null;
  insideTmux: boolean;
  currentTmuxSocketPath?: string | null;
}>): Promise<CliSessionAttachEligibility> {
  if (resolveArchivedAt(params.rawSession) !== null) {
    return {
      eligible: false,
      agentId: null,
      reasonCode: 'archived',
      reason: 'Session is archived and cannot be attached.',
      metadata: null,
    };
  }
  const metadata = asRecord(tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: params.rawSession,
  }));
  const agentId = resolveAgentId(metadata);

  if (!metadata) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'metadata_unavailable',
      reason: 'Failed to decrypt session metadata.',
      metadata: null,
    };
  }

  const localControl = agentId ? getAgentLocalControlCapabilityForSession({ agentId, metadata }) : null;
  const sessionMachineId = readMachineId(metadata);
  const sessionHost = readHost(metadata);
  const metadataTerminal = readMetadataTerminal(metadata);
  const hasLocalTerminalEvidence = params.localAttachmentInfo !== null;
  const sameHostAsCurrentMachine = compareMachineHosts(sessionHost, params.currentMachineHost ?? null);
  const sameMachineIdentity = Boolean(sessionMachineId && params.currentMachineId && sessionMachineId === params.currentMachineId);
  const candidate = params.localAttachmentInfo?.terminal ?? metadataTerminal;
  const hasLocalHerdrRestorationCandidate = candidate?.mode === 'herdr'
    && candidate.controlServiceabilityV1?.retired !== true
    && Boolean(candidate.herdr?.paneId?.trim())
    && (hasLocalTerminalEvidence || Boolean(sessionMachineId && (sameHostAsCurrentMachine || sameMachineIdentity)));
  if (params.rawSession.active !== true) {
    // A recorded public pane is only a restoration candidate. Opening it does
    // not authenticate or bind the resumed runner to this Happier session.
    if (localControl && hasLocalHerdrRestorationCandidate) {
      return buildTerminalAttachEligibility({
        metadata, localAttachmentInfo: params.localAttachmentInfo, metadataTerminal,
        insideTmux: params.insideTmux, currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
      });
    }
    return {
      eligible: false, agentId, reasonCode: 'inactive',
      reason: 'Session is not active and cannot be attached.', metadata,
    };
  }
  if (!localControl) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'local_control_unsupported',
      reason: 'This session does not support terminal attach.',
      metadata,
    };
  }

  if (localControl.attachStrategy === 'provider_attach') {
    // The relay's active bit can outlive its controller. Only positive local
    // runner absence permits opening recorded metadata as a cold candidate.
    if (params.localAttachmentInfo || (hasLocalHerdrRestorationCandidate
      && (await probeSessionRunnerPresence({ sessionId: params.rawSession.id, trackedSessions: [] })).state === 'runner_absent')) {
      const hosted = buildTerminalAttachEligibility({
        metadata,
        localAttachmentInfo: params.localAttachmentInfo,
        metadataTerminal,
        insideTmux: params.insideTmux,
        currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
      });
      if (hosted.eligible) return hosted;
    }
    const selectedHost = metadataTerminal?.mode === 'plain' ? metadataTerminal.requested : metadataTerminal?.mode;
    if (agentId && metadataTerminal && localControl.topology === 'shared' && metadata.startedBy === 'daemon'
      && sameMachineIdentity && (selectedHost === 'tmux' || selectedHost === 'zellij' || selectedHost === 'herdr')) {
      // Availability is not runner custody: the live runner's authenticated Switch RPC
      // must admit and prepare the selected client before any terminal can be focused.
      return { eligible: true, agentId, attachStrategy: 'managed_provider_attach', attachScope: 'local', metadata,
        terminal: metadataTerminal };
    }
    if (!agentId) {
      return {
        eligible: false,
        agentId,
        reasonCode: 'provider_attach_unavailable',
        reason: 'Provider attach is not available for this session.',
        metadata,
      };
    }
    const providerAttachOps = await getProviderAttachOps(agentId);
    if (!providerAttachOps) {
      return {
        eligible: false,
        agentId,
        reasonCode: 'provider_attach_unavailable',
        reason: 'Provider attach is not available for this session.',
        metadata,
      };
    }

    const evaluation = await providerAttachOps.evaluateEligibility({
      sessionId: params.rawSession.id,
      metadata,
      currentMachineId: params.currentMachineId,
      sessionMachineId,
      hasLocalAttachmentInfo: params.localAttachmentInfo !== null,
    });
    if (!evaluation.eligible) {
      return {
        eligible: false,
        agentId,
        reasonCode: 'provider_attach_unavailable',
        reason: evaluation.reason,
        metadata,
      };
    }

    return {
      eligible: true,
      agentId,
      attachStrategy: 'provider_attach',
      attachScope: evaluation.scope,
      metadata: evaluation.metadata,
    };
  }

  if (localControl.attachStrategy !== 'tmux') {
    return {
      eligible: false,
      agentId,
      reasonCode: 'local_control_unsupported',
      reason: 'This session does not support terminal attach.',
      metadata,
    };
  }

  if (hasLocalTerminalEvidence || (metadataTerminal !== null && sessionMachineId && (sameHostAsCurrentMachine || sameMachineIdentity))) {
    return buildTerminalAttachEligibility({
      metadata,
      localAttachmentInfo: params.localAttachmentInfo,
      metadataTerminal,
      insideTmux: params.insideTmux,
      currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
    });
  }

  if (!params.currentMachineId && !hasLocalTerminalEvidence) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'current_machine_unknown',
      reason: 'Current machine id is unavailable; cannot determine whether this session belongs to this computer.',
      metadata,
    };
  }
  if (!sessionMachineId && !hasLocalTerminalEvidence) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'session_machine_unknown',
      reason: 'Session does not record which machine is hosting it and cannot be safely attached.',
      metadata,
    };
  }
  if (sessionMachineId && params.currentMachineId && sessionMachineId !== params.currentMachineId && !hasLocalTerminalEvidence) {
    return {
      eligible: false,
      agentId,
      reasonCode: 'not_current_machine',
      reason: 'Session belongs to another machine and cannot be attached from this computer.',
      metadata,
    };
  }

  return buildTerminalAttachEligibility({
    metadata,
    localAttachmentInfo: params.localAttachmentInfo,
    metadataTerminal: null,
    insideTmux: params.insideTmux,
    currentTmuxSocketPath: params.currentTmuxSocketPath ?? null,
  });
}
