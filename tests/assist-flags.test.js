const { test } = require('node:test');
const assert = require('node:assert');
const { deriveFlags } = require('../assist/flags.js');

const wt = (over) => Object.assign(
  { repo: 'r', path: '/w/r', branch: 'feat/x', detached: false, prunable: false,
    dirty: 0, unpushed: 0, onOrigin: true }, over);

test('notOnOrigin is true only for a real branch worktree confirmed absent from origin', () => {
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false })], sessions: [] }, [], 'pausa').notOnOrigin, true);
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: true })], sessions: [] }, [], 'pausa').notOnOrigin, false);
  // detached / prunable carry onOrigin:false for other reasons — never notOnOrigin
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false, detached: true })], sessions: [] }, [], 'pausa').notOnOrigin, false);
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false, prunable: true })], sessions: [] }, [], 'pausa').notOnOrigin, false);
});

test('dirty, prunable, sessionIdle, noTicket', () => {
  const f = deriveFlags(
    { ticket: null, worktrees: [wt({ dirty: 3 }), wt({ prunable: true })],
      sessions: [{ status: 'idle' }, { status: 'busy' }] }, [], 'pausa');
  assert.equal(f.dirty, true);
  assert.equal(f.prunable, true);
  assert.equal(f.sessionIdle, true);
  assert.equal(f.noTicket, true);
});

test('cold mirrors the frio state', () => {
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [], 'frio').cold, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [], 'pausa').cold, false);
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

test('mergedWithLiveWorktree needs the mergeado state AND a present worktree', () => {
  const wts = [wt({ prunable: false, path: '/w/r' })];
  assert.equal(deriveFlags({ worktrees: wts, sessions: [] }, [{ merged: true }], 'mergeado').mergedWithLiveWorktree, true);
  // prunable directory is gone → not "live"
  assert.equal(deriveFlags({ worktrees: [wt({ prunable: true })], sessions: [] }, [{ merged: true }], 'mergeado').mergedWithLiveWorktree, false);
  // not mergeado → false regardless
  assert.equal(deriveFlags({ worktrees: wts, sessions: [] }, [], 'pausa').mergedWithLiveWorktree, false);
});

test('deriveFlags tolerates a synthetic process (no worktrees, no sessions)', () => {
  const f = deriveFlags({ ticket: 'SQSH-1', worktrees: [], sessions: [] }, [{ merged: false, draft: false }], 'esperando');
  assert.equal(f.notOnOrigin, false);
  assert.equal(f.dirty, false);
  assert.equal(f.hasOpenPR, true);
  assert.equal(f.noTicket, false);
});
