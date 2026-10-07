import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { t } from '@/text';
import {
  buildBugReportExportBundle,
  serializeBugReportExportBundle,
  type BugReportArtifactPayload,
  type BugReportEnvironmentPayload,
  type BugReportFormPayload,
} from '@happier-dev/protocol';

export async function exportBugReportDiagnosticsBundle(input: {
  environment: BugReportEnvironmentPayload;
  artifacts: readonly BugReportArtifactPayload[];
  form?: BugReportFormPayload;
  exportedAt?: string;
}): Promise<void> {
  const name = 'happier-diagnostics-' + String(Date.now()) + '.json';
  const bundle = buildBugReportExportBundle({
    exportedAt: input.exportedAt,
    form: input.form,
    environment: input.environment,
    artifacts: input.artifacts,
  });
  const contents = serializeBugReportExportBundle(bundle);

  const created = await createNativeCacheFileSink({ directoryName: 'happier-downloads', name });
  if (!created.ok) throw new Error(created.error);
  let retainCacheFile = false;
  try {
    await created.sink.writeBytes(new TextEncoder().encode(contents));
    await created.sink.close();
    const result = await shareNativeCacheFile({
      fileUri: created.sink.fileUri,
      name,
      mimeType: 'application/json',
      dialogTitle: t('common.saveAs'),
      UTI: 'public.json',
    });
    if (result.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
    if (result.status === 'shared') retainCacheFile = result.retainCacheFile;
  } finally {
    if (!retainCacheFile) await created.sink.cleanup();
  }
}
