import type { DirectSessionImportOperation, DirectSessionTakeoverPersistResponse } from '@happier-dev/protocol';

export type DirectSessionImportControl = Readonly<{
  signal: AbortSignal;
  update: (progress: Partial<Pick<DirectSessionImportOperation, 'phase' | 'importedCount' | 'totalCount'>>) => void;
}>;

type ImportEntry = {
  mode: 'direct' | 'persisted';
  snapshot: DirectSessionImportOperation;
  controller: AbortController;
  completion: Promise<DirectSessionTakeoverPersistResponse>;
};

// One daemon-owned takeover per linked session, including import. Released synchronous
// RPCs and the asynchronous UI share this owner and the import's stable message IDs.
export function createDirectSessionTakeoverOperations() {
  const entries = new Map<string, ImportEntry>();
  const key = (machineId: string, sessionId: string) => JSON.stringify([machineId, sessionId]);
  return {
    read(machineId: string, sessionId: string): DirectSessionImportOperation | null {
      const entry = entries.get(key(machineId, sessionId));
      return entry?.mode === 'persisted' ? { ...entry.snapshot } : null;
    },
    cancel(machineId: string, sessionId: string): DirectSessionImportOperation | null {
      const entry = entries.get(key(machineId, sessionId));
      if (entry?.mode === 'persisted' && entry.snapshot.canCancel) {
        entry.snapshot = { ...entry.snapshot, state: 'cancelling', canCancel: false };
        entry.controller.abort();
      }
      return entry?.mode === 'persisted' ? { ...entry.snapshot } : null;
    },
    start(machineId: string, sessionId: string, mode: 'direct' | 'persisted', execute: (control: DirectSessionImportControl) => Promise<DirectSessionTakeoverPersistResponse>) {
      const entryKey = key(machineId, sessionId);
      const previous = entries.get(entryKey);
      if (previous && (previous.snapshot.state === 'running' || previous.snapshot.state === 'cancelling')) {
        return previous.mode === mode ? previous : null;
      }
      const controller = new AbortController();
      const entry: ImportEntry = {
        mode,
        snapshot: { sessionId, state: 'running', phase: 'preparing', importedCount: 0, canCancel: true },
        controller,
        completion: Promise.resolve().then(() => execute({
            signal: controller.signal,
            update(progress) {
              // Starting the runner commits takeover: cancellation only interrupts reading/import.
              if (progress.phase === 'starting') controller.signal.throwIfAborted();
              entry.snapshot = {
                ...entry.snapshot, ...progress,
                canCancel: !controller.signal.aborted && !['starting', 'converting'].includes(progress.phase ?? entry.snapshot.phase),
              };
            },
          })).catch((error: unknown): DirectSessionTakeoverPersistResponse => ({
            ok: false, errorCode: 'internal_error',
            error: error instanceof Error ? error.message : 'direct_session_import_failed',
          })).then((result) => {
            entry.snapshot = {
              ...entry.snapshot, canCancel: false,
              state: result.ok ? 'completed' : controller.signal.aborted ? 'cancelled' : 'failed',
              ...(!result.ok && !controller.signal.aborted ? { error: result.error } : {}),
            };
            return result;
          }),
      };
      entries.set(entryKey, entry);
      return entry;
    },
  };
}
