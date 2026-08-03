const { test } = require('node:test');
const assert = require('node:assert');
const { PR_FILTER_ALL, rowHasPR, nextPRFilter, filterRowsByPR } = require('../classify.js');

// A row is what attachOwnPRs/synthesizeProcesses produce: { proc, prs }.
const row = (key, prs) => ({ proc: { key: key, prs: undefined }, prs: prs });

test('PR_FILTER_ALL is the off state', () => {
  assert.equal(PR_FILTER_ALL, null);
});

test('rowHasPR is true only when the row has at least one joined PR', () => {
  assert.equal(rowHasPR(row('a', [{ number: 1 }])), true);
  assert.equal(rowHasPR(row('b', [])), false);
});

test('rowHasPR survives a row with no prs array at all', () => {
  assert.equal(rowHasPR({ proc: { key: 'a' } }), false);
  assert.equal(rowHasPR(null), false);
  assert.equal(rowHasPR(undefined), false);
});

test('a merged PR still counts as having a PR', () => {
  // A mergeado card is PR-backed — "con PR" must not silently mean "con PR
  // abierto", or merged work would show up under "sin PR".
  assert.equal(rowHasPR(row('a', [{ number: 1, merged: true }])), true);
});

test('nextPRFilter turns a chip on from the off state', () => {
  assert.equal(nextPRFilter(PR_FILTER_ALL, 'con'), 'con');
  assert.equal(nextPRFilter(PR_FILTER_ALL, 'sin'), 'sin');
});

test('nextPRFilter turns the selected chip off — back to todos', () => {
  assert.equal(nextPRFilter('con', 'con'), PR_FILTER_ALL);
  assert.equal(nextPRFilter('sin', 'sin'), PR_FILTER_ALL);
});

test('nextPRFilter switching chips turns the previous one off', () => {
  assert.equal(nextPRFilter('con', 'sin'), 'sin');
  assert.equal(nextPRFilter('sin', 'con'), 'con');
});

test('nextPRFilter ignores an unknown mode instead of clearing the selection', () => {
  assert.equal(nextPRFilter('con', 'todos'), 'con');
  assert.equal(nextPRFilter('con', null), 'con');
  assert.equal(nextPRFilter(PR_FILTER_ALL, undefined), PR_FILTER_ALL);
});

const rows = [
  row('SQSH-1', [{ number: 1 }]),
  row('chore/no-ticket', []),
  row('SQSH-2', [{ number: 2, merged: true }]),
  row('fix/local-only', []),
];

test('filterRowsByPR keeps only PR-backed rows for "con"', () => {
  assert.deepEqual(filterRowsByPR(rows, 'con').map(r => r.proc.key), ['SQSH-1', 'SQSH-2']);
});

test('filterRowsByPR keeps only local-only rows for "sin"', () => {
  assert.deepEqual(filterRowsByPR(rows, 'sin').map(r => r.proc.key),
                   ['chore/no-ticket', 'fix/local-only']);
});

test('filterRowsByPR with no chip selected returns every row', () => {
  assert.equal(filterRowsByPR(rows, PR_FILTER_ALL).length, 4);
  assert.equal(filterRowsByPR(rows, undefined).length, 4);
  assert.equal(filterRowsByPR(rows, 'todos').length, 4);
});

test('filterRowsByPR preserves the incoming order', () => {
  // The list arrives already sorted by state, then newest first — filtering
  // must not reshuffle it.
  const out = filterRowsByPR(rows, PR_FILTER_ALL).map(r => r.proc.key);
  assert.deepEqual(out, ['SQSH-1', 'chore/no-ticket', 'SQSH-2', 'fix/local-only']);
});

test('filterRowsByPR never returns the caller array', () => {
  const out = filterRowsByPR(rows, PR_FILTER_ALL);
  assert.notEqual(out, rows);
  out.push(row('extra', []));
  assert.equal(rows.length, 4);
});

test('filterRowsByPR tolerates a missing rows list', () => {
  assert.deepEqual(filterRowsByPR(null, 'con'), []);
  assert.deepEqual(filterRowsByPR(undefined, PR_FILTER_ALL), []);
});

test('the two chips partition the list — no row is lost or double-counted', () => {
  const con = filterRowsByPR(rows, 'con');
  const sin = filterRowsByPR(rows, 'sin');
  assert.equal(con.length + sin.length, rows.length);
  assert.equal(con.filter(r => sin.includes(r)).length, 0);
});
