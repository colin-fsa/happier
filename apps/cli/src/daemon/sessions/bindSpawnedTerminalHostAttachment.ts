import { buildTerminalAttachmentMetadataFromHostHandle } from '@/agent/runtime/terminal/attachmentMetadata';
import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';
import {
  createTerminalAttachmentId,
  writeTerminalAttachmentInfo,
  type BoundTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';

export async function bindSpawnedTerminalHostAttachment(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  handle: TerminalHostHandle;
  disposeUnboundHost: () => Promise<void>;
}>): Promise<BoundTerminalAttachmentInfo> {
  const attachmentId = params.handle.attachmentId ?? createTerminalAttachmentId();
  const handle = { ...params.handle, attachmentId };
  const terminal = buildTerminalAttachmentMetadataFromHostHandle(handle);
  if (!terminal) throw new Error(`Failed to build ${handle.kind} terminal attachment metadata`);
  try {
    const attachment = await writeTerminalAttachmentInfo({
      happyHomeDir: params.happyHomeDir,
      sessionId: params.sessionId,
      attachmentId,
      handle,
      terminal,
    });
    if (attachment.version !== 2) throw new Error('Spawned terminal attachment was not committed as owned');
    return attachment;
  } catch (bindingError) {
    try {
      await params.disposeUnboundHost();
    } catch (disposalError) {
      throw new AggregateError(
        [bindingError, disposalError],
        `Failed to bind and dispose an unbound ${handle.kind} terminal host`,
      );
    }
    throw bindingError;
  }
}
