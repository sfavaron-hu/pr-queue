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

test('changes requested is your turn', () => {
  assert.equal(classify(proc(), [pr({ changesReq: true })], NOW), 'turno');
});

test('unseen comments are your turn', () => {
  assert.equal(classify(proc(), [pr({ newComments: 2 })], NOW), 'turno');
});

test('unseen change requests are your turn', () => {
  assert.equal(classify(proc(), [pr({ newChanges: 1 })], NOW), 'turno');
});

test('failed CI is your turn', () => {
  assert.equal(classify(proc(), [pr({ ci: 'failed' })], NOW), 'turno');
});

test('conflicts are your turn', () => {
  assert.equal(classify(proc(), [pr({ conflicts: true })], NOW), 'turno');
});

test('own activity within 48h is your turn', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - DAY }), [], NOW), 'turno');
});

test('an open PR with no human review yet is waiting on someone else', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ humanReviews: 0 })], NOW), 'esperando');
});

test('pending CI is waiting on someone else', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ ci: 'pending', humanReviews: 1 })], NOW), 'esperando');
});

test('waiting beats cold — a 30 day old unreviewed PR is still esperando', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 30 * DAY }),
    [pr({ updatedAt: NOW - 30 * DAY, humanReviews: 0 })], NOW), 'esperando');
});

test('13 days with no PR is en pausa, not esperando — nobody is blocking it', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 13 * DAY }), [], NOW), 'pausa');
});

test('3 days with no PR is en pausa', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 3 * DAY }), [], NOW), 'pausa');
});

test('an approved PR with reviews, touched 3 days ago, is en pausa not esperando', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 3 * DAY }),
    [pr({ approved: true, humanReviews: 1, updatedAt: NOW - 3 * DAY })], NOW), 'pausa');
});

test('15 days with no PR is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 15 * DAY }), [], NOW), 'frio');
});

test('an approved and reviewed PR untouched for 15 days is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 15 * DAY }),
    [pr({ approved: true, humanReviews: 1, updatedAt: NOW - 15 * DAY })], NOW), 'frio');
});

test('a process with no PR and no known activity is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: null }), [], NOW), 'frio');
});

test('a merged PR, no open PR, no recent local activity is mergeado', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ merged: true })], NOW), 'mergeado');
});

test('a merged PR with humanReviews: 0 is mergeado, not esperando — ordering pin', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ merged: true, humanReviews: 0 })], NOW), 'mergeado');
});

test('a merged PR plus own activity within 48h is still turno', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - DAY }),
    [pr({ merged: true })], NOW), 'turno');
});

test('a merged PR plus an open PR on the same process: the open PR decides, not mergeado', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ merged: true }), pr({ humanReviews: 0 })], NOW), 'esperando');
});

test('sortProcesses places mergeado after frio, newest first within it', () => {
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

test('sortProcesses orders turno, esperando, pausa, frio — newest first inside each', () => {
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
  // All are 'frio' (no activity, no PRs).
  // Rows with activity sort before nulls (newest first among those with timestamps).
  // Null-activity rows maintain their input relative order and sort last.
  const sorted = sortProcesses(rows, NOW);
  const keys = sorted.map(r => r.proc.key);
  assert.deepEqual(keys,
    ['has-activity', 'null-first', 'null-second', 'null-third'],
    'rows with no activity maintain input order; rows with activity sort first');
});

// A closed-unmerged PR is "not open" exactly like a merged one. Before `closed`
// existed, every check spelled that `merged !== true`, so a PR you deliberately
// closed read as open — and a process holding only that PR classified
// 'esperando', i.e. "someone owes you a review" on a PR nobody will reopen.
test('a process whose only PR was closed unmerged is frio, not esperando', () => {
  const closedPR = { owner: 'o', repo: 'r', number: 6, headRef: 'feat/dropped',
    draft: true, merged: false, closed: true, ci: 'unknown', humanReviews: 0 };
  const proc = { key: 'feat/dropped', ticket: null, branches: ['feat/dropped'],
                 worktrees: [{ repo: 'r', branch: 'feat/dropped' }], sessions: [],
                 lastLocalActivity: null };
  assert.equal(classify(proc, [closedPR], 2000), 'frio');
});

test('a merged PR alongside a closed one still classifies mergeado', () => {
  const closedPR = { merged: false, closed: true, humanReviews: 0 };
  const mergedPR = { merged: true, closed: false, humanReviews: 0 };
  const proc = { key: 'k', ticket: null, branches: ['b'], worktrees: [], sessions: [],
                 lastLocalActivity: null };
  assert.equal(classify(proc, [closedPR, mergedPR], 2000), 'mergeado');
});

// The regression guard for producers that never fetch closed PRs (github.js):
// `closed` absent must behave exactly as before.
test('a PR with no closed field is still treated as open', () => {
  const openPR = { merged: false, ci: 'pending', humanReviews: 0 };
  const proc = { key: 'k', ticket: null, branches: ['b'], worktrees: [], sessions: [],
                 lastLocalActivity: null };
  assert.equal(classify(proc, [openPR], 2000), 'esperando');
});
