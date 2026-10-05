import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

const root = new URL('../../', import.meta.url);
const checkoutAction = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';

test('one root-owned all-settled inventory drives local and CI shared-package tests', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const workflow = YAML.parse(await readFile(new URL('.github/workflows/tests.yml', root), 'utf8'));
  const owner = await import(new URL('scripts/testing/lib/sharedPackageTestCommands.ts', root));
  const job = workflow.jobs['shared-packages-unit'];
  const commands = (job.steps ?? []).map((step) => String(step.run ?? '')).join('\n');

  assert.equal(packageJson.scripts['test:shared-packages:local'], 'node --experimental-strip-types scripts/testing/runSharedPackageTests.ts');
  // Root execution and shared-package delegation are exercised by rootPackageScripts.test.ts.
  assert.deepEqual(owner.SHARED_PACKAGE_TEST_COMMANDS.map(({ id, args }) => ({ id, args: [...args] })), [
    { id: 'privacy-kit:test', args: ['workspace', 'privacy-kit', 'test'] },
    { id: 'privacy-kit:bun', args: ['workspace', 'privacy-kit', 'test:runtime:bun'] },
    { id: 'protocol', args: ['workspace', '@happier-dev/protocol', 'test'] },
    { id: 'transfers', args: ['workspace', '@happier-dev/transfers', 'test'] },
    { id: 'sherpa-native', args: ['workspace', '@happier-dev/sherpa-native', 'test'] },
    { id: 'agents', args: ['workspace', '@happier-dev/agents', 'test'] },
    { id: 'cli-common', args: ['workspace', '@happier-dev/cli-common', 'test'] },
    { id: 'release-runtime', args: ['workspace', '@happier-dev/release-runtime', 'test'] },
    { id: 'connection-supervisor', args: ['workspace', '@happier-dev/connection-supervisor', 'test'] },
    { id: 'bootstrap', args: ['workspace', '@happier-dev/bootstrap', 'test'] },
    { id: 'docs:test', args: ['workspace', 'docs', 'test'] },
    { id: 'docs:content', args: ['workspace', 'docs', 'check:content'] },
    { id: 'website', args: ['workspace', '@happier-dev/website', 'test'] },
    { id: 'relay-server', args: ['--cwd', 'packages/relay-server', 'test'] },
  ]);
  assert.match(commands, /yarn -s test:shared-packages:local/u);
  assert.doesNotMatch(commands, /yarn workspace privacy-kit test\n/u);
  assert.equal(job['timeout-minutes'], 45);
});

test('shared-package CI materializes stable and unreleased discovery trees for website claims', async () => {
  const workflow = YAML.parse(await readFile(new URL('.github/workflows/tests.yml', root), 'utf8'));
  const job = workflow.jobs['shared-packages-unit'];
  const checkouts = job.steps.filter((step) => step.with?.repository === 'happier-dev/happier');
  const run = job.steps.find((step) => String(step.run ?? '').includes('test:shared-packages:local'));

  assert.equal(job.permissions.contents, 'read');
  assert.deepEqual(checkouts.map((step) => ({
    uses: step.uses,
    ref: step.with.ref,
    path: step.with.path,
    persistCredentials: step.with['persist-credentials'],
    sparseCheckout: step.with['sparse-checkout'],
  })), [
    { uses: checkoutAction, ref: 'cli-stable', path: '.ci/released-cli-stable', persistCredentials: false, sparseCheckout: 'packages/agents/src' },
    { uses: checkoutAction, ref: 'v0.3', path: '.ci/unreleased-v0.3', persistCredentials: false, sparseCheckout: 'packages/agents/src' },
  ]);
  assert.equal(run.env.HAPPIER_SHIPPED_TREE, '${{ github.workspace }}/.ci/released-cli-stable');
  assert.equal(run.env.HAPPIER_UNRELEASED_TREE, '${{ github.workspace }}/.ci/unreleased-v0.3');
  assert.ok(checkouts.every((step) => job.steps.indexOf(step) < job.steps.indexOf(run)));
});

test('build smoke owns the four production build surfaces with a final result collector', async () => {
  const workflow = YAML.parse(await readFile(new URL('.github/workflows/tests.yml', root), 'utf8'));
  const job = workflow.jobs['build-smoke'];
  assert.equal(job.if, "${{ (inputs.select_jobs_explicitly && inputs.run_build_smoke) || (!inputs.select_jobs_explicitly && needs.ci_plan.outputs.run_build_smoke == 'true') }}");
  assert.deepEqual(job.needs, ['ci_plan', 'trusted_ref_guard']);
  assert.equal(job['runs-on'], '${{ needs.trusted_ref_guard.outputs.ubuntu_2404 }}');
  assert.equal(job['timeout-minutes'], 120);
  assert.equal(job.env.VITE_POSTHOG_KEY, '');
  assert.equal(job.env.NEXT_PUBLIC_POSTHOG_KEY, '');
  const commands = job.steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(commands, /self_host_binary_smoke\.integration\.test\.mjs/u);
  assert.match(commands, /release-build-ui-web-bundle --secrets-source env --channel preview/u);
  assert.match(commands, /yarn workspace @happier-dev\/website build/u);
  assert.match(commands, /yarn workspace docs build/u);
  const owner = job.steps.find((step) => step.id === 'require-build-smoke-checks');
  assert.equal(owner.if, '${{ always() }}');
});
