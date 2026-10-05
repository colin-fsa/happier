import chalk from 'chalk';

import {
  getAgentLocalControlCapabilityForSession,
  inferAgentIdFromSessionMetadata,
  type AgentId,
} from '@happier-dev/agents';

import { getProviderAttachOps } from '@/backends/catalog';
import type { ProviderAttachOps } from '@/backends/types';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { readCredentials, readSettings, type Credentials, type Settings } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata, resolveSessionEncryptionContextFromCredentials, resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { probeSessionRunnerPresence } from '@/daemon/sessions/isSessionRunnerActive';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  readTerminalAttachmentInfo,
  readTerminalAttachmentState,
  terminalAttachmentMatchesTerminal,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { isTmuxAvailable } from '@/integrations/tmux';
import { runTmuxAttach } from '@/terminal/attachment/tmuxAttach';
import { runZellijAttach } from '@/terminal/attachment/zellijAttach';
import { runHerdrAttach } from '@/terminal/attachment/herdrAttach';
import { runTerminalHostAttach } from '@/terminal/attachment/runTerminalHostAttach';
import { focusWindowsTerminalWindow } from '@/terminal/attachment/windowsTerminalAttach';
import { focusWindowsConsoleWindow } from '@/terminal/attachment/windowsConsoleAttach';
import { canUseInkSelector, runSessionActionSelector } from '@/ui/ink/runSessionActionSelector';
import type { SessionActionSelectorRow } from '@/ui/ink/SessionActionSelector';
import { evaluateCliSessionAttachEligibility } from '@/session/attach/evaluateCliSessionAttachEligibility';
import {
  explainAttachIneligibility,
  type AgentAttachStrategyForExplainer,
} from '@/session/attach/explainAttachIneligibility';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { accountSettingsParse, SessionProviderCliAttachPrepareResultV1Schema } from '@happier-dev/protocol';
import { hostname } from 'node:os';
import { resolveInheritedHerdrRuntime } from '@/terminal/runtime/inheritedHerdrRuntime';
import { buildAttachSelectionModel, formatAttachIneligibilityFooter } from './attachInteractiveSelection';

import type { CommandContext } from '@/cli/commandRegistry';
import { cmd, fail, neutral } from '@happier-dev/cli-common/output';

type AttachCommandDeps = Readonly<{
  readCredentialsFn?: () => Promise<Credentials | null>;
  readSettingsFn?: () => Promise<Settings>;
  fetchSessionByIdFn?: (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;
  fetchSessionsPageFn?: (params: { token: string; cursor?: string; limit?: number; activeOnly?: boolean; archivedOnly?: boolean }) => Promise<{
    sessions: RawSessionListRow[];
    nextCursor: string | null;
    hasNext: boolean;
  }>;
  resolveSessionIdOrPrefixFn?: (params: { credentials: Credentials; idOrPrefix: string }) => Promise<
    | { ok: true; sessionId: string }
    | { ok: false; code: string; candidates?: string[] }
  >;
  tryDecryptSessionMetadataFn?: typeof tryDecryptSessionMetadata;
  readTerminalAttachmentInfoFn?: typeof readTerminalAttachmentInfo;
  isTmuxAvailableFn?: typeof isTmuxAvailable;
  runTmuxAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
    refreshRemoteControl?: boolean;
  }) => Promise<number>;
  runZellijAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runHerdrAttachFn?: (params: {
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runWindowsTerminalAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runWindowsConsoleAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runProviderAttachFn?: (params: {
    agentId: AgentId;
    sessionId: string;
    metadata: Record<string, unknown>;
    prepareProviderCliAttach?: Parameters<ProviderAttachOps['runAttach']>[0]['prepareProviderCliAttach'];
    terminalClient?: Parameters<ProviderAttachOps['runAttach']>[0]['terminalClient'];
  }) => Promise<number | false>;
  canUseInkSelectorFn?: () => boolean;
  selectAttachableSessionIdFn?: (params: {
    rows: SessionActionSelectorRow[];
    probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
    footerHint?: string | null;
  }) => Promise<
    | { type: 'selected'; sessionId: string }
    | { type: 'cancelled' }
    | { type: 'none' }
  >;
}>;

type ResolvedAttachContext = Readonly<{
  sessionId: string;
  metadata: Record<string, unknown> | null;
  agentId: AgentId | null;
  credentials: Credentials;
  rawSession: RawSessionRecord;
}>;

async function defaultRunWindowsTerminalAttach(params: {
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(fail('Windows Terminal attach is only available on Windows.'));
    return 1;
  }
  const windowId = params.terminal.windows?.windowId;
  if (typeof windowId !== 'string' || windowId.trim().length === 0) {
    console.error(fail('Session does not include a Windows Terminal window id.'));
    return 1;
  }
  return await focusWindowsTerminalWindow({ windowId });
}

async function defaultRunWindowsConsoleAttach(params: {
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(fail('Windows console attach is only available on Windows.'));
    return 1;
  }
  const pid = params.terminal.windows?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    console.error(fail('Session does not include a Windows console process id.'));
    return 1;
  }
  return await focusWindowsConsoleWindow({ pid });
}

function printMissingAttachInfo(sessionId: string): void {
  console.error(fail(`No local attachment info found for session ${sessionId}.`));
  console.error(chalk.gray('This usually means the session was not started with an attachable terminal host, or it was started on another machine.'));
}

function shouldRefreshRemoteControlOnAttach(metadata: Record<string, unknown> | null): boolean {
  return metadata?.startedBy === 'daemon';
}

async function resolveAttachContext(
  sessionIdOrPrefix: string,
  deps: AttachCommandDeps,
): Promise<ResolvedAttachContext | null> {
  const readCredentialsFn = deps.readCredentialsFn ?? readCredentials;
  const fetchSessionByIdFn = deps.fetchSessionByIdFn ?? fetchSessionById;
  const resolveSessionIdOrPrefixFn = deps.resolveSessionIdOrPrefixFn ?? resolveSessionIdOrPrefix;
  const tryDecryptSessionMetadataFn = deps.tryDecryptSessionMetadataFn ?? tryDecryptSessionMetadata;

  const credentials = await readCredentialsFn();
  if (!credentials) return null;

  let rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: sessionIdOrPrefix });
  if (!rawSession) {
    const resolved = await resolveSessionIdOrPrefixFn({ credentials, idOrPrefix: sessionIdOrPrefix });
    if (!resolved.ok) {
      if (resolved.code === 'session_lookup_timeout') {
        throw new Error('Session lookup timed out; try again');
      }
      return null;
    }
    rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: resolved.sessionId });
  }
  if (!rawSession) return null;

  const metadata = tryDecryptSessionMetadataFn({ credentials, rawSession });
  const agentId = metadata ? inferAgentIdFromSessionMetadata(metadata) : null;
  return {
    sessionId: rawSession.id,
    metadata,
    agentId,
    credentials,
    rawSession,
  };
}

function isAttachSuccess(exitCode: number | false): boolean {
  return exitCode === 0;
}

async function selectAttachableSessionId(params: Readonly<{
  rows: SessionActionSelectorRow[];
  probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
  footerHint?: string | null;
}>): Promise<
  | { type: 'selected'; sessionId: string }
  | { type: 'cancelled' }
  | { type: 'none' }
> {
  if (params.rows.length === 0) return { type: 'none' };
  return await runSessionActionSelector({
    title: 'Attach to a running session',
    actionVerb: 'attach',
    footerHint: params.footerHint ?? 'Use `happier resume` for stopped sessions.',
    rows: params.rows,
    onProbe: params.probeSessionIdFn,
  });
}

export async function handleAttachCommand(
  argv: string[],
  deps: AttachCommandDeps = {},
): Promise<void> {
  const hasHelpFlag = argv.some((arg) => {
    const trimmed = typeof arg === 'string' ? arg.trim() : '';
    return trimmed === '--help' || trimmed === '-h';
  });
  if (hasHelpFlag) {
    console.log('happier attach');
    console.log('happier attach <session-id-or-prefix>');
    console.log('');
    console.log('Attaches a terminal to a running session on this computer.');
    return;
  }

  let sessionIdOrPrefix = argv[0]?.trim() ?? '';
  const readTerminalAttachmentInfoFn = deps.readTerminalAttachmentInfoFn ?? readTerminalAttachmentInfo;
  const readSettingsFn = deps.readSettingsFn ?? readSettings;
  const fetchSessionsPageFn = deps.fetchSessionsPageFn ?? fetchSessionsPage;
  const runTmuxAttachFn = deps.runTmuxAttachFn ?? (async (params) => await runTmuxAttach(params, {
    isTmuxAvailableFn: deps.isTmuxAvailableFn,
  }));
  const runZellijAttachFn = deps.runZellijAttachFn ?? runZellijAttach;
  const runHerdrAttachFn = deps.runHerdrAttachFn ?? runHerdrAttach;
  const runWindowsTerminalAttachFn = deps.runWindowsTerminalAttachFn ?? defaultRunWindowsTerminalAttach;
  const runWindowsConsoleAttachFn = deps.runWindowsConsoleAttachFn ?? defaultRunWindowsConsoleAttach;
  const runProviderAttachFn = deps.runProviderAttachFn ?? (async ({ agentId, sessionId, metadata, prepareProviderCliAttach, terminalClient }) => {
    const providerAttachOps = await getProviderAttachOps(agentId);
    if (!providerAttachOps) return 1;
    return await providerAttachOps.runAttach({ sessionId, metadata, prepareProviderCliAttach, terminalClient });
  });
  const canUseInkSelectorFn = deps.canUseInkSelectorFn ?? canUseInkSelector;
  const selectAttachableSessionIdFn = deps.selectAttachableSessionIdFn ?? selectAttachableSessionId;

  const isInteractive = sessionIdOrPrefix.length === 0;
  let credentialsForInteractive: Credentials | null = null;
  let currentMachineId: string | null = null;

  if (isInteractive) {
    if (!canUseInkSelectorFn()) {
      console.error(fail('Interactive attach is not available (raw TTY mode not supported).'));
      console.log('');
      console.log('Hint: run `happier session list --active` and then `happier attach <session-id>`.');
      process.exit(1);
    }

    credentialsForInteractive = await (deps.readCredentialsFn ?? readCredentials)();
    if (!credentialsForInteractive) {
      console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
      process.exit(1);
    }

    const settings = await readSettingsFn();
    currentMachineId = typeof settings.machineId === 'string' && settings.machineId.trim().length > 0
      ? settings.machineId.trim()
      : null;
    // Soft fallback (was a hard exit previously): when the machineId is
    // unavailable we can still surface attachable sessions if the local
    // attachment file exists and/or the host name matches. The selector
    // will mark anything ambiguous as disabled-with-reason so the user
    // sees the underlying cause instead of a generic error.
    const accountSettings = await bootstrapAccountSettingsContext({
      credentials: credentialsForInteractive,
      mode: 'fast',
    }).then((ctx) => ctx.settings).catch(() => accountSettingsParse({}));

    const selectionModel = await buildAttachSelectionModel({
      credentials: credentialsForInteractive,
      currentMachineId,
      currentMachineHost: hostname(),
      fetchSessionsPageFn,
      readTerminalAttachmentInfoFn,
      isTmuxAvailableFn: deps.isTmuxAvailableFn ?? isTmuxAvailable,
      accountSettings,
    });
    const footerHint = formatAttachIneligibilityFooter(selectionModel.hint)
      ?? 'Use `happier resume` for stopped sessions.';
    const selected = await selectAttachableSessionIdFn({
      rows: selectionModel.rows,
      probeSessionIdFn: selectionModel.probeSessionIdFn,
      footerHint,
    });
    if (selected.type === 'cancelled') {
      console.log(neutral('Attach cancelled'));
      return;
    }
    if (selected.type === 'none') {
      // Empty list — distinguish between "nothing running" and
      // "running but unattachable from here" so the user sees the actual
      // cause. Today we only land here when 0 candidate rows survived.
      console.log('No active sessions on this machine.');
      console.log('Hint: use `happier resume` for stopped sessions, or `happier session list --active` to see remote sessions.');
      return;
    }
    sessionIdOrPrefix = selected.sessionId;
  }

  if (!sessionIdOrPrefix) {
    console.error(fail('Missing session ID.'));
    console.log('');
    console.log('Usage: happier attach <sessionId>');
    process.exit(1);
  }

  const context = await resolveAttachContext(sessionIdOrPrefix, deps);
  const resolvedSessionId = context?.sessionId ?? sessionIdOrPrefix;
  const localInfo = await readTerminalAttachmentInfoFn({
    happyHomeDir: configuration.happyHomeDir,
    sessionId: resolvedSessionId,
  });

  if (context) {
    const settings = await readSettingsFn();
    const effectiveMachineId = typeof settings.machineId === 'string' && settings.machineId.trim().length > 0
      ? settings.machineId.trim()
      : null;
    const eligibility = await evaluateCliSessionAttachEligibility({
      credentials: context.credentials,
      rawSession: context.rawSession,
      currentMachineId: effectiveMachineId,
      currentMachineHost: hostname(),
      localAttachmentInfo: localInfo,
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });

    if (!eligibility.eligible) {
      // Route through the same explainer the interactive selector uses so
      // explicit `happier attach <id>` produces the same friendly,
      // user-actionable message instead of the raw eligibility reason.
      const tmuxAvailable = await (deps.isTmuxAvailableFn ?? isTmuxAvailable)().catch(() => false);
      const agentId = eligibility.agentId ?? null;
      const agentAttachStrategy: AgentAttachStrategyForExplainer = agentId
        ? (getAgentLocalControlCapabilityForSession({
            agentId,
            metadata: eligibility.metadata,
          })?.attachStrategy ?? 'unsupported')
        : null;
      const explanation = explainAttachIneligibility({
        eligibility,
        metadata: eligibility.metadata,
        currentMachineHost: hostname(),
        tmuxAvailable,
        agentAttachStrategy,
      });
      console.error(fail(explanation.fullReason));
      if (explanation.nextStepHint) {
        console.error(chalk.gray(explanation.nextStepHint));
      }
      process.exit(1);
    }

    const attachNativeProvider = async (terminalClient?: Parameters<ProviderAttachOps['runAttach']>[0]['terminalClient']) => {
      if (!eligibility.metadata) return 1;
      return await runProviderAttachFn({
        agentId: eligibility.agentId,
        sessionId: resolvedSessionId,
        metadata: eligibility.metadata,
        terminalClient,
        prepareProviderCliAttach: async (request) => SessionProviderCliAttachPrepareResultV1Schema.parse(await callSessionRpc({
          token: context.credentials.token,
          sessionId: resolvedSessionId,
          mode: resolveSessionStoredContentEncryptionMode(context.rawSession),
          ctx: resolveSessionEncryptionContextFromCredentials(context.credentials, context.rawSession),
          method: `${resolvedSessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_CLI_ATTACH_PREPARE_V1}`,
          request,
        })),
      });
    };
    if (eligibility.attachStrategy === 'provider_attach') {
      // Ordinary independent native clients do not acquire managed detach custody.
      const exitCode = await attachNativeProvider();
      if (!isAttachSuccess(exitCode)) process.exit(typeof exitCode === 'number' ? exitCode : 1);
      return;
    }

    const restoreManagedTerminal = async (expectedTerminal?: NonNullable<Metadata['terminal']>) => {
      const restored = await callSessionRpc({
        token: context.credentials.token, sessionId: resolvedSessionId,
        mode: resolveSessionStoredContentEncryptionMode(context.rawSession),
        ctx: resolveSessionEncryptionContextFromCredentials(context.credentials, context.rawSession),
        method: `${resolvedSessionId}:switch`, request: { to: 'local' },
      });
      if (restored !== true) throw new Error('Failed to restore the managed terminal attachment.');
      const current = await readTerminalAttachmentInfoFn({ happyHomeDir: configuration.happyHomeDir, sessionId: resolvedSessionId });
      if (!current || (current.version === 1
        ? !expectedTerminal || !terminalAttachmentMatchesTerminal(current, expectedTerminal)
        : current.handle.attachmentId !== current.attachmentId)) {
        throw new Error('The restored managed terminal has no exact attachment.');
      }
      return current.terminal;
    };
    let terminal = eligibility.terminal;
    const localControl = getAgentLocalControlCapabilityForSession({
      agentId: eligibility.agentId,
      metadata: eligibility.metadata,
    });
    if (localControl?.topology === 'shared' && localControl.attachStrategy === 'provider_attach') {
      const recorded = terminal.mode === 'herdr' ? terminal.herdr : null;
      const presence = await probeSessionRunnerPresence({ sessionId: resolvedSessionId, trackedSessions: [] });
      const retiredControl = terminal.controlServiceabilityV1;
      const retiredCandidate = !localInfo && retiredControl?.retired === true
        && retiredControl.reason === 'attachment_retired' && Boolean(retiredControl.attachmentId)
        && (await readTerminalAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: resolvedSessionId })).status === 'absent';
      if (recorded?.paneId && ((localInfo && localInfo.version !== 1) || retiredCandidate) && process.env.HERDR_ENV === '1'
        && process.env.HERDR_SOCKET_PATH === recorded.socketPath && process.env.HERDR_PANE_ID === recorded.paneId
        && presence.state === 'runner_present') {
        const inherited = await resolveInheritedHerdrRuntime({ terminalRuntime: { mode: 'herdr', herdrSessionName: recorded.sessionName },
          env: { ...process.env } });
        if (inherited?.herdrTerminalId && (inherited.herdrTerminalId !== recorded.terminalId || retiredCandidate)
          && inherited.herdrSocketPath === recorded.socketPath && inherited.herdrPaneId === recorded.paneId) {
          // The current shell is a restoration candidate, not an owned pane. The
          // strict prepare owner admits the actual native launcher before status rebinding.
          const code = await attachNativeProvider({ ...recorded, paneId: recorded.paneId, terminalId: inherited.herdrTerminalId });
          if (!isAttachSuccess(code)) process.exit(typeof code === 'number' ? code : 1);
          return;
        }
      }
    }
    if (eligibility.attachStrategy === 'managed_provider_attach') {
      const terminal = await restoreManagedTerminal();
      const exitCode = await runTerminalHostAttach({ sessionId: resolvedSessionId, terminal, refreshRemoteControl: true },
        { runTmuxAttachFn, runZellijAttachFn, runHerdrAttachFn });
      if (exitCode === null) throw new Error('The restored managed terminal is not attachable.');
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }
    if (localControl?.topology === 'shared' && localControl.attachStrategy === 'provider_attach') {
      const presence = await probeSessionRunnerPresence({ sessionId: resolvedSessionId, trackedSessions: [] });
      // Host attachment focuses the controller's pane; only its switch owner can restore the managed TUI.
      const canOpenRestorationCandidate = eligibility.terminal.mode === 'herdr'
        && Boolean(eligibility.terminal.herdr?.paneId?.trim())
        && presence.state === 'runner_absent';
      // Opening an admitted local candidate can activate its saved resume. It
      // cannot rebind the Session; a present or unproven runner keeps RPC admission.
      if (!canOpenRestorationCandidate) {
        terminal = await restoreManagedTerminal(eligibility.terminal);
      }
    }

    const hostExitCode = await runTerminalHostAttach({
      sessionId: resolvedSessionId,
      terminal,
      refreshRemoteControl: shouldRefreshRemoteControlOnAttach(eligibility.metadata),
    }, { runTmuxAttachFn, runZellijAttachFn, runHerdrAttachFn });
    let exitCode = hostExitCode ?? 0;
    if (hostExitCode === null) {
      switch (eligibility.plan.type) {
        case 'windows_terminal_host':
          exitCode = await runWindowsTerminalAttachFn({
            sessionId: resolvedSessionId,
            terminal,
          });
          break;
        case 'windows_console_host':
          exitCode = await runWindowsConsoleAttachFn({
            sessionId: resolvedSessionId,
            terminal,
          });
          break;
        default:
          throw new Error('No terminal attach implementation is available for this session.');
      }
    }
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  const terminal = localInfo?.terminal ?? null;
  if (!terminal) {
    printMissingAttachInfo(resolvedSessionId);
    process.exit(1);
  }

  const hostExitCode = await runTerminalHostAttach({ sessionId: resolvedSessionId, terminal }, {
    runTmuxAttachFn, runZellijAttachFn, runHerdrAttachFn,
  });
  let exitCode = hostExitCode ?? 0;
  if (hostExitCode === null) {
    if (terminal.mode === 'windows_terminal') {
      exitCode = await runWindowsTerminalAttachFn({ sessionId: resolvedSessionId, terminal });
    } else if (terminal.mode === 'windows_console') {
      exitCode = await runWindowsConsoleAttachFn({ sessionId: resolvedSessionId, terminal });
    } else {
      console.error(fail('Session was not started in an attachable terminal host.'));
      process.exit(1);
    }
  }
  if (exitCode !== 0) process.exit(exitCode);
}

export async function handleAttachCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAttachCommand(context.args.slice(1));
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
