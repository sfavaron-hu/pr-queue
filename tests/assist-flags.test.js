const { test } = require('node:test');
const assert = require('node:assert');
const { deriveFlags } = require('../assist/flags.js');

const wt = (over) => Object.assign(
  { repo: 'r', path: '/w/r', branch: 'feat/x', detached: false, prunable: false,
    dirty: 0, unpushed: 0, onOrigin: true }, over);

test('notOnOrigin is true only for a real branch worktree confirmed absent from origin', () => {
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false })], sessions: [] }, [], 'paused').notOnOrigin, true);
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: true })], sessions: [] }, [], 'paused').notOnOrigin, false);
  // detached / prunable carry onOrigin:false for other reasons — never notOnOrigin
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false, detached: true })], sessions: [] }, [], 'paused').notOnOrigin, false);
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false, prunable: true })], sessions: [] }, [], 'paused').notOnOrigin, false);
});

test('dirty, prunable, sessionIdle, noTicket', () => {
  const f = deriveFlags(
    { ticket: null, worktrees: [wt({ dirty: 3 }), wt({ prunable: true })],
      sessions: [{ status: 'idle' }, { status: 'busy' }] }, [], 'paused');
  assert.equal(f.dirty, true);
  assert.equal(f.prunable, true);
  assert.equal(f.sessionIdle, true);
  assert.equal(f.noTicket, true);
});

test('cold mirrors the cold state', () => {
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [], 'cold').cold, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [], 'paused').cold, false);
});

test('PR flags come from the joined prs', () => {
  const open = { merged: false, draft: false };
  const draft = { merged: false, draft: true };
  const merged = { merged: true };
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [open]).hasOpenPR, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [draft]).hasDraftPR, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [merged]).hasMergedPR, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [merged]).hasOpenPR, false);
});

test('mergedWithLiveWorktree needs the merged state AND a present worktree', () => {
  const wts = [wt({ prunable: false, path: '/w/r' })];
  assert.equal(deriveFlags({ worktrees: wts, sessions: [] }, [{ merged: true }], 'merged').mergedWithLiveWorktree, true);
  // prunable directory is gone → not "live"
  assert.equal(deriveFlags({ worktrees: [wt({ prunable: true })], sessions: [] }, [{ merged: true }], 'merged').mergedWithLiveWorktree, false);
  // not merged → false regardless
  assert.equal(deriveFlags({ worktrees: wts, sessions: [] }, [], 'paused').mergedWithLiveWorktree, false);
});

test('deriveFlags tolerates a synthetic process (no worktrees, no sessions)', () => {
  const f = deriveFlags({ ticket: 'SQSH-1', worktrees: [], sessions: [] }, [{ merged: false, draft: false }], 'review');
  assert.equal(f.notOnOrigin, false);
  assert.equal(f.dirty, false);
  assert.equal(f.hasOpenPR, true);
  assert.equal(f.noTicket, false);
});
