// The deterministic half of the work assistant: a pure function of the ledger
// that splits mechanical actions from human decisions. No model, no execution,
// no IO except the injected pr-babysit reads. The gate only *identifies* work;
// running it is a later increment.

function repoPath(workspaceRoot, repo) {
  return workspaceRoot ? `${workspaceRoot}/${repo}` : repo;
}

// Stable, human-readable, and content-derived: the same (kind, process, repo,
// branch) always yields the same id, so re-deriving an action across passes
// does not duplicate it. The queue (Increment 3) may hash this; a stable string
// already dedups.
function actionId(kind, processKey, repo, branch) {
  return `${kind}:${processKey}:${repo}:${branch || ''}`;
}

// One action per worktree, at most. Order of checks is the priority order:
// a gone directory prunes; a not-on-origin unconsumed branch pushes; an
// all-merged clean worktree gets removed; an on-origin branch with commits and
// no PR opens a draft. `continue` after each keeps them mutually exclusive per
// worktree (you cannot open a PR for a branch you are still pushing).
function buildActions(ledger) {
  const actions = [];
  const root = ledger.workspaceRoot;

  for (const p of ledger.processes) {
    const prs = p.prs || [];
    // Reversibility is a property of the environment: a branch any PR points at
    // (open = referenced, merged = consumed) is off-limits for an autonomous push.
    const consumed = (branch) => prs.some(pr => pr.headRef === branch);

    for (const w of (p.worktrees || [])) {
      if (w.prunable) {
        actions.push({
          id: actionId('prune-worktree', p.key, w.repo, w.branch),
          kind: 'prune-worktree', processKey: p.key, repo: w.repo,
          cmd: `git -C ${repoPath(root, w.repo)} worktree prune`,
          reversibility: 'reversible-metadata',
          why: 'El worktree ya no existe en disco',
          evidence: `${w.repo}: directorio ausente`,
        });
        continue;
      }
      if (w.detached || !w.branch || !w.path) continue;

      if (w.onOrigin === false && !consumed(w.branch)) {
        actions.push({
          id: actionId('push', p.key, w.repo, w.branch),
          kind: 'push', processKey: p.key, repo: w.repo,
          cmd: `git -C ${w.path} push -u origin ${w.branch}`,
          reversibility: 'reversible-unconsumed',
          why: 'La rama no está en origin y ningún PR la referencia',
          evidence: `${w.repo}/${w.branch}: onOrigin=false, sin PR que la consuma`,
        });
        continue;
      }

      const clean = (w.dirty || 0) === 0;
      if (prs.length > 0 && prs.every(pr => pr.merged === true) && clean) {
        actions.push({
          id: actionId('remove-merged-worktree', p.key, w.repo, w.branch),
          kind: 'remove-merged-worktree', processKey: p.key, repo: w.repo,
          cmd: `git -C ${repoPath(root, w.repo)} worktree remove ${w.path}`,
          reversibility: 'reversible-local',
          why: 'Todos los PRs del proceso están mergeados; el worktree es estado local sobrante',
          evidence: `${w.repo}/${w.branch}: PRs mergeados, worktree limpio`,
        });
        continue;
      }

      // unpushed is commits-above-base (the naming trap): here it correctly means
      // "has its own commits". Requires the branch on origin, no PR yet, clean, and
      // a known base + github slug to form the command.
      if (w.onOrigin !== false && (w.unpushed || 0) > 0 && prs.length === 0 &&
          clean && w.baseBranch && w.githubRepo) {
        actions.push({
          id: actionId('open-draft-pr', p.key, w.repo, w.branch),
          kind: 'open-draft-pr', processKey: p.key, repo: w.repo,
          cmd: `gh pr create --draft --fill -R ${w.githubRepo} --head ${w.branch} --base ${w.baseBranch}`,
          reversibility: 'reversible-draft',
          why: 'Rama en origin con commits sobre base y sin PR',
          evidence: `${w.repo}/${w.branch}: ${w.unpushed} commit(s) sobre ${w.baseBranch}`,
        });
      }
    }
  }
  return actions;
}

module.exports = { buildActions, actionId, repoPath };
