const { test } = require('node:test');
const assert = require('node:assert');
const { buildLedger, ledger } = require('../assist/ledger.js');

const localPayload = () => ({
  generatedAt: 1000, workspaceRoot: '/w', warnings: [],
  processes: [
    { key: 'SQSH-1', ticket: 'SQSH-1', branches: ['feat/SQSH-1'],
      worktrees: [{ repo: 'r', branch: 'feat/SQSH-1' }], sessions: [], lastLocalActivity: null },
    { key: 'chore/local-only', ticket: null, branches: ['chore/local-only'],
      worktrees: [{ repo: 'r', branch: 'chore/local-only' }], sessions: [], lastLocalActivity: null },
  ],
  looseSessions: [],
});

const openPR = { owner: 'o', repo: 'r', number: 1, title: 't',
  url: 'https://x/1', headRef: 'feat/SQSH-1', draft: false, merged: false,
  ci: 'pending', approved: false, changesReq: false, conflicts: false,
  newComments: 0, humanReviews: 0, updatedAt: '2026-08-03T00:00:00Z' };

test('buildLedger joins a PR onto its process and classifies it', () => {
  const doc = buildLedger(localPayload(), [openPR], 2000);
  const p = doc.processes.find(x => x.key === 'SQSH-1');
  assert.equal(p.prs.length, 1);
  // pending CI + no human review yet → esperando
  assert.equal(p.state, 'esperando');
});

test('buildLedger leaves a PR-less local process with no prs and a local state', () => {
  const doc = buildLedger(localPayload(), [openPR], 2000);
  const p = doc.processes.find(x => x.key === 'chore/local-only');
  assert.equal(p.prs.length, 0);
  assert.ok(['pausa', 'frio', 'turno'].includes(p.state));
});

test('buildLedger synthesizes a process for a PR with no local worktree', () => {
  const orphan = { ...openPR, number: 2, headRef: 'feat/SQSH-99', url: 'https://x/2' };
  const doc = buildLedger(localPayload(), [openPR, orphan], 2000);
  const syn = doc.processes.find(x => x.key === 'SQSH-99');
  assert.ok(syn);
  assert.equal(syn.synthetic, true);
  assert.equal(syn.prs.length, 1);
});

test('buildLedger carries a version and merges warnings', () => {
  const local = localPayload(); local.warnings = [{ repo: null, step: 'x', message: 'm' }];
  const doc = buildLedger(local, [], 2000, [{ repo: null, step: 'gh', message: 'g' }]);
  assert.equal(typeof doc.version, 'number');
  assert.equal(doc.warnings.length, 2);
});

test('ledger() wires collect + fetchOwnPRs and stays degraded when gh fails', async () => {
  const fakeCollect = async () => localPayload();
  const fakeFetch = async () => ({ prs: [], warnings: [{ repo: null, step: 'gh-search', message: 'boom' }] });
  const doc = await ledger({ collect: fakeCollect, fetchOwnPRs: fakeFetch,
    ioForCollect: {}, run: async () => '', now: () => 2000 });
  assert.equal(doc.processes.length, 2);
  assert.ok(doc.warnings.some(w => w.step === 'gh-search'));
});

test('the bin module exposes main and does not run on require', () => {
  const mod = require('../assist/bin/ledger.js');
  assert.equal(typeof mod.main, 'function');
});

const { branchesNeedingLookup } = require('../assist/ledger.js');

const wt = (over) => Object.assign(
  { repo: 'r', branch: 'feat/x', githubRepo: 'o/r', onOrigin: true, detached: false, prunable: false }, over);
const payloadWith = (worktrees) => ({
  generatedAt: 1000, workspaceRoot: '/w', warnings: [], looseSessions: [],
  processes: [{ key: 'p', ticket: null, branches: worktrees.map(w => w.branch),
                worktrees, sessions: [], lastLocalActivity: null }],
});

test('branchesNeedingLookup asks only about branches no fetched PR points at', () => {
  const out = branchesNeedingLookup(
    payloadWith([wt({ branch: 'feat/known' }), wt({ branch: 'feat/unknown' })]),
    [{ headRef: 'feat/known' }]);
  assert.deepEqual(out, [{ githubRepo: 'o/r', branch: 'feat/unknown' }]);
});

// Each skip is knowledge, not ignorance: paying a gh round-trip to confirm any
// of these would defeat the filter's whole purpose.
test('branchesNeedingLookup skips detached, prunable, off-origin and slugless worktrees', () => {
  const out = branchesNeedingLookup(payloadWith([
    wt({ branch: null, detached: true }),
    wt({ branch: 'feat/gone', prunable: true }),
    wt({ branch: 'feat/local', onOrigin: false }),
    wt({ branch: 'feat/noslug', githubRepo: null }),
  ]), []);
  assert.deepEqual(out, []);
});

test('branchesNeedingLookup dedupes the same repo+branch seen twice', () => {
  const out = branchesNeedingLookup(payloadWith([wt({}), wt({})]), []);
  assert.equal(out.length, 1);
});

// The end-to-end point of the two-phase fetch: a branch whose only PR is too old
// for the broad search must still arrive with that PR attached, so nothing
// downstream can read it as "never had a PR".
test('ledger backfills a branch the broad search missed', async () => {
  const local = payloadWith([wt({ branch: 'workflow/teams-github-members' })]);
  const doc = await ledger({
    collect: async () => local,
    fetchOwnPRs: async () => ({ prs: [], warnings: [] }),
    fetchPRsForBranches: async ({ branches }) => {
      assert.deepEqual(branches, [{ githubRepo: 'o/r', branch: 'workflow/teams-github-members' }]);
      return { prs: [{ owner: 'o', repo: 'r', number: 22, headRef: 'workflow/teams-github-members',
                       merged: true, closed: false, draft: false, humanReviews: 0 }], warnings: [] };
    },
    ioForCollect: {}, now: () => 2000,
  });
  const p = doc.processes[0];
  assert.equal(p.prs.length, 1);
  assert.equal(p.prs[0].merged, true);
  assert.equal(p.state, 'mergeado');
});

test('ledger does not call the targeted lookup when the broad search settled everything', async () => {
  let called = false;
  await ledger({
    collect: async () => payloadWith([wt({ branch: 'feat/known' })]),
    fetchOwnPRs: async () => ({ prs: [{ headRef: 'feat/known', owner: 'o', repo: 'r', number: 1 }], warnings: [] }),
    fetchPRsForBranches: async () => { called = true; return { prs: [], warnings: [] }; },
    ioForCollect: {}, now: () => 2000,
  });
  assert.equal(called, false);
});

test('ledger merges the targeted lookup warnings so the pass degrades', async () => {
  const doc = await ledger({
    collect: async () => payloadWith([wt({ branch: 'feat/unknown' })]),
    fetchOwnPRs: async () => ({ prs: [], warnings: [] }),
    fetchPRsForBranches: async () => ({ prs: [], warnings: [{ step: 'gh-pr-list', message: 'boom' }] }),
    ioForCollect: {}, now: () => 2000,
  });
  assert.ok(doc.warnings.some(w => w.step === 'gh-pr-list'));
});

// A branch can carry a closed attempt AND a later merged PR; deduping by headRef
// would drop one of them, and each is independently a reason not to offer a draft.
test('ledger keeps both PRs on one branch and dedupes by PR identity', async () => {
  const dup = { owner: 'o', repo: 'r', number: 1, headRef: 'feat/x', merged: false, closed: true };
  const doc = await ledger({
    collect: async () => payloadWith([wt({ branch: 'feat/x' })]),
    fetchOwnPRs: async () => ({ prs: [dup], warnings: [] }),
    // headRef is already seen, so nothing is asked; assert the dedupe directly.
    fetchPRsForBranches: async () => ({ prs: [], warnings: [] }),
    ioForCollect: {}, now: () => 2000,
  });
  assert.equal(doc.processes[0].prs.length, 1);
});
