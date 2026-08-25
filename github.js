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

// ── /where: ¿en que entorno esta este ticket? ────────────────────

// Cada fetcher devuelve un error en banda en vez de tirar: un entorno que no
// se pudo leer tiene que llegar a where.js como DESCONOCIDO, no romper la consulta.
async function whereSearchPRs(key) {
  const q = encodeURIComponent(searchQuery(key, state.config.org));
  const data = await apiFetch(`${API}/search/issues?q=${q}&per_page=50`);
  return (data.items || []).map(it => ({
    repoUrl: it.repository_url, pullsUrl: it.pull_request && it.pull_request.url,
    number: it.number, title: it.title, url: it.html_url, matchedKey: key,
  }));
}

async function wherePullDetail(item) {
  const d = await apiFetch(item.pullsUrl);
  return {
    repo: d.base.repo.name, number: d.number, url: d.html_url, title: d.title,
    merged: !!d.merged_at, mergeCommitSha: d.merge_commit_sha,
    baseRef: d.base.ref, headRef: d.head.ref, matchedKey: item.matchedKey,
  };
}

async function whereRepoVariable(repo, name) {
  try {
    const d = await apiFetch(`${API}/repos/${state.config.org}/${repo}/actions/variables/${name}`);
    return { ref: d.value };
  } catch (e) {
    if (whereIsRateLimit(e)) throw e;
    return { error: String(e.message || e) };
  }
}

// Un rate limit no puede degradarse a PARCIAL en silencio: si la API dejo de
// contestar, el reporte entero es sospechoso y tiene que gritar. Cualquier otro
// fallo si es local a este destino.
//
// GitHub tambien devuelve 403 para "Resource not accessible by personal
// access token" y para denegaciones SAML/org-access — mas probable en
// actions/variables con un PAT angosto. Esos son fallos LOCALES a ese
// destino, no del rate limit global, asi que el mensaje tiene que nombrar el
// rate limit explicitamente. GitHub lo hace con dos frases: "API rate limit
// exceeded" y "You have exceeded a secondary rate limit" — ambas matchean.
function whereIsRateLimit(e) {
  var msg = String(e && e.message || e);
  return /^GitHub 403/.test(msg) && /rate limit/i.test(msg);
}

async function whereCompare(repo, base, head) {
  try {
    const d = await apiFetch(
      `${API}/repos/${state.config.org}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return d.status;
  } catch (e) {
    if (whereIsRateLimit(e)) throw e;
    return null;
  }
}

// Solo fetchea y empareja: cual de los matches es "el actual" es un juicio y
// vive en where.js (latestTag). El fetch de tags vive en whereRepoData, una
// vez por repo, no una vez por target (5 targets = 5 GETs identicos si esto
// tambien fetcheara).
function whereMatchTag(tags, env, region) {
  const names = (tags || []).map(t => t.name);
  const hit = latestTag(names, env, region);
  return hit ? { ref: hit } : { error: `sin tag ${env}${region ? '-' + region : ''}` };
}

// Dos llamadas distintas, dos catches distintos: si la segunda (leer el
// release del tag) falla, eso no es lo mismo que "no hay run de CD" — la
// primera llamada si establecio que el run existe. Confundirlas le hace
// decir a prodCross una razon que nunca midio (ver where.js#prodCross).
async function whereReleaseRun(repo) {
  let run;
  try {
    const d = await apiFetch(
      `${API}/repos/${state.config.org}/${repo}/actions/runs?event=release&status=success&per_page=1`);
    run = (d.workflow_runs || [])[0];
  } catch (e) {
    if (whereIsRateLimit(e)) throw e;
    return null;
  }
  if (!run) return null;
  try {
    const rel = await apiFetch(
      `${API}/repos/${state.config.org}/${repo}/releases/tags/${encodeURIComponent(run.head_branch)}`);
    return { tag: run.head_branch, createdAt: run.created_at, targetCommitish: rel.target_commitish };
  } catch (e) {
    if (whereIsRateLimit(e)) throw e;
    return { error: String(e.message || e), tag: run.head_branch, createdAt: run.created_at };
  }
}

async function whereRepoData(repo) {
  const model = envModel(repo);
  if (model.kind === 'unknown') return { refs: {}, compares: {} };

  if (model.kind === 'fixed') {
    return { refs: { dev: { ref: model.dev }, stg: { ref: model.stg }, prd: { ref: model.prd } },
             compares: {} };
  }
  if (model.kind === 'tags') {
    const refs = {};
    try {
      const tags = await apiFetch(`${API}/repos/${state.config.org}/${repo}/tags?per_page=100`);
      for (const t of envTargets(repo)) refs[t.id] = whereMatchTag(tags, t.env, t.region);
    } catch (e) {
      if (whereIsRateLimit(e)) throw e;
      const msg = String(e.message || e);
      for (const t of envTargets(repo)) refs[t.id] = { error: msg };
    }
    return { refs, compares: {} };
  }
  const [stg, prd, releaseRun] = await Promise.all([
    whereRepoVariable(repo, 'REACT_STAGING_BRANCH'),
    whereRepoVariable(repo, 'REACT_PRODUCTION_BRANCH'),
    whereReleaseRun(repo),
  ]);
  return { refs: { dev: { ref: model.dev }, stg, prd }, compares: {},
           prodVar: prd.ref, releaseRun };
}

// Un PR ilegible no invalida el resto, pero tampoco desaparece sin dejar
// rastro: se cuenta, y esa cuenta viaja en el payload para que where.js
// pueda degradar el veredicto en vez de dibujar un reporte que parece
// completo con un repo faltante.
async function wherePullDetails(items) {
  const pulls = [];
  let failed = 0;
  for (const it of items.filter(i => i.pullsUrl)) {
    try { pulls.push(await wherePullDetail(it)); }
    catch (e) {
      if (whereIsRateLimit(e)) throw e;
      failed++;
    }
  }
  return { pulls, failed };
}

// El representante de cada repo se elige por `representativeByRepo` (where.js)
// — la misma funcion que usara buildWhereReport — para que fila mostrada y
// estado de compare vengan siempre del mismo PR. `pulls` se ordena por numero
// antes de elegir para que dos recomputos de la misma consulta acuerden el
// mismo sha: `search/issues` no devuelve orden estable.
//
// El fallback a la clave del padre dispara cuando la clave propia no aporto
// ningun PR "contributing" (mergeado al tronco) — no cuando la busqueda no
// trajo hits. Un PR abierto, un backport/* o un deps/* de clave propia hacen
// que la busqueda por clave propia no este vacia, pero no prueban nada:
// sin este chequeo el fallback nunca dispara y el panel NO_RESUELTO le pide
// al usuario tipear el valor que ya esta en la caja.
async function whereFetchAll(key, parentKey) {
  const items = await whereSearchPRs(key);
  let { pulls, failed: failedPulls } = await wherePullDetails(items);

  if (parentKey && resolvePRs(pulls, key).contributing.length === 0) {
    const parentItems = await whereSearchPRs(parentKey);
    const parentResult = await wherePullDetails(parentItems);
    pulls = pulls.concat(parentResult.pulls);
    failedPulls += parentResult.failed;
  }
  pulls.sort((a, b) => a.number - b.number);

  const byRepo = representativeByRepo(pulls, key);

  const perRepo = {};
  for (const repo of Object.keys(byRepo)) {
    const data = await whereRepoData(repo);
    const pr = byRepo[repo];
    for (const t of envTargets(repo)) {
      const info = data.refs[t.id];
      data.compares[t.id] = info && info.ref
        ? await whereCompare(repo, pr.mergeCommitSha, info.ref)
        : null;
    }
    perRepo[repo] = data;
  }
  return { key, org: state.config.org, pulls, perRepo, failedPulls };
}
