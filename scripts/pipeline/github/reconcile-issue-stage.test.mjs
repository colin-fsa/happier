import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advanceIssueStage,
  snapshotOpenIssueNumbers,
} from './reconcile-issue-stage.mjs';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

test('source snapshot paginates open issues and excludes pull requests', async () => {
  const requests = [];
  const pages = [
    jsonResponse(
      [{ number: 12 }, { number: 13, pull_request: { url: 'https://example.invalid/pr/13' } }],
      { headers: { link: '<https://api.github.test/repos/happier-dev/happier/issues?page=2>; rel="next"' } },
    ),
    jsonResponse([{ number: 14 }]),
  ];

  const issues = await snapshotOpenIssueNumbers({
    repository: 'happier-dev/happier',
    fromStage: 'stage:source',
    token: 'test-token',
    apiBaseUrl: 'https://api.github.test',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return pages.shift();
    },
  });

  assert.deepEqual(issues, [12, 14]);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /state=open/);
  assert.match(requests[0].url, /labels=stage%3Asource/);
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-token');
});

test('candidate snapshots intersect the stage queue with references in the exact paginated release range', async () => {
  const baseSha = 'a'.repeat(40);
  const candidateSha = 'b'.repeat(40);
  const compareUrl = `https://api.github.test/repos/happier-dev/happier/compare/${baseSha}...${candidateSha}?per_page=100`;
  const requests = [];
  const issues = await snapshotOpenIssueNumbers({
    repository: 'happier-dev/happier', fromStage: 'stage:source', token: 'test-token',
    baseSha, candidateSha, apiBaseUrl: 'https://api.github.test',
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes('/issues?')) return jsonResponse([{ number: 12 }, { number: 14 }, { number: 18 }, { number: 19 }]);
      if (String(url) === compareUrl) return jsonResponse({
        commits: [{ commit: { message: 'fix(cli): correction\n\nRefs #12, happier-dev/happier#14\nFixes other/project#18\nDiscussion of #19' } }],
      }, { headers: { link: `<${compareUrl}&page=2>; rel="next"` } });
      assert.equal(String(url), `${compareUrl}&page=2`);
      return jsonResponse({ commits: [{ commit: { message: 'fix(ui): correction\n\nFixes https://github.com/happier-dev/happier/issues/14' } }] });
    },
  });
  assert.deepEqual(issues, [12, 14], 'later fixes and references to another repository cannot advance');
  assert.ok(requests.includes(compareUrl));
  assert.ok(requests.includes(`${compareUrl}&page=2`));
});

test('candidate snapshots reject partial or malformed range inputs instead of taking the whole queue', async () => {
  const input = { repository: 'happier-dev/happier', fromStage: 'stage:source', token: 'test-token', fetchImpl: async () => jsonResponse([{ number: 12 }]) };
  await assert.rejects(snapshotOpenIssueNumbers({ ...input, candidateSha: 'a'.repeat(40) }), /range|base/i);
  await assert.rejects(snapshotOpenIssueNumbers({ ...input, baseSha: 'main', candidateSha: 'a'.repeat(40) }), /SHA/i);
});

test('stage advancement re-reads targets and mutates only still-open issues at the expected stage', async () => {
  const mutations = [];
  const issues = new Map([
    [21, { number: 21, state: 'open', labels: [{ name: 'type: bug' }, { name: 'stage:source' }] }],
    [22, { number: 22, state: 'closed', labels: [{ name: 'stage:source' }] }],
    [23, { number: 23, state: 'open', labels: [{ name: 'stage:preview' }] }],
    [24, { number: 24, state: 'open', labels: [{ name: 'stage:source' }, { name: 'stage:dev' }] }],
    [25, { number: 25, state: 'open', labels: [{ name: 'stage:dev' }] }],
  ]);

  const results = await advanceIssueStage({
    repository: 'happier-dev/happier',
    issueNumbers: [21, 22, 23, 24, 25],
    fromStage: 'stage:source',
    toStage: 'stage:dev',
    token: 'test-token',
    apiBaseUrl: 'https://api.github.test',
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/labels') && (!init.method || init.method === 'GET')) {
        return jsonResponse([{ name: 'stage:source' }, { name: 'stage:dev' }]);
      }
      const match = parsed.pathname.match(/\/issues\/(\d+)(?:\/labels(?:\/[^/]+)?)?$/);
      assert.ok(match, `unexpected request ${url}`);
      const issueNumber = Number(match[1]);
      if (!init.method || init.method === 'GET') return jsonResponse(issues.get(issueNumber));
      mutations.push({ issueNumber, method: init.method, pathname: parsed.pathname, body: init.body });
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse([]);
    },
  });

  assert.deepEqual(results, [
    { issueNumber: 21, status: 'advanced' },
    { issueNumber: 22, status: 'skipped_closed' },
    { issueNumber: 23, status: 'skipped_stage_changed' },
    { issueNumber: 24, status: 'advanced' },
    { issueNumber: 25, status: 'already_advanced' },
  ]);
  assert.deepEqual(
    mutations.map(({ issueNumber, method }) => [issueNumber, method]),
    [[21, 'POST'], [21, 'DELETE'], [24, 'DELETE']],
    'the target label is added before source removal, while a partial prior run only removes source',
  );
  assert.deepEqual(JSON.parse(mutations[0].body), { labels: ['stage:dev'] });
});

test('stage advancement accepts forward releases and rejects same, backward, or unknown transitions', async () => {
  let requestCount = 0;
  const base = {
    repository: 'happier-dev/happier',
    issueNumbers: [],
    token: 'test-token',
    fetchImpl: async () => {
      requestCount += 1;
      return jsonResponse(ISSUE_STAGE_LABELS);
    },
  };

  const ISSUE_STAGE_LABELS = [
    { name: 'stage:source' },
    { name: 'stage:dev' },
    { name: 'stage:preview' },
    { name: 'stage:stable' },
  ];
  assert.deepEqual(
    await advanceIssueStage({ ...base, fromStage: 'stage:source', toStage: 'stage:preview' }),
    [],
  );
  assert.equal(requestCount, 0, 'an empty release queue should not require live label reconciliation');
  await assert.rejects(
    advanceIssueStage({ ...base, fromStage: 'stage:preview', toStage: 'stage:dev' }),
    /forward stage transition/,
  );
  await assert.rejects(
    advanceIssueStage({ ...base, fromStage: 'stage:dev', toStage: 'stage:dev' }),
    /forward stage transition/,
  );
  await assert.rejects(
    advanceIssueStage({ ...base, fromStage: 'stage:not-shipped', toStage: 'stage:dev' }),
    /recognized issue stage/,
  );
});
