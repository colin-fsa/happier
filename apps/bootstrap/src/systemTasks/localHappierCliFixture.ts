import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installVersionedPayload, resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

/** Real install records for resolver tests; execution is replaced at the OS process boundary. */
export async function installManagedCliFixture(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  releaseRing?: PublicReleaseRingId;
}>) {
  const releaseRing = params.releaseRing ?? 'stable';
  const payloadRoot = await mkdtemp(join(tmpdir(), 'hsetup-service-cli-payload-'));
  try {
    await mkdir(join(payloadRoot, 'package-dist'));
    await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n');
    await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), 'process boundary fixture\n');
    await installVersionedPayload({ componentId: 'happier-cli', processEnv: params.processEnv, releaseRing, versionId: '0.2.13', payloadRoot });
  } finally {
    await rm(payloadRoot, { recursive: true, force: true });
  }
  return {
    command: resolveInstalledFirstPartyComponentPaths({ componentId: 'happier-cli', processEnv: params.processEnv, releaseRing }).binaryPath,
    provenance: 'managed' as const,
    version: '0.2.13',
  };
}
