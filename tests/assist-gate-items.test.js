const { test } = require('node:test');
const assert = require('node:assert');
const { buildItems, questionFor } = require('../assist/gate.js');

const flags = (over) => Object.assign(
  { notOnOrigin: false, dirty: false, prunable: false, cold: false, noTicket: false,
    sessionIdle: false, hasOpenPR: false, hasDraftPR: false, hasMergedPR: false,
    mergedWithLiveWorktree: false }, over);
const wt = (over) => Object.assign({ repo: 'r', branch: 'feat/x', unpushed: 0, onOrigin: true, dirty: 0 }, over);
const proc = (over) => Object.assign(
  { key: 'SQSH-1', ticket: 'SQSH-1', worktrees: [], prs: [], lastLocalActivity: 0, flags: flags() }, over);
const ledger = (processes) => ({ processes, workspaceRoot: '/w' });

const renderable = (q) => {
  assert.ok(q.options.length >= 2 && q.options.length <= 4, 'options 2..4');
  q.options.forEach(o => { assert.ok(o.label && o.description, 'label+description'); });
  assert.ok(q.header.length <= 12, `header <=12: "${q.header}"`);
  assert.ok(/\?$/.test(q.question), 'ends with ?');
};

test('a dirty worktree produces a renderable question, not an action', () => {
  const q = questionFor(proc({ worktrees: [wt({ dirty: 3 })], flags: flags({ dirty: true }) }), ledger([]));
  assert.equal(q.type, 'question');
  renderable(q);
  assert.match(q.question, /sin commitear/);
});

test('a cold process produces the worked-example question', () => {
  const q = questionFor(proc({
    key: 'fix/no-ticket-tiptap-v3', ticket: null,
    worktrees: [wt({ branch: 'fix/no-ticket-tiptap-v3', unpushed: 9 })],
    flags: flags({ cold: true }) }), ledger([]));
  renderable(q);
  assert.equal(q.header, 'Frío');
  assert.match(q.options.map(o => o.label).join(','), /Retomar/);
  assert.match(q.options.find(o => o.label === 'Retomar').description, /9 commits/);
});

test('dirty takes priority over cold', () => {
  const q = questionFor(proc({ worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true, cold: true }) }), ledger([]));
  assert.match(q.question, /sin commitear/);
});

test('a process needing no decision yields no question', () => {
  assert.equal(questionFor(proc({ flags: flags() }), ledger([])), null);
});

test('the question budget caps at 4, dropping the lowest-unblock questions', () => {
  const procs = [];
  for (let i = 0; i < 6; i++) {
    procs.push(proc({ key: 'p' + i, worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: i }));
  }
  const { questions } = buildItems(ledger(procs), [], []);
  assert.equal(questions.length, 4);
});

test('questions order by unblock score, then recency', () => {
  const procs = [
    proc({ key: 'low',  worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: 100 }),
    proc({ key: 'high', worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: 1 }),
  ];
  // 'high' has 2 actions on it, 'low' has 0 → 'high' first despite older recency
  const actions = [{ processKey: 'high' }, { processKey: 'high' }];
  const { questions } = buildItems(ledger(procs), actions, []);
  assert.equal(questions[0].processKey, 'high');
});

test('every emitted question is AskUserQuestion-renderable', () => {
  const procs = [
    proc({ key: 'd', worktrees: [wt({ dirty: 2 })], flags: flags({ dirty: true }) }),
    proc({ key: 'c', ticket: null, worktrees: [wt({ unpushed: 4 })], flags: flags({ cold: true }) }),
  ];
  const { questions } = buildItems(ledger(procs), [], []);
  assert.equal(questions.length, 2);
  questions.forEach(renderable);
});

test('notify items pass through untouched and unbudgeted', () => {
  const notify = [{ type: 'notify', key: 'babysit:comments', message: 'x', source: 'pr-babysit' }];
  const { notify: out } = buildItems(ledger([]), [], notify);
  assert.deepEqual(out, notify);
});
