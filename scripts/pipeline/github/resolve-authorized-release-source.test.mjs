import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveAuthorizedReleaseSource } from './resolve-authorized-release-source.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'authorized-release-source-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  git(root, ['init', work]);
  git(work, ['config', 'user.email', 'release-test@example.invalid']);
  git(work, ['config', 'user.name', 'Release Test']);
  execFileSync('sh', ['-c', 'printf test > payload && git add payload && git commit -m initial'], { cwd: work });
  const sha = git(work, ['rev-parse', 'HEAD']);
  git(root, ['init', '--bare', remote]);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['branch', '-M', 'preview']);
  git(work, ['tag', 'v-test']);
  git(work, ['tag', 'cli-v1.2.3-preview.4']);
  git(work, ['tag', '-a', 'v-annotated', '-m', 'annotated']);
  git(work, ['push', 'origin', 'preview', 'refs/tags/v-test', 'refs/tags/cli-v1.2.3-preview.4', 'refs/tags/v-annotated']);
  return { root, work, remote, sha };
}

test('trusted release source resolver binds branches, tags, and existing full SHAs', async () => {
  const { work, remote, sha } = await fixture();
  assert.equal((await resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'preview' })).sha, sha);
  assert.equal((await resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'v-test' })).sha, sha);
  assert.equal((await resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'v-annotated' })).sha, sha);
  assert.equal((await resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: sha })).sha, sha);
});

test('trusted release source resolver rejects malformed, missing, and branch/tag-ambiguous refs', async () => {
  const { work, remote } = await fixture();
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: '../main' }), /invalid/i);
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'missing' }), /not found/i);
  git(work, ['tag', 'preview']);
  git(work, ['push', 'origin', 'refs/tags/preview']);
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'preview' }), /ambiguous/i);
});

test('trusted release source resolver keeps a reachable authorized candidate when its source branch advances', async () => {
  const { work, remote, sha } = await fixture();
  assert.equal((await resolveAuthorizedReleaseSource({
    repoRoot: work,
    remoteUrl: remote,
    sourceRef: 'preview',
    authorizedSha: sha,
    allowSourceAncestor: true,
  })).sha, sha);
  execFileSync('sh', ['-c', 'printf moved >> payload && git add payload && git commit -m moved'], { cwd: work, stdio: 'ignore' });
  git(work, ['push', 'origin', 'HEAD:refs/heads/preview']);
  assert.equal((await resolveAuthorizedReleaseSource({
    repoRoot: work,
    remoteUrl: remote,
    sourceRef: 'preview',
    authorizedSha: sha,
    allowSourceAncestor: true,
  })).sha, sha);
  await assert.rejects(resolveAuthorizedReleaseSource({
    repoRoot: work,
    remoteUrl: remote,
    sourceRef: 'preview',
    authorizedSha: 'b'.repeat(40),
  }), /authorized.*not found|did not match/i);
});

test('authorized branch candidates require remote ancestry, including from a shallow control checkout', async () => {
  const { root, work, remote, sha } = await fixture();
  git(work, ['commit', '--allow-empty', '-m', 'later merge']);
  const tip = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', 'origin', 'HEAD:refs/heads/preview']);
  const shallow = join(root, 'shallow');
  git(root, ['clone', '--depth=1', '--branch=preview', `file://${remote}`, shallow]);
  assert.equal((await resolveAuthorizedReleaseSource({ repoRoot: shallow, remoteUrl: remote, sourceRef: 'refs/heads/preview', authorizedSha: sha, allowSourceAncestor: true })).sha, sha);
  const unrelated = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated'], { cwd: work, encoding: 'utf8' }).trim();
  git(work, ['push', 'origin', `${unrelated}:refs/heads/other`]);
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'preview', authorizedSha: unrelated, allowSourceAncestor: true }), /not.*ancestor|not.*reachable/i);
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'preview', authorizedSha: sha }), /did not match/i);
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: 'v-test', authorizedSha: tip, allowSourceAncestor: true }), /did not match/i);
  await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef: sha, authorizedSha: tip, allowSourceAncestor: true }), /did not match/i);
});

test('same-version recovery keeps the immutable tag SHA after the channel branch advances', async () => {
  const { work, remote, sha: immutableSha } = await fixture();
  execFileSync('sh', ['-c', 'printf moved >> payload && git add payload && git commit -m moved'], {
    cwd: work,
    stdio: 'ignore',
  });
  git(work, ['push', 'origin', 'HEAD:refs/heads/preview']);
  const movedChannelSha = git(work, ['rev-parse', 'HEAD']);
  assert.notEqual(movedChannelSha, immutableSha);

  const recovered = await resolveAuthorizedReleaseSource({
    repoRoot: work,
    remoteUrl: remote,
    sourceRef: 'refs/tags/cli-v1.2.3-preview.4',
  });
  assert.equal(recovered.kind, 'tag');
  assert.equal(recovered.sha, immutableSha);
});

test('trusted release source resolver rejects shell and GitHub-command payloads as malformed data', async () => {
  const { work, remote } = await fixture();
  for (const sourceRef of [
    'preview"; touch /tmp/pwned; echo "',
    '$(touch /tmp/pwned)',
    'preview\n::set-output name=authorized_sha::deadbeef',
    "preview'$(id)'",
  ]) {
    await assert.rejects(resolveAuthorizedReleaseSource({ repoRoot: work, remoteUrl: remote, sourceRef }), /invalid/i);
  }
});
