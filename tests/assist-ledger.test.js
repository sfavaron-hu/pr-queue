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
