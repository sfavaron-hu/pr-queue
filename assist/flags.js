// The derived-boolean block the gate keys off. Pure: a function of a process,
// its joined PRs, and its classified state — no IO. Lives in the ledger's
// output (see assist/ledger.js) so the gate and a future UI read the same
// flags rather than each recomputing them.
const { rowHasOpenPR, rowHasDraftPR } = require('../classify.js');

function deriveFlags(proc, prs, state) {
  const wts = proc.worktrees || [];
  const list = prs || [];
  return {
    // A real branch worktree the collector confirmed is absent from origin.
    // detached/prunable carry onOrigin:false for unrelated reasons (no branch /
    // no directory) and must never count — see the panel's own noOriginWorktrees.
    notOnOrigin: wts.some(w => w.onOrigin === false && !w.detached && !w.prunable),
    dirty:       wts.some(w => (w.dirty || 0) > 0),
    prunable:    wts.some(w => w.prunable),
    cold:        state === 'frio',
    noTicket:    !proc.ticket,
    sessionIdle: (proc.sessions || []).some(s => s.status === 'idle'),
    hasOpenPR:   rowHasOpenPR({ prs: list }),
    hasDraftPR:  rowHasDraftPR({ prs: list }),
    hasMergedPR: list.some(p => p.merged === true),
    // mergeado work whose worktree is still on disk — the remove-merged-worktree
    // candidate. A prunable worktree's directory is already gone, so it isn't "live".
    mergedWithLiveWorktree: state === 'mergeado' && wts.some(w => w.path && !w.prunable),
  };
}

module.exports = { deriveFlags };
