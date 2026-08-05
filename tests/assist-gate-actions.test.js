const { test } = require('node:test');
const assert = require('node:assert');
const { buildActions } = require('../assist/gate.js');

const wt = (over) => Object.assign(
  { repo: 'humand-web', path: '/w/humand-web', branch: 'feat/SQSH-1', detached: false,
    prunable: false, dirty: 0, unpushed: 0, onOrigin: true,
    githubRepo: 'HumandDev/humand-web', baseBranch: 'develop' }, over);

const ledger = (processes) => ({ workspaceRoot: '/w', processes });
const proc = (over) => Object.assign({ key: 'SQSH-1', worktrees: [], prs: [] }, over);

const kinds = (acts) => acts.map(a => a.kind).sort();

test('push fires for a branch absent from origin and not consumed', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ onOrigin: false })], prs: [] })]));
  assert.deepEqual(kinds(acts), ['push']);
  assert.match(acts[0].cmd, /git -C \/w\/humand-web push -u origin feat\/SQSH-1/);
  assert.equal(acts[0].reversibility, 'reversible-unconsumed');
  assert.deepEqual(acts[0].argv, ['git', '-C', '/w/humand-web', 'push', '-u', 'origin', 'feat/SQSH-1']);
  assert.equal(acts[0].argv.join(' '), acts[0].cmd);
});

test('push does NOT fire when a PR references the branch (consumed)', () => {
  // A merged PR on the same headRef means the branch was consumed (squash-merge
  // deletes it from origin, flipping onOrigin back to false) — never re-push it.
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ onOrigin: false })],
    prs: [{ headRef: 'feat/SQSH-1', merged: true }] })]));
  assert.equal(acts.filter(a => a.kind === 'push').length, 0);
});

test('open-draft-pr fires for an on-origin branch with commits above base, no PR, clean', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ unpushed: 3 })], prs: [] })]));
  assert.deepEqual(kinds(acts), ['open-draft-pr']);
  assert.match(acts[0].cmd, /gh pr create --draft --fill -R HumandDev\/humand-web --head feat\/SQSH-1 --base develop/);
  assert.deepEqual(acts[0].argv,
    ['gh', 'pr', 'create', '--draft', '--fill', '-R', 'HumandDev/humand-web', '--head', 'feat/SQSH-1', '--base', 'develop']);
  assert.equal(acts[0].argv.join(' '), acts[0].cmd);
  // Semantic fields so /work-assistant can open a well-formatted PR without re-parsing argv.
  assert.equal(acts[0].githubRepo, 'HumandDev/humand-web');
  assert.equal(acts[0].head, 'feat/SQSH-1');
  assert.equal(acts[0].base, 'develop');
});

test('a dirty worktree suppresses open-draft-pr (no autonomous resolution)', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ unpushed: 3, dirty: 2 })], prs: [] })]));
  assert.equal(acts.filter(a => a.kind === 'open-draft-pr').length, 0);
});

test('open-draft-pr does NOT fire when the process already has a PR', () => {
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ unpushed: 3 })], prs: [{ headRef: 'feat/SQSH-1', merged: false }] })]));
  assert.equal(acts.filter(a => a.kind === 'open-draft-pr').length, 0);
});

test('open-draft-pr never fires off unpushed>0 alone when the branch is not on origin (it pushes instead)', () => {
  // The naming trap: unpushed is commits-above-base. A not-on-origin branch with
  // commits pushes; it must not try to open a PR for a branch that isn't pushed.
  const acts = buildActions(ledger([proc({ worktrees: [wt({ onOrigin: false, unpushed: 3 })], prs: [] })]));
  assert.deepEqual(kinds(acts), ['push']);
});

test('remove-merged-worktree fires when every PR is merged, the dir is present and clean', () => {
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ dirty: 0 })], prs: [{ headRef: 'feat/SQSH-1', merged: true }] })]));
  assert.equal(acts.filter(a => a.kind === 'remove-merged-worktree').length, 1);
  assert.match(acts.find(a => a.kind === 'remove-merged-worktree').cmd,
    /git -C \/w\/humand-web worktree remove \/w\/humand-web/);
});

test('remove-merged-worktree is suppressed by a dirty worktree', () => {
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ dirty: 2 })], prs: [{ headRef: 'feat/SQSH-1', merged: true }] })]));
  assert.equal(acts.filter(a => a.kind === 'remove-merged-worktree').length, 0);
});

test('prune-worktree fires for a worktree whose directory is gone', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ prunable: true })] })]));
  assert.deepEqual(kinds(acts), ['prune-worktree']);
  assert.match(acts[0].cmd, /git -C \/w\/humand-web worktree prune/);
  assert.deepEqual(acts[0].argv, ['git', '-C', '/w/humand-web', 'worktree', 'prune']);
  assert.equal(acts[0].argv.join(' '), acts[0].cmd);
});

test('a detached worktree produces no action', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ detached: true, branch: null, onOrigin: false })] })]));
  assert.deepEqual(acts, []);
});

test('action ids are stable and unique per (kind, process, repo, branch)', () => {
  const l = ledger([proc({ worktrees: [wt({ onOrigin: false })] })]);
  const a1 = buildActions(l), a2 = buildActions(l);
  assert.equal(a1[0].id, a2[0].id);
  assert.equal(a1[0].id, 'push:SQSH-1:humand-web:feat/SQSH-1');
});
