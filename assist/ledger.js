// The joined view: local work state (collect.js) + own PR state
// (assist/prs.js), joined by the same functions the browser panel uses
// (classify.js), classified by the same classify(). One document, no browser.
const { attachOwnPRs, synthesizeProcesses, classify } = require('../classify.js');
const { deriveFlags } = require('./flags.js');

const LEDGER_VERSION = 1;

// Pure: fold PRs into processes, add synthetic processes for orphan PRs, and
// attach a `state` per process. `extraWarnings` are collector-external (e.g.
// gh failures) merged with the payload's own.
function buildLedger(localPayload, prs, now, extraWarnings) {
  const { rows, unmatched } = attachOwnPRs(localPayload.processes, prs || []);
  const synthetic = synthesizeProcesses(unmatched);
  const allRows = rows.concat(synthetic);

  const processes = allRows.map(({ proc, prs }) => {
    const state = classify(proc, prs, now);
    return Object.assign({}, proc, { prs, state, flags: deriveFlags(proc, prs, state) });
  });

  return {
    version: LEDGER_VERSION,
    generatedAt: now,
    workspaceRoot: localPayload.workspaceRoot,
    processes,
    looseSessions: localPayload.looseSessions || [],
    warnings: (localPayload.warnings || []).concat(extraWarnings || []),
  };
}

// The (githubRepo, branch) pairs whose PR state the broad search did not settle:
// a real branch worktree, already on origin, that no fetched PR points at. Those
// are exactly the branches a consumer will otherwise treat as "never had a PR" —
// so they are the ones worth a targeted lookup, and the only ones (the lookup
// costs a `gh` round-trip each).
//
// Detached and prunable worktrees are skipped: no branch to ask about, and no
// directory. A branch not yet on origin cannot have a PR, so it is skipped too —
// that is knowledge, not ignorance, and paying for a round-trip to confirm it
// would be the whole point of this filter thrown away.
function branchesNeedingLookup(localPayload, prs) {
  const seen = new Set((prs || []).map(p => p.headRef).filter(Boolean));
  const out = new Map();
  for (const proc of localPayload.processes || []) {
    for (const w of proc.worktrees || []) {
      if (w.detached || w.prunable || !w.branch || !w.githubRepo) continue;
      if (w.onOrigin === false) continue;
      if (seen.has(w.branch)) continue;
      // NUL as a source ESCAPE, never a raw NUL byte: a literal NUL makes git
      // treat the whole file as binary, and a later merge in a stacked branch
      // series then degrades to an unresolvable whole-file conflict (hit exactly
      // once while building this). NUL is still the right separator — git
      // forbids it in a ref name, so no slug or branch can collide through it.
      out.set(`${w.githubRepo}\u0000${w.branch}`, { githubRepo: w.githubRepo, branch: w.branch });
    }
  }
  return Array.from(out.values());
}

// IO wrapper: run the collector and the PR fetch, then join. Everything is
// injected so tests never touch disk or the network.
//
// Two-phase on purpose: the broad `--author=@me` search is one round-trip for
// everything recent, and the targeted per-branch lookup then settles only what
// it left ambiguous. Doing it the other way round (per-branch for everything)
// would be N round-trips; doing only the broad search is what let merged and
// closed PRs read as "no PR". `fetchPRsForBranches` is optional so an older
// caller keeps working with the broad half alone.
async function ledger(opts) {
  const { collect, fetchOwnPRs, fetchPRsForBranches, ioForCollect, now } = opts;
  const local = await collect(ioForCollect);
  const { prs, warnings } = await fetchOwnPRs(opts);

  let allPrs = prs;
  let allWarnings = warnings;
  if (typeof fetchPRsForBranches === 'function') {
    const branches = branchesNeedingLookup(local, prs);
    if (branches.length > 0) {
      const extra = await fetchPRsForBranches(Object.assign({}, opts, { branches }));
      // Dedupe by identity, not by headRef: the same branch can carry several
      // PRs (a closed attempt plus a later merged one), and every one of them is
      // a reason not to offer a fresh draft.
      const have = new Set(prs.map(p => `${p.owner}/${p.repo}#${p.number}`));
      allPrs = prs.concat((extra.prs || []).filter(p => !have.has(`${p.owner}/${p.repo}#${p.number}`)));
      allWarnings = (warnings || []).concat(extra.warnings || []);
    }
  }

  return buildLedger(local, allPrs, now(), allWarnings);
}

module.exports = { buildLedger, ledger, branchesNeedingLookup, LEDGER_VERSION };
