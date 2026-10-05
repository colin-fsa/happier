import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { writeSessionMarker } from '../sessionRegistry';
import { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { createTerminalAttachmentId, readTerminalAttachmentInfo, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';
import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { resolveTrackedSessionTerminalPresentation } from './resolveTrackedSessionTerminalPresentation';
import { resolveTrackedSessionTerminalHostExitCandidate } from './disconnectedTerminalHostSupervision';

describe('recovered optional terminal presentation', () => {
  it('selects the current optional presenter after final exit even when the initial publication names its predecessor', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'optional-replacement-exit-' }, async ({ homeDir }) => {
      const sessionId = 'optional-replacement-session';
      const attachmentId = createTerminalAttachmentId();
      const tracked: TrackedSession = { pid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
        publishedTerminalControlServiceabilityAttachmentId: 'initial-presenter', spawnOptions: {
          directory: homeDir, backendTarget: { kind: 'builtInAgent', agentId: 'opencode' }, terminal: { mode: 'tmux' },
        } };
      await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId, attachmentId,
        handle: { attachmentId, kind: 'tmux', sessionName: 'replacement-host', paneId: '0.1',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } },
        terminal: { mode: 'tmux', tmux: { target: 'replacement-host:0.1' } },
      });
      const attachmentInfo = await readTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId });
      await expect(resolveTrackedSessionTerminalHostExitCandidate({ tracked, pid: tracked.pid, happyHomeDir: homeDir, attachmentInfo }))
        .resolves.toMatchObject({ sessionId, attachmentId, spawnOptions: tracked.spawnOptions });
      // A closed optional presenter is normal headless operation, not missing agent/server custody.
      await expect(resolveTrackedSessionTerminalHostExitCandidate({ tracked, pid: tracked.pid, happyHomeDir: homeDir, attachmentInfo: null }))
        .resolves.toBeNull();
    });
  });
  it('recovers the admitted runtime selection from the real dead-runner marker, not changed defaults', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'optional-marker-', env: {
      HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: 'false', HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
    } }, async ({ homeDir }) => {
      const runner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await once(runner, 'spawn');
      await once(runner, 'exit');
      if (!runner.pid) throw new Error('Synthetic runner has no PID');
      const sessionId = 'optional-marker-session';
      const attachmentId = createTerminalAttachmentId();
      const credentials = { token: 'synthetic-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
      const spawnOptions: SpawnSessionOptions = {
        directory: homeDir, backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        terminal: { mode: 'tmux' }, environmentVariables: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
      };
      const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(spawnOptions, { encryptionMaterial: credentials.encryption });
      if (!respawn) throw new Error('Synthetic runtime selection was not persisted');
      await writeSessionMarker({ pid: runner.pid, happySessionId: sessionId, startedBy: 'daemon', flavor: 'opencode', cwd: homeDir, respawn });
      await writeTerminalAttachmentInfo({ happyHomeDir: homeDir, sessionId, attachmentId,
        handle: { attachmentId, kind: 'tmux', sessionName: 'optional-marker-host', paneId: '0.0',
          attachMetadata: { attachStrategy: 'terminal_host', topology: 'shared', locality: 'same_machine', liveProbe: 'required' } },
        terminal: { mode: 'tmux', tmux: { target: 'optional-marker-host:0.0' } },
      });
      const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: new Map<number, TrackedSession>(), credentials });
      const candidate = result.disconnectedTerminalHostCandidates?.[0];
      expect(candidate).toMatchObject({ sessionId, pid: runner.pid, spawnOptions });
      if (!candidate) throw new Error('Recovered marker has no terminal candidate');
      // Consumption is the real catalog/provider decision, not merely persisted field presence.
      await expect(resolveTrackedSessionTerminalPresentation({ startedBy: 'daemon', ...candidate })).resolves.toMatchObject({ kind: 'provider_attach' });
    });
  });
});
