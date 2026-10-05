import { access } from 'node:fs/promises';

export function usesPreparedBinarySmokeArtifacts(env = process.env) {
  return ['1', 'true', 'yes'].includes(String(env.HAPPIER_CLI_TEST_SKIP_BUILD ?? '').trim().toLowerCase());
}

export async function prepareBinarySmokeArtifact({ artifactPath, build, env = process.env }) {
  if (!usesPreparedBinarySmokeArtifacts(env)) {
    await build();
  }
  // A missing producer archive is a failure, never permission to rebuild it.
  await access(artifactPath);
}
