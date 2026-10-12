import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';

const get = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get } }));
import { listSpawnMachineItems } from './spawnTargetDiscovery';

const credentials: Credentials = { token: 'account-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };

describe('account-scoped spawn machine discovery', () => {
  beforeEach(() => { get.mockReset(); });
  it('lists local and remote account machines independent of local daemon profiles', async () => {
    get.mockResolvedValue({ data: [
      { id: 'local', active: true, revokedAt: null, replacedByMachineId: null },
      { id: 'remote', active: true, revokedAt: null, replacedByMachineId: null },
      { id: 'offline', active: false, revokedAt: null, replacedByMachineId: null },
      { id: 'revoked', active: true, revokedAt: 1, replacedByMachineId: null },
      { id: 'replaced', active: false, revokedAt: null, replacedByMachineId: 'remote' },
    ] });
    const result = await listSpawnMachineItems({ credentials });
    expect(result.items.map((item) => [item.machineId, item.daemonRunning])).toEqual([
      ['local', true], ['remote', true], ['offline', false],
    ]);
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/machines$/), expect.objectContaining({ headers: { Authorization: 'Bearer account-token' } }));
  });
  it('reports unreadable inventory rather than claiming that the fleet is empty', async () => {
    get.mockRejectedValue(new Error('relay unavailable'));
    await expect(listSpawnMachineItems({ credentials })).rejects.toMatchObject({ code: 'machine_inventory_unavailable' });
  });
});
