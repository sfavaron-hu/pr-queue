const { test } = require('node:test');
const assert = require('node:assert');
const { prSplitIsMeaningful, rowSizeStats, rowNewActivity } = require('../classify.js');

// A row is what attachOwnPRs/synthesizeProcesses produce: { proc, prs }.
const row = (prs, proc) => ({ proc: Object.assign({ key: 'k' }, proc), prs: prs });

// ── prSplitIsMeaningful ──

test('the con/sin split is meaningful when some row has no PR', () => {
  assert.equal(prSplitIsMeaningful([row([{ number: 1 }]), row([])]), true);
});

test('the con/sin split is degenerate when every row has a PR', () => {
  // The static deploy: every row is synthesized from a PR, so "sin PR" is
  // always empty and "con PR" is always the whole list.
  assert.equal(prSplitIsMeaningful([row([{ number: 1 }]), row([{ number: 2 }])]), false);
});

test('a merged-only row still counts as having a PR', () => {
  assert.equal(prSplitIsMeaningful([row([{ number: 1, merged: true }])]), false);
});

test('an empty or absent row list is degenerate, not a crash', () => {
  assert.equal(prSplitIsMeaningful([]), false);
  assert.equal(prSplitIsMeaningful(null), false);
  assert.equal(prSplitIsMeaningful(undefined), false);
});

// ── rowSizeStats ──

test('rowSizeStats reports the diff of a single-PR row', () => {
  assert.deepEqual(rowSizeStats(row([{ additions: 30, deletions: 12 }])),
                   { additions: 30, deletions: 12, lines: 42 });
});

test('rowSizeStats refuses to size a multi-PR row', () => {
  // Bucketing the sum of two repos' diffs describes neither of them.
  assert.equal(rowSizeStats(row([{ additions: 40, deletions: 0 },
                                 { additions: 900, deletions: 20 }])), null);
});

test('rowSizeStats returns null when the PR carries no numbers', () => {
  // loadOwnPRs's merged query never fetches additions/deletions, and an older
  // cached PR predates the fields — neither may render as a confident 0.
  assert.equal(rowSizeStats(row([{ number: 1 }])), null);
  assert.equal(rowSizeStats(row([{ additions: 5 }])), null);
});

test('rowSizeStats survives an empty or absent row', () => {
  assert.equal(rowSizeStats(row([])), null);
  assert.equal(rowSizeStats({ proc: {} }), null);
  assert.equal(rowSizeStats(null), null);
});

test('a zero-line PR is still a real diff, not a missing one', () => {
  assert.deepEqual(rowSizeStats(row([{ additions: 0, deletions: 0 }])),
                   { additions: 0, deletions: 0, lines: 0 });
});

// ── rowNewActivity ──

test('rowNewActivity sums unseen comments and reviews across the row', () => {
  const r = row([{ newComments: 2, newApprovals: 1, newChanges: 0 },
                 { newComments: 1, newApprovals: 0, newChanges: 3 }]);
  assert.deepEqual(rowNewActivity(r), { comments: 3, reviews: 4 });
});

test('rowNewActivity treats absent counters as zero', () => {
  assert.deepEqual(rowNewActivity(row([{ number: 1 }])), { comments: 0, reviews: 0 });
  assert.deepEqual(rowNewActivity(row([])), { comments: 0, reviews: 0 });
  assert.deepEqual(rowNewActivity(null), { comments: 0, reviews: 0 });
});

// ── processRepoLabel ──

const { processRepoLabel } = require('../classify.js');

test('processRepoLabel annotates each repo with its PR number', () => {
  assert.equal(processRepoLabel([{ repo: 'humand-web' }],
                                [{ repo: 'humand-web', number: 9884 }]),
               'humand-web #9884');
});

test('processRepoLabel names a PR repo with no worktree', () => {
  // Every row on the static deploy: no worktrees at all.
  assert.equal(processRepoLabel([], [{ repo: 'humand-web', number: 9884 },
                                     { repo: 'material-hu', number: 1331 }]),
               'humand-web #9884 · material-hu #1331');
});

test('processRepoLabel keeps a worktree repo that has no PR yet', () => {
  // Dropping it would leave the row's own `diff material-hu` chip pointing at
  // a repo the card never names.
  assert.equal(processRepoLabel([{ repo: 'humand-web' }, { repo: 'material-hu' }],
                                [{ repo: 'humand-web', number: 9884 }]),
               'humand-web #9884 · material-hu');
});

test('processRepoLabel lists two PRs in the same repo under one entry', () => {
  assert.equal(processRepoLabel([], [{ repo: 'pr-queue', number: 12 },
                                     { repo: 'pr-queue', number: 14 }]),
               'pr-queue #12 #14');
});

test('processRepoLabel dedupes repeated worktree repos', () => {
  assert.equal(processRepoLabel([{ repo: 'humand-web' }, { repo: 'humand-web' }], []),
               'humand-web');
});

test('processRepoLabel skips a PR missing repo or a numeric number', () => {
  assert.equal(processRepoLabel([], [{ number: 9884 }, { repo: 'x', number: '12' }]), 'x');
  assert.equal(processRepoLabel([], []), '');
  assert.equal(processRepoLabel(null, null), '');
});

test('worktree order comes first, then PR-only repos', () => {
  assert.equal(processRepoLabel([{ repo: 'zzz' }], [{ repo: 'aaa', number: 1 }]),
               'zzz · aaa #1');
});
