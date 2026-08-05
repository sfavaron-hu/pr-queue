const { test } = require('node:test');
const assert = require('node:assert');
const { ciFromRollup, buildPR, fetchOwnPRs } = require('../assist/prs.js');
const { PR_CONTRACT_FIELDS } = require('../classify.js');

test('ciFromRollup maps GitHub check conclusions', () => {
  assert.equal(ciFromRollup([]), 'unknown');
  assert.equal(ciFromRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }]), 'green');
  assert.equal(ciFromRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failed');
  assert.equal(ciFromRollup([{ conclusion: 'SUCCESS' }, { conclusion: null }]), 'pending');
  assert.equal(ciFromRollup([{ status: 'IN_PROGRESS', conclusion: null }]), 'pending');
});

test('buildPR emits exactly the contract fields', () => {
  const item = { number: 9914, title: 'fix x', url: 'https://github.com/HumandDev/humand-web/pull/9914',
    repository: { nameWithOwner: 'HumandDev/humand-web' }, state: 'OPEN' };
  const view = { headRefName: 'fix/no-ticket-x', isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    reviews: [{ author: { login: 'someone' } }], updatedAt: '2026-08-03T18:35:37Z' };
  const pr = buildPR(item, view);
  assert.deepEqual(Object.keys(pr).sort(), [...PR_CONTRACT_FIELDS].sort());
  assert.equal(pr.owner, 'HumandDev');
  assert.equal(pr.repo, 'humand-web');
  assert.equal(pr.headRef, 'fix/no-ticket-x');
  assert.equal(pr.draft, false);
  assert.equal(pr.merged, false);
  assert.equal(pr.ci, 'green');
  assert.equal(pr.conflicts, false);
  assert.equal(pr.approved, false);
  assert.equal(pr.changesReq, false);
  assert.equal(pr.humanReviews, 1);
});

test('buildPR reads review + conflict + merged state', () => {
  const item = { number: 1, title: 't', url: 'https://github.com/o/r/pull/1',
    repository: { nameWithOwner: 'o/r' }, state: 'MERGED' };
  const view = { headRefName: 'b', isDraft: true, reviewDecision: 'CHANGES_REQUESTED',
    mergeable: 'CONFLICTING', statusCheckRollup: [], reviews: [], updatedAt: '2026-08-03T00:00:00Z' };
  const pr = buildPR(item, view);
  assert.equal(pr.merged, true);
  assert.equal(pr.draft, true);
  assert.equal(pr.changesReq, true);
  assert.equal(pr.approved, false);
  assert.equal(pr.conflicts, true);
  assert.equal(pr.ci, 'unknown');
});

test('buildPR rejects a non-http url (defense in depth)', () => {
  const item = { number: 1, title: 't', url: 'javascript:alert(1)',
    repository: { nameWithOwner: 'o/r' }, state: 'OPEN' };
  const view = { headRefName: 'b', isDraft: false, reviewDecision: null,
    mergeable: 'MERGEABLE', statusCheckRollup: [], reviews: [], updatedAt: '2026-08-03T00:00:00Z' };
  assert.equal(buildPR(item, view).url, null);
});

test('fetchOwnPRs shells gh search then gh pr view, and normalizes', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'search') {
      if (args.includes('--merged')) {
        return JSON.stringify([]);
      }
      return JSON.stringify([{ number: 1, title: 't', url: 'https://github.com/o/r/pull/1',
        repository: { nameWithOwner: 'o/r' }, state: 'OPEN' }]);
    }
    // gh pr view
    return JSON.stringify({ headRefName: 'feat/SQSH-1', isDraft: false, reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      reviews: [], updatedAt: '2026-08-03T00:00:00Z' });
  };
  const { prs, warnings } = await fetchOwnPRs({ run, now: () => 0 });
  assert.equal(warnings.length, 0);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].headRef, 'feat/SQSH-1');
  assert.equal(prs[0].approved, true);
  assert.ok(calls.some(c => c[1] === 'search'));
  assert.ok(calls.some(c => c[1] === 'pr' && c[2] === 'view'));
});

test('fetchOwnPRs pulls merged PRs from a 30-day window, not 3 days', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args);
    if (args[0] === 'search') return JSON.stringify([]);
    return JSON.stringify({ headRefName: 'b', isDraft: false, reviewDecision: null,
      mergeable: 'MERGEABLE', statusCheckRollup: [], reviews: [], updatedAt: '2026-08-05T00:00:00Z' });
  };
  const now = () => Date.parse('2026-08-05T00:00:00Z');
  await fetchOwnPRs({ run, now });
  const mergedSearch = calls.find(a => a.includes('--merged'));
  const mergedAt = mergedSearch[mergedSearch.indexOf('--merged-at') + 1];
  assert.equal(mergedAt, '>=2026-07-06');                     // 30 days back, so a PR merged 07-21 is seen
  assert.equal(mergedSearch[mergedSearch.indexOf('--limit') + 1], '60');   // limit raised for the wider window
});

test('fetchOwnPRs degrades to a warning when gh fails, never throws', async () => {
  const run = async () => { throw new Error('gh: not found'); };
  const { prs, warnings } = await fetchOwnPRs({ run, now: () => 0 });
  assert.deepEqual(prs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /gh/);
});
