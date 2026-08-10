const { test } = require('node:test');
const assert = require('node:assert');
const { PR_FILTER_ALL, rowHasPR, rowHasOpenPR, rowHasDraftPR, nextChipFilter,
        filterRowsByPR, filterRowsByPRStatus } = require('../classify.js');

const MODES = ['con', 'sin'];
const STATUS = ['abierto', 'draft'];

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

test('nextChipFilter turns a chip on from the off state', () => {
  assert.equal(nextChipFilter(PR_FILTER_ALL, 'con', MODES), 'con');
  assert.equal(nextChipFilter(PR_FILTER_ALL, 'sin', MODES), 'sin');
});

test('nextChipFilter turns the selected chip off — back to todos', () => {
  assert.equal(nextChipFilter('con', 'con', MODES), PR_FILTER_ALL);
  assert.equal(nextChipFilter('sin', 'sin', MODES), PR_FILTER_ALL);
});

test('nextChipFilter switching chips turns the previous one off', () => {
  assert.equal(nextChipFilter('con', 'sin', MODES), 'sin');
  assert.equal(nextChipFilter('sin', 'con', MODES), 'con');
});

test('nextChipFilter ignores an unknown mode instead of clearing the selection', () => {
  assert.equal(nextChipFilter('con', 'todos', MODES), 'con');
  assert.equal(nextChipFilter('con', null, MODES), 'con');
  assert.equal(nextChipFilter(PR_FILTER_ALL, undefined, MODES), PR_FILTER_ALL);
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

// ── second row: abierto / draft ──

test('rowHasOpenPR is true for an open PR that is not a draft', () => {
  assert.equal(rowHasOpenPR(row('a', [{ number: 1 }])), true);
  assert.equal(rowHasOpenPR(row('b', [{ number: 1, draft: false }])), true);
});

test('rowHasOpenPR is false for a draft-only or merged-only row', () => {
  assert.equal(rowHasOpenPR(row('a', [{ number: 1, draft: true }])), false);
  assert.equal(rowHasOpenPR(row('b', [{ number: 1, merged: true }])), false);
  assert.equal(rowHasOpenPR(row('c', [])), false);
  assert.equal(rowHasOpenPR(null), false);
});

test('rowHasDraftPR is true only for a draft that is still open', () => {
  assert.equal(rowHasDraftPR(row('a', [{ number: 1, draft: true }])), true);
  assert.equal(rowHasDraftPR(row('b', [{ number: 1 }])), false);
  // Nothing produces this pair, but a merged PR must never read as a draft.
  assert.equal(rowHasDraftPR(row('c', [{ number: 1, draft: true, merged: true }])), false);
  assert.equal(rowHasDraftPR(null), false);
});

test('a multi-repo row with a draft and a ready PR is both', () => {
  // Same `some` semantics procCardHTML uses for its Draft badge: the process
  // genuinely has both, so it shows up under either chip instead of being
  // forced into one.
  const r = row('SQSH-9', [{ number: 1, draft: true }, { number: 2 }]);
  assert.equal(rowHasOpenPR(r), true);
  assert.equal(rowHasDraftPR(r), true);
});

const prRows = [
  row('SQSH-1', [{ number: 1 }]),                                // abierto
  row('SQSH-2', [{ number: 2, draft: true }]),                    // draft
  row('SQSH-3', [{ number: 3, merged: true }]),                   // mergeado
  row('SQSH-4', [{ number: 4, draft: true }, { number: 5 }]),     // ambos
];

test('filterRowsByPRStatus keeps rows with a ready PR for "abierto"', () => {
  assert.deepEqual(filterRowsByPRStatus(prRows, 'abierto').map(r => r.proc.key),
                   ['SQSH-1', 'SQSH-4']);
});

test('filterRowsByPRStatus keeps rows with a draft for "draft"', () => {
  assert.deepEqual(filterRowsByPRStatus(prRows, 'draft').map(r => r.proc.key),
                   ['SQSH-2', 'SQSH-4']);
});

test('a mergeado row is neither abierto nor draft', () => {
  // Which is why the two counts can sum to less than the "con PR" total —
  // documented behaviour, not a lost row.
  assert.equal(filterRowsByPRStatus(prRows, 'abierto').some(r => r.proc.key === 'SQSH-3'), false);
  assert.equal(filterRowsByPRStatus(prRows, 'draft').some(r => r.proc.key === 'SQSH-3'), false);
});

test('filterRowsByPRStatus with no chip selected returns every row', () => {
  assert.equal(filterRowsByPRStatus(prRows, PR_FILTER_ALL).length, 4);
  assert.equal(filterRowsByPRStatus(prRows, 'cualquiera').length, 4);
  assert.notEqual(filterRowsByPRStatus(prRows, PR_FILTER_ALL), prRows);
  assert.deepEqual(filterRowsByPRStatus(null, 'draft'), []);
});

test('nextChipFilter drives the second row with the same semantics', () => {
  assert.equal(nextChipFilter(PR_FILTER_ALL, 'draft', STATUS), 'draft');
  assert.equal(nextChipFilter('draft', 'abierto', STATUS), 'abierto');
  assert.equal(nextChipFilter('abierto', 'abierto', STATUS), PR_FILTER_ALL);
  // The rows can't leak into each other: a first-row mode is unknown here.
  assert.equal(nextChipFilter('draft', 'con', STATUS), 'draft');
  assert.equal(nextChipFilter('con', 'draft', MODES), 'con');
});
