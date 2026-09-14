const { test } = require('node:test');
const assert = require('node:assert');
const { lastActivity, classify, sortProcesses } = require('../classify.js');

const NOW = 1785000000000;
const DAY = 86400000;

function proc(over) {
  return Object.assign({ key: 'SQSH-1', ticket: 'SQSH-1', branches: ['feat/SQSH-1-x'],
                         worktrees: [], sessions: [], lastLocalActivity: null }, over);
}
function pr(over) {
  return Object.assign({ draft: false, ci: 'green', conflicts: false, approved: false,
                         changesReq: false, newComments: 0, newApprovals: 0, newChanges: 0,
                         updatedAt: NOW - 30 * DAY, headRef: 'feat/SQSH-1-x',
                         humanReviews: 0 }, over);
}

test('lastActivity takes the max across local activity and PR updates', () => {
  assert.equal(lastActivity(proc({ lastLocalActivity: 1000 }), [pr({ updatedAt: 5000 })]), 5000);
  assert.equal(lastActivity(proc({ lastLocalActivity: 9000 }), [pr({ updatedAt: 5000 })]), 9000);
});

test('lastActivity accepts Date objects for PR updatedAt', () => {
  assert.equal(lastActivity(proc({ lastLocalActivity: 1000 }), [pr({ updatedAt: new Date(7000) })]), 7000);
});

test('lastActivity tolerates missing pieces', () => {
  assert.equal(lastActivity(proc({ lastLocalActivity: null }), []), null);
  assert.equal(lastActivity(proc({ lastLocalActivity: 4000 }), []), 4000);
  assert.equal(lastActivity(proc({ lastLocalActivity: null }), [pr({ updatedAt: 4000 })]), 4000);
});

test('changes requested is your move', () => {
  assert.equal(classify(proc(), [pr({ changesReq: true })], NOW), 'move');
});

test('unseen comments are your move', () => {
  assert.equal(classify(proc(), [pr({ newComments: 2 })], NOW), 'move');
});

test('unseen change requests are your move', () => {
  assert.equal(classify(proc(), [pr({ newChanges: 1 })], NOW), 'move');
});

test('failed CI is your move', () => {
  assert.equal(classify(proc(), [pr({ ci: 'failed' })], NOW), 'move');
});

test('conflicts are your move', () => {
  assert.equal(classify(proc(), [pr({ conflicts: true })], NOW), 'move');
});

// Recency is not a demand. A worktree you were in this morning with nothing
// waiting on you is `active`, and keeping it out of `move` is what leaves the
// red badge meaning "act now" on a machine carrying dozens of worktrees.
test('own activity within 48h is active, not your move', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - DAY }), [], NOW), 'active');
});

test('an open PR with no human review yet is in review', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ humanReviews: 0 })], NOW), 'review');
});

test('pending CI is its own state, not a review wait', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ ci: 'pending', humanReviews: 1 })], NOW), 'ci');
});

// The nearest gate wins: until CI answers, the review is not the thing holding
// the PR up.
test('CI running beats in review when a PR is both', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ ci: 'pending', humanReviews: 0 })], NOW), 'ci');
});

// Nobody is expected to review a draft, so an unreviewed one is not waiting on
// a person — it falls through to the local-activity states like any other
// unfinished work.
test('a draft PR with no reviews is not in review', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ draft: true, humanReviews: 0, updatedAt: NOW - 5 * DAY })], NOW), 'paused');
});

test('a draft PR whose CI is running still says so — the machine is a real gate', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ draft: true, ci: 'pending', humanReviews: 0 })], NOW), 'ci');
});

test('in review beats cold — a 30 day old unreviewed PR is still in review', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 30 * DAY }),
    [pr({ updatedAt: NOW - 30 * DAY, humanReviews: 0 })], NOW), 'review');
});

test('13 days with no PR is paused, not in review — nobody is blocking it', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 13 * DAY }), [], NOW), 'paused');
});

test('3 days with no PR is paused', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 3 * DAY }), [], NOW), 'paused');
});

test('an approved PR with reviews, touched 3 days ago, is paused not in review', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 3 * DAY }),
    [pr({ approved: true, humanReviews: 1, updatedAt: NOW - 3 * DAY })], NOW), 'paused');
});

test('15 days with no PR is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 15 * DAY }), [], NOW), 'cold');
});

test('an approved and reviewed PR untouched for 15 days is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 15 * DAY }),
    [pr({ approved: true, humanReviews: 1, updatedAt: NOW - 15 * DAY })], NOW), 'cold');
});

test('a process with no PR and no known activity is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: null }), [], NOW), 'cold');
});

test('a merged PR, no open PR, no recent local activity is merged', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ merged: true })], NOW), 'merged');
});

test('a merged PR with humanReviews: 0 is merged, not in review — ordering pin', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ merged: true, humanReviews: 0 })], NOW), 'merged');
});

// The card of a merged process offers to remove the worktree it left behind.
// Letting local recency win would hide that behind "you were here yesterday",
// which is the one thing the row is for.
test('a merged PR beats own activity within 48h', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - DAY }),
    [pr({ merged: true })], NOW), 'merged');
});

test('a merged PR plus an open PR on the same process: the open PR decides, not merged', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ merged: true }), pr({ humanReviews: 0 })], NOW), 'review');
});

test('sortProcesses places merged after cold, newest first within it', () => {
  const rows = [
    { proc: proc({ key: 'merged-old', lastLocalActivity: NOW - 10 * DAY }),
      prs: [pr({ merged: true, updatedAt: NOW - 10 * DAY })] },
    { proc: proc({ key: 'cold', lastLocalActivity: NOW - 20 * DAY }), prs: [] },
    { proc: proc({ key: 'merged-new', lastLocalActivity: NOW - 3 * DAY }),
      prs: [pr({ merged: true, updatedAt: NOW - 3 * DAY })] },
  ];
  const keys = sortProcesses(rows, NOW).map(r => r.proc.key);
  assert.deepEqual(keys, ['cold', 'merged-new', 'merged-old']);
});

test('sortProcesses orders move, active, review, ci, paused, cold — newest first inside each', () => {
  const rows = [
    { proc: proc({ key: 'cold-new', lastLocalActivity: NOW - 15 * DAY }), prs: [] },
    { proc: proc({ key: 'wait-new', lastLocalActivity: NOW - 3 * DAY }),
      prs: [pr({ updatedAt: NOW - 3 * DAY, humanReviews: 0 })] },
    { proc: proc({ key: 'cold-old', lastLocalActivity: NOW - 40 * DAY }), prs: [] },
    { proc: proc({ key: 'paused', lastLocalActivity: NOW - 5 * DAY }), prs: [] },
    { proc: proc({ key: 'wait-old', lastLocalActivity: NOW - 20 * DAY }),
      prs: [pr({ updatedAt: NOW - 20 * DAY, humanReviews: 0 })] },
    { proc: proc({ key: 'mine', lastLocalActivity: NOW - DAY }), prs: [] },
  ];
  const keys = sortProcesses(rows, NOW).map(r => r.proc.key);
  assert.deepEqual(keys,
    ['mine', 'wait-new', 'wait-old', 'paused', 'cold-new', 'cold-old']);
});

test('sortProcesses maintains stable order for rows with no lastActivity in same state', () => {
  // Multiple processes with lastActivity === null must be sorted stably
  // (they keep their input relative order since the comparator returns 0).
  // This pins the fix: if (la === null && lb === null) return 0
  const rows = [
    { proc: proc({ key: 'null-first', lastLocalActivity: null }), prs: [] },
    { proc: proc({ key: 'has-activity', lastLocalActivity: NOW - 30 * DAY }), prs: [] },
    { proc: proc({ key: 'null-second', lastLocalActivity: null }), prs: [] },
    { proc: proc({ key: 'null-third', lastLocalActivity: null }), prs: [] },
  ];
  // All are 'cold' (no activity, no PRs).
  // Rows with activity sort before nulls (newest first among those with timestamps).
  // Null-activity rows maintain their input relative order and sort last.
  const sorted = sortProcesses(rows, NOW);
  const keys = sorted.map(r => r.proc.key);
  assert.deepEqual(keys,
    ['has-activity', 'null-first', 'null-second', 'null-third'],
    'rows with no activity maintain input order; rows with activity sort first');
});

// A closed-unmerged PR is "not open" exactly like a merged one: a process
// holding only that PR must not read as "someone owes you a review" on a PR
// nobody will reopen.
test('a process whose only PR was closed unmerged is cold, not in review', () => {
  const closedPR = { owner: 'o', repo: 'r', number: 6, headRef: 'feat/dropped',
    draft: true, merged: false, closed: true, ci: 'unknown', humanReviews: 0 };
  const proc = { key: 'feat/dropped', ticket: null, branches: ['feat/dropped'],
                 worktrees: [{ repo: 'r', branch: 'feat/dropped' }], sessions: [],
                 lastLocalActivity: null };
  assert.equal(classify(proc, [closedPR], 2000), 'cold');
});

test('a merged PR alongside a closed one still classifies merged', () => {
  const closedPR = { merged: false, closed: true, humanReviews: 0 };
  const mergedPR = { merged: true, closed: false, humanReviews: 0 };
  const proc = { key: 'k', ticket: null, branches: ['b'], worktrees: [], sessions: [],
                 lastLocalActivity: null };
  assert.equal(classify(proc, [closedPR, mergedPR], 2000), 'merged');
});

// The regression guard for producers that never fetch closed PRs (github.js):
// `closed` absent must behave exactly as before.
test('a PR with no closed field is still treated as open', () => {
  const openPR = { merged: false, ci: 'pending', humanReviews: 0 };
  const proc = { key: 'k', ticket: null, branches: ['b'], worktrees: [], sessions: [],
                 lastLocalActivity: null };
  assert.equal(classify(proc, [openPR], 2000), 'ci');
});
