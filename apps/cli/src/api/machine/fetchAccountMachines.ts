import axios from 'axios';
import { z } from 'zod';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// Identity-only readers also consume these rows. Older relays omit replacement
// and revocation fields; absence retains their released meaning.
const accountMachineSchema = z.object({
  id: z.string().min(1),
  active: z.boolean().optional(),
  revokedAt: z.number().nullable().optional(),
  replacedByMachineId: z.string().nullable().optional(),
});
const accountMachineInventorySchema = z.array(accountMachineSchema);
export type AccountMachineInventoryRow = z.infer<typeof accountMachineSchema>;

/** One authenticated Account inventory read; labels never establish identity. */
export async function fetchAccountMachines(params: Readonly<{
  credentials: Readonly<{ token: string }>;
  timeoutMs?: number;
}>): Promise<readonly AccountMachineInventoryRow[] | null> {
  try {
    const response = await axios.get<unknown>(`${resolveServerHttpBaseUrl()}/v1/machines`, {
      headers: { Authorization: `Bearer ${params.credentials.token}` },
      timeout: params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 15_000,
    });
    const parsed = accountMachineInventorySchema.safeParse(response.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
