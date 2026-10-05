import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { launchOwnedTerminalProcess, type OwnedTerminalProcess } from '@/terminal/runtime/ownedTerminalProcess';
import { prepareOwnedTerminalSpawn } from '@/terminal/runtime/terminalLaunchSpec';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';
import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { createDefaultTerminalHostRegistry } from '@/integrations/terminalHost/defaultRegistry';
import { buildTerminalAttachmentMetadataFromHostHandle, buildTerminalHostHandleFromAttachmentMetadata } from '@/agent/runtime/terminal/attachmentMetadata';
import { bindSpawnedTerminalHostAttachment } from '@/daemon/sessions/bindSpawnedTerminalHostAttachment';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { clearTerminalControlServiceabilityProjection } from '@/daemon/sessions/terminalControlServiceabilityProjection';
import { resolveTerminalHostLaunchFailure, TerminalHostCreationError, TerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { bindHerdrAgentIfNeeded } from '@/integrations/herdr/bindManagedSession';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import type { SessionProviderCliAttachPrepareRequestV1 } from '@happier-dev/protocol';
import { createHerdrClient } from '@/integrations/herdr/client';
import { resolveHerdrRuntimeBinary } from '@/integrations/herdr/runtimeBinary';
import { createTerminalAttachmentId, readTerminalAttachmentState, terminalAttachmentMatchesTerminal, terminalMetadataMatchesHostHandle,
  writeTerminalAttachmentInfo, type ExactTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { proveTerminalClientCustody } from '@/terminal/runtime/terminalClientCustody';

type TerminalClientObservation = NonNullable<SessionProviderCliAttachPrepareRequestV1['terminalClient']>;

export type AttachedTerminalPresentation = Readonly<{
  runtime: TerminalRuntimeFlags | null | undefined;
  getSession: () => ApiSessionClient | null;
}>;

/** A selected optional client host, not an inherited foreground wrapper's current pane. */
export function hasHostedAttachedTerminalPresentation(runtime: TerminalRuntimeFlags | null | undefined): boolean {
  return runtime?.mode === 'plain'
    && (runtime.requested === 'herdr' || runtime.requested === 'zellij' || runtime.requested === 'tmux');
}

export type AttachedTerminalSupervisor<TTarget> = Readonly<{
  isAttached: () => boolean;
  attach: (target: TTarget) => Promise<boolean>;
  observeTerminalClient?: (target: TTarget, observation: TerminalClientObservation,
    isStillCurrent: () => Promise<boolean>) => Promise<boolean>;
  detach: () => Promise<void>;
  dispose: () => Promise<void>;
}>;

async function waitForExit(proc: OwnedTerminalProcess, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const finished = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    void proc.whenExited.then(finished, finished);
  });
}

/**
 * `env` lets a provider adapter supply a per-target environment (e.g. the credential of the exact
 * server this terminal attaches to) without mutating `process.env` or leaking secrets through argv.
 * Omitted ⇒ the supervisor's own environment is used.
 */
type AttachedTerminalInvocation = Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}>;

export function createAttachedTerminalSupervisor<TTarget>(params: Readonly<{
  resolveInvocation: (target: TTarget) => Promise<AttachedTerminalInvocation> | AttachedTerminalInvocation;
  spawnProcess?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  detachTimeoutMs?: number;
  onExit?: () => void | Promise<void>;
  terminalPresentation?: AttachedTerminalPresentation;
}>): AttachedTerminalSupervisor<TTarget> {
  const spawnProcess = params.spawnProcess ?? spawn;
  const env = params.env ?? process.env;
  const detachTimeoutMs = Math.max(100, Math.min(60_000, params.detachTimeoutMs ?? 3_000));
  let proc: OwnedTerminalProcess | null = null;
  const intentionallyDetached = new WeakSet<OwnedTerminalProcess>();
  let host: Readonly<{ adapter: TerminalHostAdapter; handle: TerminalHostHandle; session: ApiSessionClient;
    prepared: Awaited<ReturnType<typeof prepareOwnedTerminalSpawn>>; deadline: number; ready: boolean;
    bound: boolean; startup: AbortController;
    attachmentInfo: ExactTerminalAttachmentInfo | null; retirement: { requested: boolean } }> | null = null;
  let hostLaunchUnconfirmed = false;
  let borrowed: Readonly<{ session: ApiSessionClient; handle: TerminalHostHandle;
    observation: TerminalClientObservation; attachmentInfo: ExactTerminalAttachmentInfo;
    retirement: { requested: boolean; completion: Promise<void> | null } }> | null = null;
  const onMetadataUpdated = () => {
    const current = borrowed ?? host;
    const evidence = current?.session.getMetadataSnapshot()?.terminal?.controlServiceabilityV1;
    if (!current || evidence?.retired !== true || evidence.attachmentId !== current.handle.attachmentId) return;
    // Our retirement publishes metadata before unlinking the retry descriptor.
    // Neither its broadcast nor a later metadata update completes that local
    // obligation after unlink failed; only this resource's successful release does.
    if (current.retirement.requested) return;
    current.session.off('metadata-updated', onMetadataUpdated);
    if (current === borrowed) borrowed = null;
    if (current === host) { host.startup.abort(); host = null; }
    // The exact retirement producer has proved the old physical presentation gone.
    if ('prepared' in current) void current.prepared.cleanupUnreadArtifacts?.().catch(() => undefined);
    void params.onExit?.();
  };

  const detachBorrowed = async (): Promise<void> => {
    const current = borrowed;
    if (!current?.handle.attachmentId) return;
    // Explicit Detach kills the native process, whose exit callback can request
    // this same release. Share only this resource's complete retirement; other
    // dispositions retain the canonical exclusion/retry contract.
    if (current.retirement.completion) return await current.retirement.completion;
    current.retirement.requested = true;
    const completion = (async () => {
      const result = await executeTerminalHostDisposition({ happyHomeDir: configuration.happyHomeDir,
        sessionId: current.session.sessionId, expectedAttachmentId: current.handle.attachmentId!,
        expectedAttachmentInfo: current.attachmentInfo,
        intent: { kind: 'release_borrowed_host', reason: 'explicit_user_stop' },
        beforeDescriptorRetirement: async () => {
          await current.session.updateMetadata(metadata => clearTerminalControlServiceabilityProjection({ metadata,
            retiredAttachmentId: current.handle.attachmentId!, retiredAt: Date.now(), terminalMode: 'herdr' }));
        },
      });
      if (result.status !== 'retired') throw new Error('Borrowed native client cleanup is incomplete');
      current.session.off('metadata-updated', onMetadataUpdated);
      if (borrowed === current) borrowed = null;
    })();
    current.retirement.completion = completion;
    try { await completion; }
    finally {
      // Failed retirement remains retryable; a replacement resource never
      // inherits this old completion or its captured attachment identity.
      if (current.retirement.completion === completion) current.retirement.completion = null;
    }
  };

  const detachHost = async (): Promise<void> => {
    const current = host;
    if (!current?.handle.attachmentId) return;
    current.retirement.requested = true;
    if (!current.bound) {
      // The binding owner may have failed before persisting a descriptor. Its exact
      // created handle remains local custody until physical disposal succeeds.
      await current.adapter.dispose(current.handle);
      current.startup.abort();
      if (host === current) host = null;
      await current.prepared.cleanupUnreadArtifacts?.().catch(() => undefined);
      return;
    }
    const result = await executeTerminalHostDisposition({
      happyHomeDir: configuration.happyHomeDir, sessionId: current.session.sessionId,
      expectedAttachmentId: current.handle.attachmentId,
      expectedAttachmentInfo: current.attachmentInfo ?? undefined,
      intent: { kind: 'destroy_owned_host', reason: 'explicit_user_stop' }, adapter: current.adapter,
      beforeDescriptorRetirement: async () => {
        await current.session.updateMetadata(metadata => clearTerminalControlServiceabilityProjection({
          metadata, retiredAttachmentId: current.handle.attachmentId!, retiredAt: Date.now(), terminalMode: current.handle.kind,
        }));
      },
    });
    if (result.status !== 'destroyed' || result.descriptorRetained) {
      logger.infoFile('[terminal] Native terminal presentation cleanup incomplete', {
        status: result.status, ...('reason' in result ? { reason: result.reason } : {}),
        ...('descriptorRetained' in result ? { descriptorRetained: result.descriptorRetained } : {}),
      });
      throw new Error('Native terminal presentation cleanup is incomplete');
    }
    current.startup.abort();
    await current.prepared.cleanupUnreadArtifacts?.().catch(() => undefined);
    current.session.off('metadata-updated', onMetadataUpdated);
    if (host === current) host = null;
  };

  const awaitHostedStartup = async (): Promise<boolean> => {
    const current = host;
    if (!current || !current.bound) return false;
    if (current.ready) return true;
    const result = await current.prepared.awaitNativeSpawnResult?.(current.deadline,
      undefined, current.startup.signal);
    if (host !== current) return false;
    if (result === 'spawned') {
      // The native child now owns the live presentation. Artifact retirement already reports
      // failures at its owner; it must not terminate the admitted headless session.
      await current.prepared.cleanupUnreadArtifacts?.().catch(() => undefined);
      host = { ...current, ready: true };
      return true;
    }
    logger.infoFile('[terminal] Hosted native startup not confirmed (terminal_native_startup_unknown)');
    if (result === 'failed') await detachHost();
    // Ambiguous creation/startup retains its exact descriptor and unread handoff for Stop/reproof.
    return false;
  };

  const detach = async (): Promise<void> => {
    if (borrowed) return await detachBorrowed();
    if (host) return await detachHost();
    const child = proc;
    if (!child) return;
    intentionallyDetached.add(child);
    await child.signal('SIGINT');
    const exitedGracefully = await waitForExit(child, detachTimeoutMs);
    if (!exitedGracefully) {
      await child.signal('SIGKILL');
      await waitForExit(child, detachTimeoutMs);
    }
    if (proc === child) proc = null;
  };

  return {
    isAttached: () => borrowed !== null || proc !== null || host?.ready === true,
    observeTerminalClient: async (target, observation, isStillCurrent) => {
      const session = params.terminalPresentation?.getSession();
      const reject = (phase: string): false => {
        logger.infoFile('[terminal] Restored native client admission refused', {
          error: 'terminal_native_client_admission_refused', phase, sessionId: session?.sessionId,
        });
        return false;
      };
      if (!session || proc) return reject('controller_unavailable');
      const old = await readTerminalAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: session.sessionId });
      const oldInfo = old.status === 'present' && old.info.version !== 1 ? old.info : null;
      if (old.status === 'unreadable' || (old.status === 'present'
        && (!oldInfo || oldInfo.handle.kind !== 'herdr'))) return reject('local_descriptor_unavailable');
      // A completed heartbeat retirement removes local custody, not the controller's
      // historical placement. Only this authenticated Session snapshot supplies it.
      const retiredTerminal = old.status === 'absent' ? session.getMetadataSnapshot()?.terminal : null;
      const retiredControl = retiredTerminal?.controlServiceabilityV1;
      if (old.status === 'absent' && (!retiredTerminal || retiredControl?.retired !== true
        || retiredControl.reason !== 'attachment_retired' || !retiredControl.attachmentId)) return reject('retired_placement_unavailable');
      const oldHandle = oldInfo ? oldInfo.handle
        : retiredTerminal ? buildTerminalHostHandleFromAttachmentMetadata(retiredTerminal) : null;
      if (!oldHandle || oldHandle.kind !== 'herdr') return reject('recorded_host_unavailable');
      const geometry = observation.herdr;
      if (oldHandle.sessionName !== geometry.sessionName || oldHandle.socketPath !== geometry.socketPath
        || oldHandle.paneId !== geometry.paneId) return reject('recorded_placement_mismatch');
      if (!observation.attached) {
        if (!oldInfo || !borrowed || borrowed.handle.attachmentId !== oldInfo.attachmentId
          || borrowed.handle.terminalId !== geometry.terminalId
          || borrowed.observation.launcher.pid !== observation.launcher.pid
          || borrowed.observation.launcher.processInstanceFingerprint !== observation.launcher.processInstanceFingerprint) return reject('stale_release');
        if (!await isStillCurrent()) return reject('native_identity_changed');
        await detachBorrowed();
        return true;
      }
      if (borrowed) return (borrowed.handle.terminalId === geometry.terminalId
        && borrowed.observation.launcher.pid === observation.launcher.pid
        && borrowed.observation.launcher.processInstanceFingerprint === observation.launcher.processInstanceFingerprint)
        || reject('borrowed_client_replacement');
      const binary = await resolveHerdrRuntimeBinary({ actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs });
      if (!binary) return reject('herdr_binary_unavailable');
      const client = createHerdrClient({ binary, sessionName: geometry.sessionName, socketPath: geometry.socketPath,
        actionTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs,
        startupTimeoutMs: configuration.claudeUnifiedTerminalHostActionTimeoutMs });
      await client.assertServerVersion();
      const pane = await client.getPane(geometry.paneId);
      if (pane.terminalId !== geometry.terminalId || pane.paneId !== geometry.paneId) return reject('current_pane_mismatch');
      // A live descriptor cannot be replaced using a public pane hint. Exact
      // retired absence, however, can represent a detached borrowed client whose
      // shell still occupies this same terminal; native custody is proved below.
      const reusingRetiredPane = !oldInfo && oldHandle.terminalId === geometry.terminalId;
      if (!oldHandle.terminalId || (!reusingRetiredPane
        && (oldHandle.terminalId === geometry.terminalId
          || await client.findPane(oldHandle.terminalId)))) return reject('previous_host_alive');
      if (oldInfo?.version === 3 && oldInfo.nativeClientProcess) return reject('previous_native_client_custody');
      const invocation = await params.resolveInvocation(target);
      if (!await proveTerminalClientCustody({ launcher: observation.launcher,
        processes: await client.processInfo(pane.paneId), invocation, env: invocation.env ?? env })) return reject('native_process_custody');
      if (params.terminalPresentation?.getSession() !== session) return reject('controller_changed');
      const current = await readTerminalAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: session.sessionId });
      if (oldInfo) {
        if (current.status !== 'present' || current.info.version === 1 || current.info.version !== oldInfo.version
          || !terminalAttachmentMatchesTerminal(current.info, oldInfo.terminal, oldInfo.attachmentId)
          || current.info.handle.paneId !== oldHandle.paneId
          || (current.info.version === 3 && current.info.nativeClientProcess)) return reject('local_descriptor_changed');
      } else {
        const currentTerminal = session.getMetadataSnapshot()?.terminal;
        const currentControl = currentTerminal?.controlServiceabilityV1;
        if (current.status !== 'absent' || !currentTerminal
          || !terminalMetadataMatchesHostHandle(currentTerminal, oldHandle)
          || currentTerminal.herdr?.paneId !== oldHandle.paneId
          || currentControl?.attachmentId !== retiredControl?.attachmentId
          || currentControl?.retired !== true || currentControl.reason !== 'attachment_retired') return reject('retired_placement_changed');
      }
      if (!await isStillCurrent()) return reject('native_identity_changed');
      if (oldInfo) {
        const retired = await executeTerminalHostDisposition({ happyHomeDir: configuration.happyHomeDir,
          sessionId: session.sessionId, expectedAttachmentId: oldInfo.attachmentId,
          intent: oldInfo.version === 3 ? { kind: 'release_borrowed_host', reason: 'wrapper_exit' }
            : { kind: 'retire_confirmed_dead_attachment', reason: 'positive_dead_recovery' } });
        if (retired.status !== 'retired') return reject('previous_descriptor_retirement_incomplete');
      }
      if (host) {
        host.session.off('metadata-updated', onMetadataUpdated);
        host.startup.abort();
        await host.prepared.cleanupUnreadArtifacts?.();
        host = null;
      }
      const attachmentId = createTerminalAttachmentId();
      const handle: TerminalHostHandle = { attachmentId, kind: 'herdr', ...geometry,
        attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } };
      const terminal = buildTerminalAttachmentMetadataFromHostHandle(handle);
      if (!terminal) return reject('bound_terminal_metadata_unavailable');
      const attachmentInfo = await writeTerminalAttachmentInfo({ happyHomeDir: configuration.happyHomeDir, sessionId: session.sessionId,
        attachmentId, handle, terminal, lifecycle: 'borrowed', nativeClientProcess: observation.launcher });
      if (attachmentInfo.version !== 3) return reject('bound_client_descriptor_unavailable');
      borrowed = { session, handle, observation, attachmentInfo,
        retirement: { requested: false, completion: null } };
      session.on('metadata-updated', onMetadataUpdated);
      await session.updateMetadata(metadata => ({ ...metadata, terminal: { ...terminal,
        controlServiceabilityV1: { v: 1, attachmentId, state: 'servable', observedAt: Date.now() } } }));
      const agent = session.getMetadataSnapshot()?.flavor;
      if (agent) await bindHerdrAgentIfNeeded({ session, sessionId: session.sessionId, agent, terminal });
      return true;
    },
    attach: async (target) => {
      if (borrowed) return true;
      if (proc) return true;
      let phase = 'await_native_spawn';
      try {
        if (host) return await awaitHostedStartup();
        phase = 'resolve_invocation';
        const resolution = params.resolveInvocation(target);
        const resolved = resolution && typeof (resolution as PromiseLike<unknown>).then === 'function'
          ? await resolution
          : resolution as AttachedTerminalInvocation;
        const childEnv = resolved.env ?? env;
        const presentation = params.terminalPresentation;
        if (presentation && hasHostedAttachedTerminalPresentation(presentation.runtime)) {
          if (hostLaunchUnconfirmed) return false;
          phase = 'resolve_adapter';
          const session = presentation.getSession();
          const requested = presentation.runtime?.requested;
          if (!session || (requested !== 'herdr' && requested !== 'zellij' && requested !== 'tmux')) return false;
          const adapter = (await createDefaultTerminalHostRegistry({
            herdrSessionName: presentation.runtime?.herdrSessionName,
            herdrSocketPath: presentation.runtime?.herdrSocketPath,
          }))[requested];
          if (!adapter) throw new Error('Selected native terminal host is unavailable');
          // Initial presentation belongs to session startup; later explicit attachment reuses
          // that same preparation budget without a competing native-client timeout.
          const deadline = Date.now() + resolveSessionStartupTimeoutMs();
          phase = 'prepare_native';
          const prepared = await prepareOwnedTerminalSpawn({ command: resolved.command, args: resolved.args,
            env: childEnv, cwd: session.getMetadataSnapshot()?.path ?? process.cwd(), reportNativeSpawn: true,
            diagnostics: { sessionId: session.sessionId, logsDir: configuration.logsDir, sessionExitDir: join(configuration.logsDir, 'session-exit') },
          });
          let handle: TerminalHostHandle;
          try {
            phase = 'create_host';
            handle = await adapter.createOrAttachHost({
              sessionName: requested === 'herdr' ? presentation.runtime?.herdrSessionName ?? 'default'
                : requested === 'tmux' ? presentation.runtime?.tmuxTarget ?? 'happy' : session.sessionId,
              label: session.sessionId, workingDirectory: session.getMetadataSnapshot()?.path ?? process.cwd(),
              spawnArgv: prepared.spawnArgv,
              preparedLaunch: prepared,
              spawnEnv: { ...prepared.spawnEnv, ...(presentation.runtime?.tmuxTmpDir ? { TMUX_TMPDIR: presentation.runtime.tmuxTmpDir } : {}) },
              isolatedEnv: true, topology: 'shared',
            });
          } catch (error) {
            const failure = resolveTerminalHostLaunchFailure(error);
            hostLaunchUnconfirmed = !failure || failure.launchDisposition === 'unconfirmed';
            if (!hostLaunchUnconfirmed) {
              await prepared.cleanupUnreadArtifacts?.();
            }
            throw error;
          }
          const createdHost = { adapter, handle, session, prepared, deadline, ready: false, bound: false,
            startup: new AbortController(), attachmentInfo: null, retirement: { requested: false } };
          host = createdHost;
          phase = 'bind_attachment';
          const attachmentInfo = await bindSpawnedTerminalHostAttachment({ happyHomeDir: configuration.happyHomeDir, sessionId: session.sessionId,
            handle, disposeUnboundHost: detachHost });
          const retiredDuringBinding = host !== createdHost;
          host = { ...createdHost, bound: true, attachmentInfo };
          if (retiredDuringBinding) {
            // Physical Stop can win while the descriptor commit is in flight. Retire the
            // newly committed exact evidence before allowing the shared attach to settle.
            await detachHost();
            return false;
          }
          const terminal = buildTerminalAttachmentMetadataFromHostHandle(handle);
          if (!terminal || !handle.attachmentId) throw new Error('Native terminal presentation has no exact attachment');
          session.on('metadata-updated', onMetadataUpdated);
          phase = 'publish_attachment';
          await session.updateMetadata(metadata => ({ ...metadata, terminal: { ...terminal,
            controlServiceabilityV1: { v: 1, attachmentId: handle.attachmentId!, state: 'servable', observedAt: Date.now() },
          } }));
          const agent = session.getMetadataSnapshot()?.flavor;
          phase = 'bind_host_reporting';
          if (agent) await bindHerdrAgentIfNeeded({ session, sessionId: session.sessionId, agent, terminal });
          phase = 'await_native_spawn';
          return await awaitHostedStartup();
        }
        phase = 'prepare_native';
        const prepared = await prepareOwnedTerminalSpawn({
          command: resolved.command,
          args: [...resolved.args],
          env: childEnv,
          cwd: process.cwd(),
        });
        phase = 'await_native_spawn';
        const child = await launchOwnedTerminalProcess({ spawn: prepared, cwd: process.cwd(), spawnProcess });
        proc = child;
        let closeHandled = false;
        const handleClosed = (): void => {
          if (closeHandled) return;
          closeHandled = true;
          if (proc === child) proc = null;
          const wasIntentionallyDetached = intentionallyDetached.delete(child);
          if (!wasIntentionallyDetached) void params.onExit?.();
        };
        void child.whenExited.then(handleClosed, handleClosed);
        return true;
      } catch (error) {
        // Preparation and launch are optional after session admission. Keep the
        // shared remote owner alive; uncertain host custody still fences retries.
        const launchFailure = resolveTerminalHostLaunchFailure(error);
        logger.infoFile('[terminal] Native presentation unavailable (terminal_native_startup_failed)', {
          phase,
          category: error instanceof TerminalHostStartupError ? 'terminal_host_startup'
            : error instanceof TerminalHostCreationError ? 'terminal_host_creation'
              : error instanceof AggregateError ? 'cleanup_incomplete' : 'unclassified',
          ...(error instanceof TerminalHostStartupError ? { reason: error.reason } : {}),
          ...(launchFailure ? { launchDisposition: launchFailure.launchDisposition,
            cleanupIncomplete: launchFailure.cleanupIncomplete } : {}),
        });
        return false;
      }
    },
    detach,
    dispose: detach,
  };
}
