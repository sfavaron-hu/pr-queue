// ── GitHub API ───────────────────────────────────────────────

async function apiFetch(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(body).message; } catch { msg = body; }
    throw new Error(`GitHub ${res.status}: ${msg || res.statusText}`);
  }
  return res.json();
}

// The head ref of a merged PR, which `/search/issues` does not carry: that
// endpoint returns issue-shaped items whose `pull_request` sub-object has only
// diff/patch/html/api URLs, never a branch. The field exists solely on the pulls
// API, so it costs one extra GET — but only one, not the three enrichOwnPR makes
// (a merged PR needs no review or comment data).
//
// Worth the call because `headRef` is what attaches a PR to the local worktree it
// belongs to. Without it the join falls back to matching a ticket extracted from
// the title, which silently fails for no-ticket work: measured on this account,
// 3 of 7 merged PRs in the panel's window had no ticket anywhere in the title, so
// their worktrees never showed as merged-and-cleanable — exactly the signal the
// merged list exists to give.
//
// Returns null rather than throwing: a PR whose head ref cannot be read is still
// worth listing, it just cannot be joined.
async function fetchHeadRef(pullsUrl) {
  if (!pullsUrl) return null;
  try {
    const d = await apiFetch(pullsUrl);
    return (d && d.head && d.head.ref) || null;
  } catch { return null; }
}

async function getCIStatus(owner, repo, sha) {
  try {
    const data = await apiFetch(`${API}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
    const runs = (data.check_runs || []).filter(r => r.app?.slug !== 'dependabot');
    if (runs.length === 0) return 'unknown';
    if (runs.some(r => r.status !== 'completed')) return 'pending';
    const bad = runs.filter(r => !['success', 'skipped', 'neutral'].includes(r.conclusion));
    return bad.length === 0 ? 'green' : 'failed';
  } catch {
    return 'unknown';
  }
}

async function enrichPR(pr, botRe, onProgress) {
  const [owner, repo] = pr.repository_url.replace(`${API}/repos/`, '').split('/');
  const number = pr.number;

  const isBot = u => u.type === 'Bot' || u.login.endsWith('[bot]') || botRe.test(u.login);
  if (pr.user.login === state.me) { onProgress(); return null; }
  if (isBot(pr.user)) {
    onProgress();
    return { id: pr.id, number, owner, repo, title: pr.title,
      author: pr.user.login, authorAvatar: pr.user.avatar_url,
      url: pr.html_url, createdAt: new Date(pr.created_at),
      ci: 'unknown', humanReviews: 0, humanComments: 0, draft: false,
      conflicts: false, ready: false, botPR: true };
  }

  try {
    const [prDetails, reviews, comments] = await Promise.all([
      apiFetch(`${API}/repos/${owner}/${repo}/pulls/${number}`),
      apiFetch(`${API}/repos/${owner}/${repo}/pulls/${number}/reviews`),
      apiFetch(`${API}/repos/${owner}/${repo}/issues/${number}/comments`),
    ]);

    const sha = prDetails.head.sha;
    const ci  = await getCIStatus(owner, repo, sha);

    const isHuman = u => !isBot(u) && u.login !== pr.user.login;
    const humanRevs     = (reviews  || []).filter(r => isHuman(r.user));
    const humanComments = (comments || []).filter(c => isHuman(c.user));
    const humanActivity = humanRevs.length + humanComments.length;
    const activityBy    = [...new Set([...humanRevs.map(r => r.user.login), ...humanComments.map(c => c.user.login)])];
    const approved      = humanRevs.some(r => r.state === 'APPROVED');
    const changesReq    = humanRevs.some(r => r.state === 'CHANGES_REQUESTED');

    onProgress();
    return { id: pr.id, number, owner, repo, title: pr.title,
      author: pr.user.login, authorAvatar: pr.user.avatar_url,
      url: pr.html_url, createdAt: new Date(pr.created_at),
      ci, humanActivity, activityBy, approved, changesReq, draft: prDetails.draft,
      conflicts: prDetails.mergeable_state === 'dirty',
      additions: prDetails.additions || 0,
      deletions: prDetails.deletions || 0,
      lines: (prDetails.additions || 0) + (prDetails.deletions || 0),
      dontMerge: pr.labels.some(l => l.name.includes("don't merge") || l.name.includes("dont merge") || l.name.includes("🚧")),
      ready: ci === 'green' && humanActivity === 0 && !prDetails.draft
        && !pr.labels.some(l => l.name.includes("don't merge") || l.name.includes("dont merge") || l.name.includes("🚧")) };
  } catch {
    onProgress();
    return null;
  }
}

async function enrichOwnPR(pr) {
  const [owner, repo] = pr.repository_url.replace(`${API}/repos/`, '').split('/');
  const number = pr.number;
  const botRe  = new RegExp(state.config.bots, 'i');
  const isBot  = u => u.type === 'Bot' || u.login.endsWith('[bot]') || botRe.test(u.login);
  const isOther = u => !isBot(u) && u.login !== pr.user.login;

  try {
    const [prDetails, reviews, comments] = await Promise.all([
      apiFetch(`${API}/repos/${owner}/${repo}/pulls/${number}`),
      apiFetch(`${API}/repos/${owner}/${repo}/pulls/${number}/reviews`),
      apiFetch(`${API}/repos/${owner}/${repo}/issues/${number}/comments`),
    ]);

    const humanRevs     = (reviews  || []).filter(r => isOther(r.user));
    const humanComments = (comments || []).filter(c => isOther(c.user));

    const stored        = state.ownActivity[pr.id] || { commentIds: [], reviewIds: [] };
    const seenComments  = new Set(stored.commentIds);
    const seenReviews   = new Set(stored.reviewIds);

    const newComments   = humanComments.filter(c => !seenComments.has(c.id)).length;
    const newApprovals  = humanRevs.filter(r => r.state === 'APPROVED'          && !seenReviews.has(r.id)).length;
    const newChanges    = humanRevs.filter(r => r.state === 'CHANGES_REQUESTED' && !seenReviews.has(r.id)).length;
    const approved      = humanRevs.some(r => r.state === 'APPROVED');
    const changesReq    = humanRevs.some(r => r.state === 'CHANGES_REQUESTED');

    const sha = prDetails.head.sha;
    const ci  = await getCIStatus(owner, repo, sha);

    return { id: pr.id, number, owner, repo, title: pr.title, url: pr.html_url,
      ci, conflicts: prDetails.mergeable_state === 'dirty', draft: prDetails.draft,
      additions: prDetails.additions || 0,
      deletions: prDetails.deletions || 0,
      lines: (prDetails.additions || 0) + (prDetails.deletions || 0),
      createdAt: new Date(pr.created_at),
      approved, changesReq, newComments, newApprovals, newChanges,
      allCommentIds: humanComments.map(c => c.id),
      allReviewIds:  humanRevs.map(r => r.id),
      headRef: prDetails.head.ref,
      updatedAt: new Date(pr.updated_at),
      humanReviews: humanRevs.length };
  } catch { return null; }
}
