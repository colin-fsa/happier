import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import {
  applyConnectedServiceStateSharingDescriptor,
} from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import {
  readConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import type {
  ConnectedServiceSessionFileImportDetail,
  ConnectedServiceSessionFileImportRoot,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';

import {
  formatPiSessionDirectoryForCwd,
  resolvePiSessionIdFromResumeReference,
} from '@/backends/pi/utils/piSessionFiles';
import {
  applyPiCodingAgentDirChildEnvFormatting,
  formatPiCodingAgentDirForChildEnv,
  materializePiConnectedServiceAuth,
} from './materializePiConnectedServiceAuth';
import { piConnectedServiceStateSharingDescriptor } from './piConnectedServiceStateSharingDescriptor';

function resolvePiStateSharingMode(settingsLike: unknown): 'isolated' | 'shared' {
  const record = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? settingsLike as Readonly<Record<string, unknown>>
    : null;
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    record?.connectedServicesProviderStateSharingSettingsV1,
    'pi',
  ).stateMode;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringRecord(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function resolvePiNativeSourceAgentRoot(sourceEnv: Readonly<Record<string, string | undefined>>): string {
  const explicit = asNonEmptyString(sourceEnv.PI_CODING_AGENT_DIR);
  if (explicit) return explicit;
  // Resolve the native default relative to the provided env's HOME when available, falling back to
  // the process home. The materializer is given `processEnv` precisely so its native resolution does
  // not depend on ambient process state — important now that legacy sessions are BACKFILLED into the
  // native store (CS-FINDING-6): an ambient-home fallback would write into the real `~/.pi`.
  const homeBase = asNonEmptyString(sourceEnv.HOME) ?? homedir();
  return join(homeBase, '.pi', 'agent');
}

/**
 * Legacy PI session files (from `PI_CODING_AGENT_SESSION_DIR` or the one-release `pi-sessions`
 * staging root) are BACKFILLED into the NATIVE shared store — `~/.pi/agent/sessions/--<cwd>--`
 * (`nativeEncodedSessionsRoot`) — which is the SOURCE of the `sessions/--<cwd>--` symlink the
 * descriptor then materializes. Importing into the native store (instead of the symlink's own
 * destination path under `pi-agent-dir`) means the link exposes the backfilled file, and the
 * import no longer collides with `materializeLinkedStateEntry` (which would otherwise move the
 * freshly-imported dir aside into an orphaned `…--<cwd>--.local-<ts>/` and symlink over it,
 * leaving native — and therefore PI — without the file). See CS-FINDING-6.
 */
function buildPiLegacySessionImportRoots(params: Readonly<{
  rootDir: string;
  sourceEnv: Readonly<Record<string, string | undefined>>;
  nativeEncodedSessionsRoot: string;
}>): readonly ConnectedServiceSessionFileImportRoot[] {
  const legacySessionsEnv = asNonEmptyString(params.sourceEnv.PI_CODING_AGENT_SESSION_DIR);
  const legacySessionsRoot = join(params.rootDir, 'pi-sessions');
  const roots: ConnectedServiceSessionFileImportRoot[] = [
    ...(legacySessionsEnv ? [{
      sourceRoot: join(legacySessionsEnv, '--workdir--'),
      destinationRoot: params.nativeEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
    }, {
      sourceRoot: legacySessionsEnv,
      destinationRoot: params.nativeEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl') && !relativePath.includes('/'),
    }] : []),
    {
      sourceRoot: join(legacySessionsRoot, '--workdir--'),
      destinationRoot: params.nativeEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
    },
    {
      sourceRoot: legacySessionsRoot,
      destinationRoot: params.nativeEncodedSessionsRoot,
      includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl') && !relativePath.includes('/'),
    },
  ];
  return Array.from(new Map(
    roots.map((root) => [`${root.sourceRoot}:::${root.destinationRoot}`, root]),
  ).values());
}

function resolveVendorResumeIdFromImportedPiSessionFile(detail: ConnectedServiceSessionFileImportDetail): string | null {
  const candidates = [detail.relativePath, basename(detail.sourcePath), basename(detail.destinationPath)];
  for (const candidate of candidates) {
    const resolved = resolvePiSessionIdFromResumeReference(candidate);
    if (resolved) return resolved;
  }
  return null;
}

function formatPiMaterializedTargetEnvForStateSharing(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...env,
    PI_CODING_AGENT_DIR: formatPiCodingAgentDirForChildEnv(env.PI_CODING_AGENT_DIR),
  };
}

function formatPiPromotedChildEnv(input: Readonly<{ env: Record<string, string> }>): void {
  applyPiCodingAgentDirChildEnvFormatting(input.env);
}

export function createPiConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const openaiCodex = params.recordsByServiceId.get('openai-codex') ?? null;
    const openai = params.recordsByServiceId.get('openai') ?? null;
    const anthropic = params.recordsByServiceId.get('anthropic') ?? null;
    const claudeSubscription = params.recordsByServiceId.get('claude-subscription') ?? null;
    if (!openaiCodex && !openai && !anthropic && !claudeSubscription) return null;

    const write = () => materializePiConnectedServiceAuth({
      rootDir: params.rootDir,
      openaiCodex,
      openai,
      claudeSubscription,
      anthropic,
      ...(params.selectionsByServiceId ? { selectionsByServiceId: params.selectionsByServiceId } : {}),
    });
    const materialized = await (params.writeArtifacts ? params.writeArtifacts(write) : write());

    const requestedStateMode = resolvePiStateSharingMode(params.accountSettings);
    const cwd = asNonEmptyString(params.sessionDirectory);
    if (requestedStateMode !== 'shared' || !cwd) {
      return {
        env: materialized.env,
        afterPromote: formatPiPromotedChildEnv,
        cleanupOnFailure: params.cleanupRoot,
        cleanupOnExit: null,
      };
    }

    const sourceEnv = params.processEnv ?? process.env;
    const encodedCwdDir = formatPiSessionDirectoryForCwd(cwd);
    const nativeSourceRoot = resolvePiNativeSourceAgentRoot(sourceEnv);
    const targetMaterializedEnv = formatPiMaterializedTargetEnvForStateSharing(materialized.env);
    const targetSessionDir = join(materialized.env.PI_CODING_AGENT_DIR, 'sessions', encodedCwdDir);
    // Backfill destination = the NATIVE shared store for this cwd, which is also the SOURCE of the
    // `sessions/--<cwd>--` symlink materialized below. Importing here (not into the symlink's own
    // destination under pi-agent-dir) keeps legacy sessions in the single shared store and avoids the
    // import↔link collision that orphaned the file and left native empty (CS-FINDING-6).
    const nativeEncodedSessionsRoot = join(nativeSourceRoot, 'sessions', encodedCwdDir);
    // NOTE: pre-CS-FINDING-6 `…--<cwd>--.local-*` orphan dirs are intentionally NOT swept here. A
    // correct sweep must MIGRATE any orphaned session file into the native shared store before
    // deleting it (an orphan can be a session's only copy — confirmed on real data), and it must
    // operate on the PREVIOUS final root rather than this fresh attempt root. A blind delete keyed
    // off the attempt root (the prior implementation) was both a no-op and a latent data-loss bug.
    // That recovery is deliberately out of scope here — see
    // .reviews/2026-05-29-connected-services-deep-qa-audit (PI resume RCA).
    const manifest = await readConnectedServiceStateSharingManifest(params.rootDir);
    const applyState = () => applyConnectedServiceStateSharingDescriptor({
      descriptor: piConnectedServiceStateSharingDescriptor,
      nativeSourceContext: {
        sourceRoot: nativeSourceRoot,
        sourceEnv: toStringRecord(sourceEnv),
      },
      target: {
        targetMaterializedRoot: targetMaterializedEnv.PI_CODING_AGENT_DIR,
        targetMaterializedEnv,
      },
      configMode: 'isolated',
      requestedStateMode,
      effectiveStateMode: requestedStateMode,
      cwd,
      existingManifest: manifest,
      stateEntryNames: [`sessions/${encodedCwdDir}`],
      preserveDestinationWhenStateSourceMissing: (entryName: string) => entryName === `sessions/${encodedCwdDir}`,
      sessionImportRoots: buildPiLegacySessionImportRoots({
        rootDir: params.rootDir,
        sourceEnv,
        nativeEncodedSessionsRoot,
      }),
      resolveVendorResumeIdFromImportedFile: resolveVendorResumeIdFromImportedPiSessionFile,
      providerLabel: 'Pi',
    });
    const applyResult = await (params.writeArtifacts ? params.writeArtifacts(applyState) : applyState());
    const writeManifest = () => writeConnectedServiceStateSharingManifest(params.rootDir, applyResult.manifest);
    await (params.writeArtifacts ? params.writeArtifacts(writeManifest) : writeManifest());

    return {
      env: { ...materialized.env, PI_CODING_AGENT_SESSION_DIR: targetSessionDir, ...applyResult.envOverrides },
      afterPromote: formatPiPromotedChildEnv,
      diagnostics: applyResult.diagnostics,
      cleanupOnFailure: params.cleanupRoot,
      cleanupOnExit: null,
    };
  };
}
