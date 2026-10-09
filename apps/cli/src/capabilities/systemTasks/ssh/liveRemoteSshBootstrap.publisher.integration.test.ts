import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import { FIRST_PARTY_RELEASE_ARCHIVE_EXTRACTION_LIMITS } from '@happier-dev/release-runtime';
import { writeCredentialsLegacy } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { createLiveRemoteSshBootstrapTaskKind } from './liveRemoteSshBootstrap';

const { remoteProcess, home } = await vi.hoisted(async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'happier-ssh-bootstrap-auth-'));
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  return { remoteProcess: vi.fn(), home };
});

// Only the OS SSH/SCP boundary is mocked. Installation, envelope parsing,
// orchestration, credentials and encrypted auth approval stay real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) =>
      args[0] === 'ssh' || args[0] === 'scp' ? remoteProcess(...args) : actual.spawnSync(...args),
  };
});

const fixtureDir = process.env.HAPPIER_TEST_REMOTE_BOOTSTRAP_RELEASE_FIXTURE_DIR;
const assets = [
  'happier-v0.2.15-linux-x64.tar.gz',
  'checksums-happier-v0.2.15.txt',
  'checksums-happier-v0.2.15.txt.minisig',
];

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe.skipIf(!fixtureDir)('real SSH bootstrap with publisher-signed CLI 0.2.15', () => {
  it('selects the server and completes encrypted pairing after exit-1 not_authenticated', async () => {
    const recipient = tweetnacl.box.keyPair();
    const publicKey = Buffer.from(recipient.publicKey).toString('base64');
    const recoverySecret = new Uint8Array(32).fill(7);
    const remoteSteps: string[] = [];
    let approval: unknown;
    let origin = '';
    const server = createServer(async (request, response) => {
      if (request.url?.startsWith('/repos/')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ assets: assets.map((name) => ({ name, browser_download_url: `${origin}/${name}` })) }));
      } else if (request.url === '/v1/auth/response') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        approval = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      } else {
        const name = request.url?.slice(1);
        if (!name || !assets.includes(name)) {
          response.writeHead(404).end();
          return;
        }
        createReadStream(join(fixtureDir!, name)).pipe(response);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address');
    origin = `http://127.0.0.1:${address.port}`;

    const result = (status: number, value: unknown) => ({
      pid: 1, status, signal: null,
      stdout: `${JSON.stringify(value)}\n`, stderr: '', output: [null, '', ''],
    });
    remoteProcess.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'scp') return result(0, {});
      const remoteCommand = String(args.at(-1) ?? '');
      if (remoteCommand.includes('auth status --json')) {
        remoteSteps.push('auth.status');
        return result(1, { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
      }
      if (remoteCommand.includes('server set')) {
        remoteSteps.push('server.configure');
        expect(remoteCommand).toContain(origin);
        return result(0, { v: 1, ok: true, kind: 'server_set', data: {} });
      }
      if (remoteCommand.includes('auth request')) {
        remoteSteps.push('auth.request');
        return result(0, { v: 1, ok: true, kind: 'auth_request', data: { publicKey } });
      }
      if (remoteCommand.includes('auth wait')) {
        remoteSteps.push('auth.wait');
        expect(approval).toBeDefined();
        return result(0, { v: 1, ok: true, kind: 'auth_wait', data: { machineId: 'paired-machine' } });
      }
      if (remoteCommand.includes('uname -m')) return result(0, { platform: 'linux', arch: 'x86_64' });
      return result(0, {});
    });

    try {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('HAPPIER_HOME_DIR', home);
      vi.stubEnv('HAPPIER_SERVER_URL', origin);
      vi.stubEnv('HAPPIER_WEBAPP_URL', origin);
      vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', origin);
      reloadConfiguration();
      await writeCredentialsLegacy({ secret: recoverySecret, token: 'local-fixture-token' });

      const completed = await createLiveRemoteSshBootstrapTaskKind().run({
        params: {
          ssh: { target: 'dev@fresh.example.test', auth: 'agent' },
          relay: { relayUrl: origin }, knownHostsMode: 'system', serviceMode: 'none',
        },
        emit: () => undefined,
        prompt: async (request) => {
          expect(request.kind).toBe('auth.approveRemoteProvisioning');
          return { approved: true };
        },
      });
      expect(completed).toEqual({ publicKey, machineId: 'paired-machine' });
      expect(remoteSteps).toEqual(['auth.status', 'server.configure', 'auth.request', 'auth.wait']);
      expect(approval).toEqual({ publicKey, response: expect.any(String) });
      const bundle = Buffer.from((approval as { response: string }).response, 'base64');
      const plaintext = tweetnacl.box.open(bundle.subarray(56), bundle.subarray(32, 56), bundle.subarray(0, 32), recipient.secretKey);
      expect(plaintext).toEqual(new Uint8Array([0, ...deriveAccountMachineKeyFromRecoverySecret(recoverySecret)]));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(home, { recursive: true, force: true });
    }
  // This opt-in test extracts the publisher's real bundled dependency tree;
  // use its canonical extraction budget, not the unit/integration toy-fixture deadline.
  }, FIRST_PARTY_RELEASE_ARCHIVE_EXTRACTION_LIMITS.timeoutMs);
});
