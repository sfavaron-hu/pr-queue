// Own PR state via the `gh` CLI, normalized to the shared `pr` contract
// (classify.js PR_CONTRACT_FIELDS). This is the assistant's half of the one
// duplication the design accepts: the browser fetches with a PAT via
// github.js, this fetches with `gh` — but both emit the identical shape, and
// tests/classify-join.js proves the join needs nothing outside that shape.
//
// Deliberately `--author=@me` with no org qualifier (unlike render.js:272),
// so the owner's work in every org is seen — including this repo's own PRs,
// which the browser's org-scoped query drops.
const { PR_CONTRACT_FIELDS, safeHttpUrl } = require('../classify.js');

// GitHub check conclusions → the four CI states classify() understands. A
// failing conclusion anywhere loses; else any not-yet-concluded check is
// pending; else all concluded green; an empty rollup is unknown (no CI).
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
function ciFromRollup(rollup) {
  const checks = rollup || [];
  if (!checks.length) return 'unknown';
  if (checks.some(c => FAILED.has(c.conclusion))) return 'failed';
  if (checks.some(c => !c.conclusion)) return 'pending';
  return 'green';
}

// One search item (gh search prs) + its detail view (gh pr view) → a contract
// pr. `url` is re-validated through safeHttpUrl even though it comes from gh,
// matching local.js's rule of trusting no href.
function buildPR(item, view) {
  const [owner, repo] = item.repository.nameWithOwner.split('/');
  return {
    owner, repo,
    number: item.number,
    title: item.title,
    url: safeHttpUrl(item.url),
    headRef: view.headRefName || null,
    draft: view.isDraft === true,
    merged: item.state === 'MERGED',
    ci: ciFromRollup(view.statusCheckRollup),
    approved: view.reviewDecision === 'APPROVED',
    changesReq: view.reviewDecision === 'CHANGES_REQUESTED',
    conflicts: view.mergeable === 'CONFLICTING',
    // The assistant has no per-PR "seen" baseline (that lives in the browser's
    // localStorage), so it cannot compute "new since I last looked". 0 is
    // honest here; the assistant's turn signal comes from other flags.
    newComments: 0,
    humanReviews: (view.reviews || []).length,
    updatedAt: view.updatedAt,
  };
}

const SEARCH_FIELDS = 'number,title,url,repository,state';
const VIEW_FIELDS = 'headRefName,isDraft,reviewDecision,mergeable,statusCheckRollup,reviews,updatedAt';

// How far back to pull merged PRs. The assistant needs a worktree's merged PR
// to be visible for as long as the worktree can linger on disk after the merge
// — otherwise remove-merged-worktree never fires and the branch is misread as
// cold / draftable (observed: PRs merged ~2 weeks ago fell outside the old
// 3-day window). 30 days covers the realistic linger; the precise fix (a
// per-branch merged lookup, unbounded) is deferred — a worktree left for more
// than MERGED_WINDOW_DAYS after its merge is still invisible here.
const MERGED_WINDOW_DAYS = 30;

// Open PRs plus PRs merged within MERGED_WINDOW_DAYS (sorted by most recently
// updated), each enriched by a per-PR `gh pr view`. `run(cmd, args, cwd)` → stdout.
async function fetchOwnPRs({ run, now }) {
  const cutoff = new Date(now() - MERGED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const warnings = [];
  let items = [];
  try {
    const open = JSON.parse(await run('gh',
      ['search', 'prs', '--author', '@me', '--state', 'open', '--limit', '60', '--json', SEARCH_FIELDS]));
    const merged = JSON.parse(await run('gh',
      ['search', 'prs', '--author', '@me', '--merged', '--merged-at', `>=${cutoff}`, '--sort', 'updated', '--limit', '60', '--json', SEARCH_FIELDS]))
      .map(x => ({ ...x, state: 'MERGED' }));
    items = open.concat(merged);
  } catch (e) {
    warnings.push({ repo: null, step: 'gh-search', message: `gh search prs failed: ${e.message}` });
    return { prs: [], warnings };
  }

  const prs = [];
  for (const item of items) {
    try {
      const view = JSON.parse(await run('gh', ['pr', 'view', item.url, '--json', VIEW_FIELDS]));
      prs.push(buildPR(item, view));
    } catch (e) {
      warnings.push({ repo: item.repository && item.repository.nameWithOwner, step: 'gh-view',
        message: `gh pr view ${item.url} failed: ${e.message}` });
    }
  }
  return { prs, warnings };
}

module.exports = { ciFromRollup, buildPR, fetchOwnPRs };
