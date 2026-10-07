import { join } from 'node:path';

import type {
  ConnectedServicesMaterializationDiagnostic,
  ConnectedServicesProviderMaterializer,
} from '@/daemon/connectedServices/materialize/providerMaterializerTypes';

import { importGeminiChatSessionForResume } from './geminiChatSessionFiles';
import { materializeGeminiConnectedServiceAuth } from './materializeGeminiConnectedServiceAuth';

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createGeminiConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const gemini = params.recordsByServiceId.get('gemini') ?? null;
    if (!gemini) return null;
    const write = () => materializeGeminiConnectedServiceAuth({ rootDir: params.rootDir, record: gemini });
    const materialized = await (params.writeArtifacts ? params.writeArtifacts(write) : write());

    // Native->connected (and re-homed) session continuity: Gemini CLI resolves ACP
    // `loadSession(resumeId)` against chat files inside the home it runs with, so the resumed
    // chat must be carried into the freshly materialized isolated home before spawn. Best-effort:
    // a miss surfaces as a warning diagnostic and the fail-closed resume reachability verifier
    // (`verifyResumeReachableGemini`) remains the authority for whether the resume may proceed.
    const diagnostics: ConnectedServicesMaterializationDiagnostic[] = [];
    const vendorResumeId = asNonEmptyString(params.vendorResumeId);
    if (vendorResumeId) {
      const targetHomeDir = asNonEmptyString(materialized.env.GEMINI_CLI_HOME) ?? join(params.rootDir, 'home');
      try {
        const importSession = () => importGeminiChatSessionForResume({
          targetHomeDir,
          sourceEnv: params.processEnv ?? process.env,
          cwd: asNonEmptyString(params.sessionDirectory),
          vendorResumeId,
          candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
        });
        const importResult = await (params.writeArtifacts ? params.writeArtifacts(importSession) : importSession());
        if (!importResult.imported && importResult.reason && importResult.reason !== 'already_present') {
          diagnostics.push({
            code: 'gemini_chat_session_import_skipped',
            providerId: 'gemini',
            severity: 'warning',
            serviceId: 'gemini',
            reason: importResult.reason,
          });
        }
      } catch (error) {
        diagnostics.push({
          code: 'gemini_chat_session_import_failed',
          providerId: 'gemini',
          severity: 'warning',
          serviceId: 'gemini',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      env: materialized.env,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      cleanupOnFailure: params.cleanupRoot,
      cleanupOnExit: null,
    };
  };
}
