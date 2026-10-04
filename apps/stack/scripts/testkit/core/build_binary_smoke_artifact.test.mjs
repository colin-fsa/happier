import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from './temp_fixture.mjs';
import { prepareBinarySmokeArtifact } from './build_binary_smoke_artifact.mjs';

test('binary smoke consumes the producer archive without compiling again', async (t) => {
  const fixture = await createTempFixture(t);
  const artifactPath = fixture.path('archive.tar.gz');
  await writeFile(artifactPath, 'producer bytes');
  await prepareBinarySmokeArtifact({
    artifactPath,
    env: { HAPPIER_CLI_TEST_SKIP_BUILD: '1' },
    // Build is the OS compiler process boundary, not mocked domain logic.
    build: () => { throw new Error('unexpected compilation'); },
  });
  assert.equal(await readFile(artifactPath, 'utf8'), 'producer bytes');
});

test('missing downloaded archives fail instead of hiding a producer defect', async (t) => {
  const fixture = await createTempFixture(t);
  await assert.rejects(prepareBinarySmokeArtifact({
    artifactPath: fixture.path('absent.tar.gz'),
    env: { HAPPIER_CLI_TEST_SKIP_BUILD: '1' },
    build: () => { throw new Error('unexpected compilation'); },
  }), { code: 'ENOENT' });
});

test('local smoke still builds and validates its archive', async (t) => {
  const fixture = await createTempFixture(t);
  const artifactPath = fixture.path('local.tar.gz');
  await prepareBinarySmokeArtifact({
    artifactPath, env: {}, build: () => writeFile(artifactPath, 'local bytes'),
  });
  assert.equal(await readFile(artifactPath, 'utf8'), 'local bytes');
});
