const { test } = require('node:test');
const assert = require('node:assert');
const { PR_FILTER_ALL, rowHasPR, rowHasOpenPR, rowHasDraftPR, nextChipFilter,
        filterRowsByPR, filterRowsByPRStatus } = require('../classify.js');

const MODES = ['with', 'without'];
const STATUS = ['open', 'draft'];

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
  // A merged card is PR-backed — "with PR" must not silently mean "with PR
  // open", or merged work would show up under "without PR".
  assert.equal(rowHasPR(row('a', [{ number: 1, merged: true }])), true);
});

test('nextChipFilter turns a chip on from the off state', () => {
  assert.equal(nextChipFilter(PR_FILTER_ALL, 'with', MODES), 'with');
  assert.equal(nextChipFilter(PR_FILTER_ALL, 'without', MODES), 'without');
});

test('nextChipFilter turns the selected chip off — back to todos', () => {
  assert.equal(nextChipFilter('with', 'with', MODES), PR_FILTER_ALL);
  assert.equal(nextChipFilter('without', 'without', MODES), PR_FILTER_ALL);
});

test('nextChipFilter switching chips turns the previous one off', () => {
  assert.equal(nextChipFilter('with', 'without', MODES), 'without');
  assert.equal(nextChipFilter('without', 'with', MODES), 'with');
});

test('nextChipFilter ignores an unknown mode instead of clearing the selection', () => {
  assert.equal(nextChipFilter('with', 'todos', MODES), 'with');
  assert.equal(nextChipFilter('with', null, MODES), 'with');
  assert.equal(nextChipFilter(PR_FILTER_ALL, undefined, MODES), PR_FILTER_ALL);
});

const rows = [
  row('SQSH-1', [{ number: 1 }]),
  row('chore/no-ticket', []),
  row('SQSH-2', [{ number: 2, merged: true }]),
  row('fix/local-only', []),
];

test('filterRowsByPR keeps only PR-backed rows for "con"', () => {
  assert.deepEqual(filterRowsByPR(rows, 'with').map(r => r.proc.key), ['SQSH-1', 'SQSH-2']);
});

test('filterRowsByPR keeps only local-only rows for "sin"', () => {
  assert.deepEqual(filterRowsByPR(rows, 'without').map(r => r.proc.key),
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
  assert.deepEqual(filterRowsByPR(null, 'with'), []);
  assert.deepEqual(filterRowsByPR(undefined, PR_FILTER_ALL), []);
});

test('the two chips partition the list — no row is lost or double-counted', () => {
  const withPR = filterRowsByPR(rows, 'with');
  const withoutPR = filterRowsByPR(rows, 'without');
  assert.equal(withPR.length + withoutPR.length, rows.length);
  assert.equal(withPR.filter(r => withoutPR.includes(r)).length, 0);
});

// ── second row: open / draft ──

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
  row('SQSH-1', [{ number: 1 }]),                                // open
  row('SQSH-2', [{ number: 2, draft: true }]),                    // draft
  row('SQSH-3', [{ number: 3, merged: true }]),                   // merged
  row('SQSH-4', [{ number: 4, draft: true }, { number: 5 }]),     // ambos
];

test('filterRowsByPRStatus keeps rows with a ready PR for "open"', () => {
  assert.deepEqual(filterRowsByPRStatus(prRows, 'open').map(r => r.proc.key),
                   ['SQSH-1', 'SQSH-4']);
});

test('filterRowsByPRStatus keeps rows with a draft for "draft"', () => {
  assert.deepEqual(filterRowsByPRStatus(prRows, 'draft').map(r => r.proc.key),
                   ['SQSH-2', 'SQSH-4']);
});

test('a merged row is neither open nor draft', () => {
  // Which is why the two counts can sum to less than the "with PR" total —
  // documented behaviour, not a lost row.
  assert.equal(filterRowsByPRStatus(prRows, 'open').some(r => r.proc.key === 'SQSH-3'), false);
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
  assert.equal(nextChipFilter('draft', 'open', STATUS), 'open');
  assert.equal(nextChipFilter('open', 'open', STATUS), PR_FILTER_ALL);
  // The rows can't leak into each other: a first-row mode is unknown here.
  assert.equal(nextChipFilter('draft', 'with', STATUS), 'draft');
  assert.equal(nextChipFilter('with', 'draft', MODES), 'with');
});

// GitHub keeps `isDraft: true` on a draft that was closed. Testing only `draft`
// files abandoned drafts under the "draft" chip as if they still awaited work —
// real case: react-workflows#6.
test('a closed draft counts under neither the open nor the draft chip', () => {
  const row = { prs: [{ merged: false, closed: true, draft: true }] };
  assert.equal(rowHasOpenPR(row), false);
  assert.equal(rowHasDraftPR(row), false);
  assert.equal(rowHasPR(row), true);
});

test('a closed non-draft PR counts under neither chip either', () => {
  const row = { prs: [{ merged: false, closed: true, draft: false }] };
  assert.equal(rowHasOpenPR(row), false);
  assert.equal(rowHasDraftPR(row), false);
});
