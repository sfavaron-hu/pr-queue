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

// `gh search prs` yields lowercase state, `gh pr list` uppercase. Both reach
// buildPR, and a missed case makes a merged PR look open — the worst misread here.
test('buildPR normalizes gh state case', () => {
  const mk = (state) => buildPR(
    { number: 1, title: 't', url: 'https://x/1', repository: { nameWithOwner: 'o/r' }, state },
    { headRefName: 'b', updatedAt: 'z' });
  assert.equal(mk('merged').merged, true);
  assert.equal(mk('MERGED').merged, true);
  assert.equal(mk('closed').closed, true);
  assert.equal(mk('CLOSED').closed, true);
  const open = mk('open');
  assert.equal(open.merged, false);
  assert.equal(open.closed, false);
});

// The bug this closes: react-workflows#6 was a DRAFT closed without merging.
// `--state open` and `--merged` between them never return it, so the branch read
// as "no PR" and the gate offered to open a fresh draft for rejected work.
test('buildPR marks a closed-unmerged draft as closed, not merged', () => {
  const pr = buildPR(
    { number: 6, title: 'backport notify', url: 'https://x/6',
      repository: { nameWithOwner: 'HumandDev/react-workflows' }, state: 'CLOSED' },
    { headRefName: 'feat/notify-backport-pr-on-deploy', isDraft: true, updatedAt: 'z' });
  assert.equal(pr.closed, true);
  assert.equal(pr.merged, false);
  assert.equal(pr.draft, true);
});

test('fetchPRsForBranches asks per branch and builds contract PRs', async () => {
  const { fetchPRsForBranches } = require('../assist/prs.js');
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args.join(' '));
    return JSON.stringify([{ number: 22, title: 'squad members', state: 'MERGED',
      url: 'https://github.com/HumandDev/humand-product-workflow/pull/22',
      headRefName: 'workflow/teams-github-members-from-pr-mentions',
      isDraft: false, reviews: [], updatedAt: 'z' }]);
  };
  const { prs, warnings } = await fetchPRsForBranches({ run, branches: [
    { githubRepo: 'HumandDev/humand-product-workflow', branch: 'workflow/teams-github-members-from-pr-mentions' },
  ]});
  assert.equal(warnings.length, 0);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].merged, true);
  assert.equal(prs[0].owner, 'HumandDev');
  assert.equal(prs[0].repo, 'humand-product-workflow');
  assert.deepEqual(Object.keys(prs[0]).sort(), [...PR_CONTRACT_FIELDS].sort());
  assert.ok(calls[0].includes('--state all'), 'must ask for every state, not just open');
  assert.ok(calls[0].includes('--head workflow/teams-github-members-from-pr-mentions'));
});

// One failing branch must not lose the others, and must surface as a gh warning
// so isDegraded keeps the drain off worktrees.
test('fetchPRsForBranches isolates a per-branch failure as a gh warning', async () => {
  const { fetchPRsForBranches } = require('../assist/prs.js');
  const run = async (cmd, args) => {
    if (args.join(' ').includes('--head bad')) throw new Error('no repo');
    return JSON.stringify([]);
  };
  const { prs, warnings } = await fetchPRsForBranches({ run, branches: [
    { githubRepo: 'o/r', branch: 'bad' },
    { githubRepo: 'o/r', branch: 'good' },
  ]});
  assert.equal(prs.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].step.startsWith('gh'), 'must degrade the pass');
});

test('fetchPRsForBranches skips entries missing a slug or branch', async () => {
  const { fetchPRsForBranches } = require('../assist/prs.js');
  let calls = 0;
  const run = async () => { calls++; return '[]'; };
  await fetchPRsForBranches({ run, branches: [
    { githubRepo: null, branch: 'b' }, { githubRepo: 'o/r', branch: null },
  ]});
  assert.equal(calls, 0);
});
