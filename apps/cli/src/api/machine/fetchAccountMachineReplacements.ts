import { type MachineReplacementRecord } from '@happier-dev/protocol';

import { fetchAccountMachines } from './fetchAccountMachines';

/**
 * The Account's machine rows, reduced to the identity a REPLACEMENT walk needs.
 *
 * A replaced machine keeps its row and gains a forward pointer; nothing re-homes
 * the Sessions that named it. The daemon therefore cannot tell a Session it
 * inherited from its own predecessor apart from one belonging to an unrelated
 * machine without the Account's chain, and the chain lives only on the server —
 * the registration-time `replacesMachineId` candidate is consumed once the
 * server acknowledges it, and a MANUAL replacement (a genuinely new host, which
 * is what replacing a machine means) never passes through this daemon at all.
 *
 * One list read answers the whole walk, so callers never pay per hop. Callers
 * must ask only when the cheap identity comparison already failed.
 */
export async function fetchAccountMachineReplacements(params: Readonly<{
  credentials: Readonly<{ token: string }>;
  timeoutMs?: number;
}>): Promise<readonly MachineReplacementRecord[] | null> {
  const machines = await fetchAccountMachines(params);
  // An unreadable chain proves nothing; callers keep their original refusal.
  return machines?.map(({ id, replacedByMachineId }) => ({
    id,
    ...(typeof replacedByMachineId === 'string' ? { replacedByMachineId } : {}),
  })) ?? null;
}
