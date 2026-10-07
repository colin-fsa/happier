import type { AccountSettings } from '@happier-dev/protocol';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol';

import { resolveExistingAgyAcpManagedBinPath } from '@/capabilities/deps/agyAcp';
import { ensureRuntimeInstallablesForLaunch } from '@/installables/runtime/ensureRuntimeInstallablesForLaunch';
import { readSettings } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAgyAcpReleaseAsset } from '@/runtime/managedTools/providers/agyAcpRelease';

export async function ensureAgyAcpServerForLaunch(params: Readonly<{
  accountSettings?: AccountSettings | null;
  env?: NodeJS.ProcessEnv;
  readinessOnly?: boolean;
}> = {}): Promise<Readonly<{ command: string; args: readonly string[] }>> {
  const machineId = (await readSettings()).machineId ?? '';
  const ensured = await ensureRuntimeInstallablesForLaunch({
    installableKeys: [INSTALLABLE_KEYS.AGY_ACP_SERVER],
    settings: params.accountSettings ?? getActiveAccountSettingsSnapshot()?.settings ?? null,
    machineId,
    env: params.env,
    ...(params.readinessOnly ? { readinessOnly: true } : {}),
  });
  if (!ensured.ok) {
    const detail = ensured.logPath ? `${ensured.errorMessage} (install log: ${ensured.logPath})` : ensured.errorMessage;
    throw new Error(`Agy ACP server is unavailable: ${detail}`);
  }

  const command = resolveExistingAgyAcpManagedBinPath();
  if (!command) {
    throw new Error('Agy ACP server install completed but no runnable managed executable was found');
  }
  return { command, args: resolveAgyAcpReleaseAsset().args };
}
