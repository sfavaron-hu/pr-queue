const { test } = require('node:test');
const assert = require('node:assert');
const { prTicket, attachOwnPRs, synthesizeProcesses, PR_CONTRACT_FIELDS } = require('../classify.js');

const proc = (key, ticket, branches) => ({
  key, ticket: ticket || null, branches: branches || [],
  worktrees: [], sessions: [], lastLocalActivity: null,
});

test('prTicket reads the ticket from headRef, else from title', () => {
  assert.equal(prTicket({ headRef: 'feat/SQSH-3954-web' }), 'SQSH-3954');
  assert.equal(prTicket({ title: 'SQSH-3851 | algo' }), 'SQSH-3851');
  assert.equal(prTicket({ headRef: 'chore/no-ticket' }), null);
  assert.equal(prTicket({}), null);
});

test('attachOwnPRs prefers an exact headRef match over a ticket match', () => {
  const processes = [proc('SQSH-3954', 'SQSH-3954', ['feat/SQSH-3954-web']),
                     proc('other', null, ['feat/other'])];
  const pr = { headRef: 'feat/SQSH-3954-web', title: 'x' };
  const { rows, unmatched } = attachOwnPRs(processes, [pr]);
  assert.equal(rows[0].prs.length, 1);
  assert.equal(unmatched.length, 0);
});

test('attachOwnPRs falls back to a ticket match when no branch matches', () => {
  const processes = [proc('SQSH-3954', 'SQSH-3954', ['feat/SQSH-3954-web'])];
  const pr = { headRef: 'feat/SQSH-3954-copy', title: 'x' };  // different branch, same ticket
  const { rows, unmatched } = attachOwnPRs(processes, [pr]);
  assert.equal(rows[0].prs.length, 1);
  assert.equal(unmatched.length, 0);
});

test('attachOwnPRs leaves a PR matching nothing in unmatched', () => {
  const processes = [proc('SQSH-1', 'SQSH-1', ['feat/SQSH-1'])];
  const pr = { headRef: 'feat/SQSH-9', title: 'x' };
  const { unmatched } = attachOwnPRs(processes, [pr]);
  assert.equal(unmatched.length, 1);
});

test('synthesizeProcesses makes one process per ticket, sharing PRs on the same key', () => {
  const prs = [
    { headRef: 'feat/SQSH-9-web', title: 'a', owner: 'o', repo: 'r', number: 1 },
    { headRef: 'feat/SQSH-9-copy', title: 'b', owner: 'o', repo: 'r', number: 2 },
    { headRef: 'chore/loose', title: 'c', owner: 'o', repo: 'r', number: 3 },
  ];
  const out = synthesizeProcesses(prs);
  const byKey = Object.fromEntries(out.map(r => [r.proc.key, r]));
  assert.equal(byKey['SQSH-9'].prs.length, 2);
  assert.equal(byKey['SQSH-9'].proc.synthetic, true);
  assert.equal(byKey['chore/loose'].prs.length, 1);
});

test('synthesizeProcesses keys a ticketless merged PR by owner/repo#number, not headRef', () => {
  const prs = [{ title: 'merged', owner: 'o', repo: 'r', number: 42, merged: true }];  // no headRef
  const out = synthesizeProcesses(prs);
  assert.equal(out.length, 1);
  assert.equal(out[0].proc.key, 'o/r#42');
});

test('PR_CONTRACT_FIELDS is exactly the documented field set', () => {
  assert.deepEqual([...PR_CONTRACT_FIELDS].sort(), [
    'approved', 'changesReq', 'ci', 'conflicts', 'draft', 'headRef',
    'humanReviews', 'merged', 'newComments', 'number', 'owner', 'repo',
    'title', 'updatedAt', 'url',
  ]);
});

test('the join works with a PR carrying ONLY the contract fields', () => {
  // Proves attachOwnPRs/synthesizeProcesses never read a field outside the
  // contract — the real protection behind assist/prs.js emitting just those.
  const onlyContract = {};
  for (const f of PR_CONTRACT_FIELDS) onlyContract[f] = f === 'headRef' ? 'feat/SQSH-7' : null;
  onlyContract.headRef = 'feat/SQSH-7'; onlyContract.title = 'x';
  onlyContract.owner = 'o'; onlyContract.repo = 'r'; onlyContract.number = 1;
  const processes = [proc('SQSH-7', 'SQSH-7', ['feat/SQSH-7'])];
  const { rows, unmatched } = attachOwnPRs(processes, [onlyContract]);
  assert.equal(rows[0].prs.length, 1);
  assert.equal(unmatched.length, 0);
  // and a synthetic path over the same shape
  const syn = synthesizeProcesses([{ ...onlyContract, headRef: 'feat/SQSH-8' }]);
  assert.equal(syn.length, 1);
});
