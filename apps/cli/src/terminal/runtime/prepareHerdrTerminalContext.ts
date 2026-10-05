import { configuration } from '@/configuration';
import { admitHerdrServer } from '@/integrations/herdr/adapter';
import { createHerdrClient } from '@/integrations/herdr/client';
import { resolveHerdrRuntimeBinary } from '@/integrations/herdr/runtimeBinary';
import { resolveDefaultTerminalHostStartupTimeoutMs } from '@/integrations/terminalHost/defaultRegistry';
import { TerminalHostStartupError } from '@/integrations/terminalHost/errors';
import { readTerminalAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import type { TerminalRuntimeFlags } from './terminalRuntimeFlags';

/** Resolve in the launch owner's context, before native authentication changes child configuration. */
export async function prepareHerdrTerminalContext(params: Readonly<{
  sessionName: string;
  existingSessionId?: string;
}>): Promise<Required<Pick<TerminalRuntimeFlags, 'herdrSessionName' | 'herdrSocketPath'>>> {
  let sessionName = params.sessionName;
  let retainedSocketPath: string | undefined;
  if (params.existingSessionId) {
    const attachment = await readTerminalAttachmentState({
      happyHomeDir: configuration.happyHomeDir, sessionId: params.existingSessionId,
    });
    if (attachment.status === 'unreadable'
      || (attachment.status === 'present' && attachment.info.version === 1
        && attachment.info.terminal.mode === 'herdr')) {
      throw new TerminalHostStartupError({
        hostKind: 'herdr', reason: 'recovery_probe_inconclusive',
        message: 'The retained Herdr terminal context cannot be verified.',
        launchFailure: { launchDisposition: 'not_started', cleanupIncomplete: false },
      });
    }
    if (attachment.status === 'present' && attachment.info.version !== 1
      && attachment.info.handle.kind === 'herdr') {
      // Exact local custody owns the endpoint, even if today's host preference
      // or authentication environment points elsewhere. Later adoption still
      // revalidates the attachment; endpoint admission grants no pane custody.
      sessionName = attachment.info.handle.sessionName;
      retainedSocketPath = attachment.info.handle.socketPath;
      if (!retainedSocketPath) throw new TerminalHostStartupError({
        hostKind: 'herdr', reason: 'recovery_probe_inconclusive',
        message: 'The retained Herdr terminal endpoint cannot be verified.',
        launchFailure: { launchDisposition: 'not_started', cleanupIncomplete: false },
      });
    }
  }
  const actionTimeoutMs = configuration.claudeUnifiedTerminalHostActionTimeoutMs;
  const binary = await resolveHerdrRuntimeBinary({ actionTimeoutMs });
  if (!binary) throw new TerminalHostStartupError({
    hostKind: 'herdr', reason: 'installation_unavailable',
    message: 'Herdr hosting requires a supported Herdr installation on this machine.',
    launchFailure: { launchDisposition: 'not_started', cleanupIncomplete: false },
  });
  const socketPath = await admitHerdrServer(createHerdrClient({
    binary, sessionName, socketPath: retainedSocketPath, actionTimeoutMs,
    startupTimeoutMs: resolveDefaultTerminalHostStartupTimeoutMs(),
  }));
  return { herdrSessionName: sessionName, herdrSocketPath: socketPath };
}
