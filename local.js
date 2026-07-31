// Local-only "procesos activos" panel.
//
// Mounts ONLY if /api/local answers. On GitHub Pages that request 404s and
// this file does nothing at all, which is what keeps the shared deploy
// byte-for-byte unchanged for everyone else.
//
// Mounted, it renders one card per active process inside #own-column,
// reusing the same .pr-card CSS the "Mis PRs" list already uses, and swaps
// that column's heading to "Trabajo activo". Unmounted, the column is
// exactly what it always was: PR cards under a "Mis PRs" heading.

const PROC_CACHE_KEY = 'prq_proc_cache';

const procEl = {
  workList:    () => document.getElementById('work-list'),
  columnTitle: () => document.getElementById('own-column-title'),
  metaLine:    () => document.getElementById('proc-meta-line'),
};

// safeHttpUrl is defined as a global by classify.js (loaded before this file
// in index.html) — the one shared home for logic used by both the browser
// and Node runtimes. Every href in this file is untrusted — it comes from
// the payload (which already ran a `prUrl` through the parser's copy of the
// same shared function) or from state.ownPRs (GitHub API data), or is built
// by string interpolation of repo/branch names — so this file re-checks all
// three rather than trusting upstream validation or a currently-safe
// hardcoded prefix to stay that way.

// An anchor when the url passes the allowlist, otherwise the label rendered
// as plain escaped text with no `<a>` at all — the row keeps its information
// (a PR number, a "diff" label) instead of disappearing, but nothing with a
// rejected scheme ever reaches an href.
function safeLinkHTML(url, label, attrs) {
  const safe = safeHttpUrl(url);
  if (!safe) return escS(label);
  return `<a href="${esc(safe)}"${attrs || ''}>${escS(label)}</a>`;
}

// Attaches each PR in `ownPRs` to at most one process: an exact `headRef`
// match against `proc.branches` wins if one exists; failing that, the first
// process (in payload order) whose `ticket` equals the PR's extracted ticket,
// provided both are non-null. This is what merges a PR on
// `feat/SQSH-3954-copy` into the same row as a worktree on
// `feat/SQSH-3954-web` — same ticket, one process — while still preferring
// the precise branch match when one exists. Two passes over `ownPRs`, not
// one, so an exact match anywhere always outranks a ticket match anywhere,
// matching the priority order the spec calls for. Returns the per-process PR
// lists alongside whatever PR matched nothing, for synthesizeProcesses() to
// turn into rows of its own.
function attachOwnPRs(processes, ownPRs) {
  const rows = processes.map(proc => ({ proc, prs: [] }));
  const afterExact = [];
  const unmatched = [];

  ownPRs.forEach(pr => {
    const row = pr.headRef ? rows.find(r => r.proc.branches.indexOf(pr.headRef) !== -1) : null;
    if (row) row.prs.push(pr);
    else afterExact.push(pr);
  });

  afterExact.forEach(pr => {
    const ticket = pr.headRef ? extractTicket(pr.headRef) : null;
    const row = ticket ? rows.find(r => r.proc.ticket && r.proc.ticket === ticket) : null;
    if (row) row.prs.push(pr);
    else unmatched.push(pr);
  });

  return { rows, unmatched };
}

// One synthetic process per distinct ticket (or, lacking a ticket, per
// branch) among PRs that attachOwnPRs() matched nowhere — a PR pushed
// straight to GitHub with no local worktree still gets a card instead of
// vanishing along with the "Mis PRs" column it used to live in.
// `worktrees`/`sessions` stay empty and `lastLocalActivity` stays null, which
// is what keeps this out of the 48h own-activity window: classify() falls
// straight through turno's local-activity check to the PR-driven
// esperando/pausa/frío branches, so no classifier change is needed. `ticket`
// mirrors a real process's shape (non-null only when one was found) so
// downstream code (the "sin ticket" badge) treats it identically. `synthetic`
// is the marker procCardHTML uses to print "sin worktree local" in place of
// the (necessarily empty) repo list. Two PRs that resolve to the same key
// share one process, both attached to it.
function synthesizeProcesses(unmatchedPRs) {
  const map = new Map();
  unmatchedPRs.forEach(pr => {
    const ticket = pr.headRef ? extractTicket(pr.headRef) : null;
    const key = ticket || pr.headRef;
    if (!map.has(key)) {
      map.set(key, {
        proc: { key: key, ticket: ticket || null, branches: [], worktrees: [],
                sessions: [], lastLocalActivity: null, synthetic: true },
        prs: [],
      });
    }
    const row = map.get(key);
    if (pr.headRef && row.proc.branches.indexOf(pr.headRef) === -1) row.proc.branches.push(pr.headRef);
    row.prs.push(pr);
  });
  return Array.from(map.values());
}

// A session whose cwd resolved to no worktree can still be placed if its
// pr-link matches a PR we know about: that PR's headRef gives the branch,
// which gives the process. Sessions that still match nothing stay loose and
// at least render their PR link.
function mergeLooseSessions(payload) {
  const own = (typeof state !== 'undefined' && state.ownPRs) || [];
  const stillLoose = [];

  (payload.looseSessions || []).forEach(s => {
    if (!s.prLink) { stillLoose.push(s); return; }
    const pr = own.find(p =>
      p.number === s.prLink.number &&
      s.prLink.repo && s.prLink.repo.toLowerCase() === `${p.owner}/${p.repo}`.toLowerCase());
    if (!pr || !pr.headRef) { stillLoose.push(s); return; }

    const host = payload.processes.find(p => p.branches.indexOf(pr.headRef) !== -1);
    if (!host) { stillLoose.push(s); return; }

    host.sessions.push(Object.assign({}, s, { branch: pr.headRef }));
    if (typeof s.lastActivity === 'number' &&
        (host.lastLocalActivity === null || s.lastActivity > host.lastLocalActivity)) {
      host.lastLocalActivity = s.lastActivity;
    }
  });

  payload.looseSessions = stillLoose;
}

// collect-parse.js can emit a null sessionId; `s.name || s.sessionId.slice(...)`
// then throws on `.slice` of null. Coerce to a string first so a session with
// neither a name nor an id still renders something instead of crashing.
function sessionLabel(s) {
  if (s.name) return s.name;
  return s.sessionId ? String(s.sessionId).slice(0, 8) : 'sesión';
}

function looseRowHTML(sessions) {
  const items = sessions.map(s => {
    const link = s.prLink
      ? ` ${safeLinkHTML(s.prLink.url, '#' + s.prLink.number, ' target="_blank"')}` : '';
    const when = s.lastActivity ? ` <span class="proc-detail">${timeAgo(new Date(s.lastActivity))}</span>` : '';
    return `${esc(sessionLabel(s))}${s.status ? ' (' + esc(s.status) + ')' : ''}${link}${when}`;
  }).join(' · ');

  return `<div class="proc-row">
    <span class="proc-state frio">Sueltas</span>
    <span><span class="proc-key">Sesiones sin worktree</span>
      <br><span class="proc-detail">${items}</span></span>
    <span class="proc-detail">${sessions.length}</span>
  </div>`;
}

// Top-right state badge for a process card. FRÍO gets an extra dimming
// modifier so it visually recedes even though it shares badge-gray with
// EN PAUSA — a process nobody expects back for a while should read as more
// dormant than one merely between turns.
const PROC_STATE_BADGE = {
  turno:     ['badge-red',        'TU TURNO'],
  esperando: ['badge-amber',      'ESPERANDO'],
  pausa:     ['badge-gray',       'EN PAUSA'],
  frio:      ['badge-gray badge-dim', 'FRÍO'],
};

function procStateBadgeHTML(s) {
  const [cls, label] = PROC_STATE_BADGE[s] || ['badge-gray', s.toUpperCase()];
  return `<span class="badge ${cls}">${label}</span>`;
}

// `lastCommitSubject` and `aiTitle` are untrusted text (a commit subject can
// contain `<script>` or quotes; `aiTitle` is model-generated), and an older
// cached payload can hand back `null`/`undefined` for either. `esc()` has no
// type coercion and throws on non-strings, so every interpolation of these
// fields goes through this wrapper first.
function escS(v) {
  return (v === null || v === undefined) ? '' : esc(String(v));
}

// The card's title line: the context subtitle. First available of the joined
// PR's title, an attached session's aiTitle, or a worktree's last commit
// subject — all three are free per the collector. Falls back to the process
// key so a card never renders with an empty title.
function subtitleFor(p, prs) {
  const pr = prs.find(x => x.title);
  if (pr) return pr.title;
  const sess = p.sessions.find(x => x.aiTitle);
  if (sess) return sess.aiTitle;
  const wt = p.worktrees.find(w => w.lastCommitSubject);
  if (wt) return wt.lastCommitSubject;
  return null;
}

// The set of "owner/repo" slugs (lowercased) that already have a joined PR
// in this row. A PR carries `owner`/`repo` separately; a worktree carries
// `githubRepo` as a single `owner/name` slug — comparing on the short `repo`
// name alone would wrongly conflate two same-named repos under different
// owners, so both sides are normalized to the same "owner/repo" basis.
function prRepoSlugs(prs) {
  const set = new Set();
  (prs || []).forEach(pr => {
    if (pr.owner && pr.repo) set.add(`${pr.owner}/${pr.repo}`.toLowerCase());
  });
  return set;
}

// One compare link per distinct repo among the process's worktrees, except
// for a repo that already has a joined PR in this row: the PR link already
// gets you there, and the one reason to keep `diff` alongside a PR — that
// GitHub's compare page carries the create-PR button — no longer applies
// once a PR exists. A process spanning two repos where only one has a PR
// still gets `diff` for the other. A detached worktree has no branch (no
// compare possible) and a prunable one has no git detail at all — neither
// qualifies. Nor does a worktree missing `githubRepo`/`baseBranch`
// (unparseable remote, or base branch unknown), or an older cached payload
// that predates those fields entirely.
function diffLinksFor(p, prs) {
  const seen = new Set();
  const links = [];
  const prRepos = prRepoSlugs(prs);
  p.worktrees.forEach(w => {
    if (seen.has(w.repo) || w.detached || w.prunable) return;
    if (!w.githubRepo || !w.baseBranch || !w.branch) return;
    seen.add(w.repo);
    if (prRepos.has(w.githubRepo.toLowerCase())) return;
    links.push({ repo: w.repo, url: `https://github.com/${w.githubRepo}/compare/${w.baseBranch}...${w.branch}` });
  });
  return links;
}

// A click-to-copy chip, styled like the rest of the card's actionables
// (.btn.btn-ghost.btn-sm) with a `proc-copy` marker class the single
// delegated listener queries for. `text` is the untrusted-ish command string
// copied to the clipboard; both the visible label and the `data-copy`
// attribute go through esc()/escS(). `title` defaults to `text` (the full
// command on hover) but a caller can pass a richer tooltip — always still
// escaped here, not by the caller.
function copyChip(label, text, title) {
  const t = title === undefined ? text : title;
  return `<button type="button" class="btn btn-ghost btn-sm proc-copy" data-copy="${esc(text)}" title="${esc(t)}">${escS(label)}</button>`;
}

// A normalized `resume` chip per attached session, carrying its resumeCmd.
// The label stays short and stable — `resume` alone when the row has one
// session, numbered `resume 1`, `resume 2`, … when it has several, so they
// stay distinguishable without the real session name (which can be a full
// sentence) ballooning the chip. That name and the session's status live in
// the tooltip instead. resumeCmd comes straight from the payload; fall back
// to building it from sessionId for an older cached payload that predates
// the field, and skip a session with neither rather than throw.
function sessionChips(p) {
  const withCmd = p.sessions
    .map(x => {
      const cmd = x.resumeCmd || (x.sessionId ? `claude --resume ${x.sessionId}` : null);
      return cmd ? { x, cmd } : null;
    })
    .filter(Boolean);

  return withCmd.map((item, i) => {
    const label = withCmd.length > 1 ? `resume ${i + 1}` : 'resume';
    const name = sessionLabel(item.x);
    const status = item.x.status ? ` (${item.x.status})` : '';
    const title = `${name}${status} — ${item.cmd}`;
    return copyChip(label, item.cmd, title);
  });
}

// `cd <path>` per worktree, or — for a prunable one, whose directory is
// gone — a copyable `git worktree prune` instead. The repo's main checkout
// path isn't itself in the payload, but collect.js derives every repoPath the
// same way (workspaceRoot joined with the repo name), so that's reconstructed
// here for the prune command. Falls back to the bare repo name if an older
// cached payload lacks `workspaceRoot`, which still gives the user something
// to fill in rather than nothing.
function worktreeChip(w, workspaceRoot, multi) {
  const repoLabel = multi ? ` ${w.repo}` : '';
  if (w.prunable) {
    const repoPath = workspaceRoot ? `${workspaceRoot}/${w.repo}` : w.repo;
    return copyChip(`prune${repoLabel} ⎘`, `git -C ${repoPath} worktree prune`);
  }
  if (!w.path) return null;
  return copyChip(`cd${repoLabel} ⎘`, `cd ${w.path}`);
}

// A soft first-person notice, never phrased as an accusation against GitHub:
// state.ownPRs can legitimately end up empty while a token is configured
// (loadOwnPRs in render.js skips while the tab is hidden, and silently
// swallows fetch/enrichment failures) — that must never be confused with a
// user who has a token and genuinely has zero open PRs, so the panel is
// conservative and treats "token present, zero PRs" as unavailable data
// rather than trying to tell the two apart from ownPRs.length alone.
function prNoticeHTML() {
  return `<div class="proc-notice">No pude cargar el estado de los PRs — puede haber PRs abiertos sin reflejar en esta vista.</div>`;
}

// Compact "Mergeados" footer: state.mergedPRs (recent-3-day merges, populated
// by loadOwnPRs in render.js) has nowhere to go once #own-pr-list is hidden —
// this reproduces just enough of it, one short line per PR, so hiding the PR
// list doesn't silently drop it. Deliberately not part of the process cards
// or the state counts computed below: a merged PR is finished work, not
// something waiting on a decision.
function mergedSectionHTML(mergedPRs) {
  if (!mergedPRs || !mergedPRs.length) return '';
  const rows = mergedPRs.map(pr =>
    `<div class="proc-merged-row">${safeLinkHTML(pr.url, '#' + pr.number, ' target="_blank"')} <span class="proc-detail">${escS(pr.repo)}</span></div>`
  ).join('');
  return `<div class="proc-merged"><div class="proc-merged-heading">Mergeados</div>${rows}</div>`;
}

// One `.pr-card` per process, built from the exact same class vocabulary
// renderCard() in render.js uses for a PR card — .pr-title, .pr-repo,
// .pr-number, .pr-meta, .pr-actions, .badge(-red/-amber/-green/-gray),
// .btn.btn-ghost.btn-sm — so a process card sits natively among PR cards
// with no bespoke styling of its own.
function procCardHTML(row, now, workspaceRoot, prDataUnavailable) {
  const p = row.proc;
  const prs = row.prs;
  const s = classify(p, prs, now);
  const last = lastActivity(p, prs);
  const diffs = diffLinksFor(p, prs);

  // Title: PR title, else session aiTitle, else last commit subject, else
  // the process key itself so the card never has an empty title. Linked to
  // the PR when one exists, else the compare/diff URL, else plain text.
  const titleText = subtitleFor(p, prs) || p.key;
  const linkPr = prs.find(x => x.title) || prs[0] || null;
  const titleUrl = linkPr ? linkPr.url : (diffs[0] ? diffs[0].url : null);
  const titleInner = titleUrl
    ? safeLinkHTML(titleUrl, titleText, ' target="_blank" rel="noopener"')
    : escS(titleText);

  const repos = [...new Set(p.worktrees.map(w => w.repo))];
  const repoLabel = repos.length ? repos.join(', ') : (p.synthetic ? 'sin worktree local' : '');

  const dirty = p.worktrees.reduce((n, w) => n + (w.dirty || 0), 0);
  // `unpushed` may be null (unknown, e.g. no base branch to diff against) on
  // any given worktree — that must not silently count as 0, but a `null` in
  // the sum must not render as NaN either. Only worktrees with a real number
  // contribute; if none do, there is nothing to show.
  const unpushedKnown = p.worktrees.some(w => typeof w.unpushed === 'number');
  const unpushed = unpushedKnown
    ? p.worktrees.reduce((n, w) => n + (typeof w.unpushed === 'number' ? w.unpushed : 0), 0)
    : null;
  const detached = p.worktrees.filter(w => w.detached).length;

  // Second row, right: the same badge vocabulary a PR card uses (CI, Draft,
  // ✗ Cambios / ✓ Aprobado, ⚡ Conflicts), aggregated across every PR in the
  // row, plus local worktree state and a gray timeAgo badge. No badge for
  // any of this when the row has no PR at all — there is nothing to report.
  const rightBadges = [];
  if (prs.length) {
    const ci = prs.some(x => x.ci === 'failed')  ? 'failed'
             : prs.some(x => x.ci === 'pending') ? 'pending'
             : prs.some(x => x.ci === 'green')   ? 'green' : 'unknown';
    rightBadges.push(ciBadge(ci));
    if (prs.some(x => x.draft)) rightBadges.push('<span class="badge badge-amber" data-tip="PR en borrador, no listo para review">Draft</span>');
    if (prs.some(x => x.changesReq)) rightBadges.push('<span class="badge badge-red" data-tip="Alguien pidió cambios">✗ Cambios</span>');
    else if (prs.some(x => x.approved)) rightBadges.push('<span class="badge badge-green" data-tip="Tiene al menos un approve">✓ Aprobado</span>');
    if (prs.some(x => x.conflicts)) rightBadges.push('<span class="badge badge-red">⚡ Conflicts</span>');
  }
  if (unpushed > 0) rightBadges.push(`<span class="badge badge-gray">${unpushed} sin pushear</span>`);
  if (dirty > 0) rightBadges.push(`<span class="badge badge-gray">${dirty} sin commitear</span>`);
  rightBadges.push(`<span class="badge badge-gray">${last ? timeAgo(new Date(last)) : '—'}</span>`);

  // .pr-actions: every actionable link/chip. One "Open →" per PR (labeled
  // per-repo only when the row carries more than one), then a diff chip per
  // repo still missing a PR, then a resume chip per session, then a cd/prune
  // chip per worktree.
  const actions = [];
  const multiPR = prs.length > 1;
  prs.forEach(pr => {
    const label = multiPR ? `Open ${pr.repo} →` : 'Open →';
    actions.push(safeLinkHTML(pr.url, label, ' target="_blank" rel="noopener" class="btn btn-ghost btn-sm"'));
  });
  diffs.forEach(d => {
    const label = diffs.length > 1 ? `diff ${d.repo}` : 'diff';
    actions.push(safeLinkHTML(d.url, label, ' target="_blank" rel="noopener" class="btn btn-ghost btn-sm"'));
  });
  sessionChips(p).forEach(chip => actions.push(chip));
  const multiWorktree = p.worktrees.length > 1;
  p.worktrees.forEach(w => {
    const chip = worktreeChip(w, workspaceRoot, multiWorktree);
    if (chip) actions.push(chip);
  });

  // .pr-meta left: process identity — no ticket, detached-worktree count,
  // and (only when nothing else in the row says anything about a PR at all)
  // the "sin PR"/"PR: —" fallback, matching the same distinction the old
  // panel drew between "no PR data" and "genuinely zero PRs".
  const identity = [];
  if (!p.ticket) identity.push('<span class="badge badge-gray">sin ticket</span>');
  if (detached > 0) identity.push(`<span class="badge badge-gray">${detached} detached</span>`);
  if (actions.length === 0) {
    identity.push(prDataUnavailable
      ? '<span class="badge badge-gray">PR: —</span>'
      : '<span class="badge badge-gray">sin PR</span>');
  }

  return `<div class="pr-card" data-proc-key="${esc(p.key)}">
    <div class="pr-top">
      <div class="pr-title" style="margin:0;flex:1;">${titleInner}</div>
      <div class="pr-badges">${procStateBadgeHTML(s)}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="pr-repo">${esc(p.key)}</span>
        ${repoLabel ? `<span class="pr-number">${escS(repoLabel)}</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end;">
        ${rightBadges.join('')}
      </div>
    </div>
    <div class="pr-meta">
      <div>${identity.join(' ')}</div>
      <div class="pr-actions">${actions.join('')}</div>
    </div>
  </div>`;
}

function renderLocalPanel() {
  const payload = window.LOCAL_STATE;
  if (!payload || !payload.processes) return;

  const now = Date.now();
  mergeLooseSessions(payload);

  const ownPRs = (typeof state !== 'undefined' && state.ownPRs) || [];
  // "sin PR" is only honest when the panel has no token at all — it genuinely
  // cannot know, and nobody asked it to. A token with zero PRs is ambiguous
  // (real, or loadOwnPRs failed/skipped silently) and is treated as
  // unavailable data rather than an empty result; see prNoticeHTML().
  const tokenConfigured = typeof state !== 'undefined' && !!state.token;
  const prDataUnavailable = tokenConfigured && ownPRs.length === 0;
  const { rows, unmatched } = attachOwnPRs(payload.processes, ownPRs);
  const allRows = rows.concat(synthesizeProcesses(unmatched));
  const sorted = sortProcesses(allRows, now);

  // Build the entire list first. If anything here throws, nothing has been
  // mutated yet — #work-list stays exactly as it was (empty, or showing the
  // previous good paint) instead of a half-built list.
  const mergedPRs = (typeof state !== 'undefined' && state.mergedPRs) || [];
  const listHTML = (prDataUnavailable ? prNoticeHTML() : '')
    + sorted.map(r => procCardHTML(r, now, payload.workspaceRoot, prDataUnavailable)).join('')
    + ((payload.looseSessions || []).length ? looseRowHTML(payload.looseSessions) : '')
    + mergedSectionHTML(mergedPRs);

  const states = sorted.map(r => classify(r.proc, r.prs, now));
  const count = st => states.filter(x => x === st).length;

  const warn = payload.warnings || [];
  const metaText =
    `${sorted.length} procesos · ${count('turno')} tu turno · ${count('esperando')} esperando · ` +
    `${count('pausa')} en pausa · ${count('frio')} fríos (>${COLD_DAYS}d)` +
    (warn.length ? ` · ${warn.length} warnings` : '') +
    (payload.generatedAt ? ` · ${timeAgo(new Date(payload.generatedAt))}` : '');

  procEl.workList().innerHTML = listHTML;
  procEl.metaLine().textContent = metaText;
  procEl.metaLine().classList.remove('hidden');
  // Hovering surfaces the actual warning messages — otherwise "· N warnings"
  // is a count with nowhere to see what went wrong.
  procEl.metaLine().title = warn.length
    ? warn.map(w => `${w.repo ? w.repo + ': ' : ''}${w.step}: ${w.message}`).join('\n')
    : '';

  procEl.columnTitle().textContent = 'Trabajo activo';
  // The PR list gets hidden by class (see index.html's body.proc-panel-active
  // rules), not inline styles — loadOwnPRs() in render.js clears any inline
  // display on #own-pr-list/#own-empty/#own-loading on its own timer-driven
  // runs, and a class on <body> is untouched by that.
  document.body.classList.add('proc-panel-active');
}

// Brief visual feedback for a copy chip: swap its label to "copiado" for a
// moment, then restore it. A rejected clipboard promise (permissions,
// non-secure context) is swallowed rather than thrown — there is no user
// action to recover from that beyond trying again.
function flashCopied(btn) {
  const original = btn.textContent;
  btn.textContent = 'copiado';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('copied');
  }, 1200);
}

// One delegated listener on #work-list handles every copy chip, current and
// future — renderLocalPanel() replaces innerHTML on every repaint, which
// would stack a listener per chip per paint if attached directly to buttons.
function installCopyDelegation() {
  procEl.workList().addEventListener('click', (e) => {
    const btn = e.target.closest('.proc-copy');
    if (!btn) return;
    const text = btn.dataset.copy;
    if (!text || !navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(text).then(
      () => flashCopied(btn),
      () => { /* clipboard write rejected; nothing to recover from here */ });
  });
}

let procMounted = false;

// Everything that makes the panel visible and interactive, exactly once.
// The cached paint and the fetched paint both go through here, so the copy
// delegation is wired from the very first frame.
function mountPanel() {
  renderLocalPanel();
  if (procMounted) return;
  procMounted = true;

  installCopyDelegation();

  if (typeof window.renderOwnPRs === 'function' && !window.renderOwnPRs.__procWrapped) {
    const inner = window.renderOwnPRs;
    const wrapped = function () {
      const out = inner.apply(this, arguments);
      try { renderLocalPanel(); } catch (e) { console.warn('proc panel render failed', e); }
      return out;
    };
    wrapped.__procWrapped = true;
    window.renderOwnPRs = wrapped;
  }
}

// The panel must never survive a failed fetch, and a bug in it must never
// cost the user sight of their own PRs. A stale cached payload rendered as
// if it were current is worse than no panel at all — this restores
// #own-column to exactly its pre-mount state: "Mis PRs" heading, empty
// #work-list, PR list visible, 2fr/1fr grid.
function unmountPanel() {
  window.LOCAL_STATE = null;
  procEl.workList().innerHTML = '';
  procEl.metaLine().textContent = '';
  procEl.metaLine().title = '';
  procEl.metaLine().classList.add('hidden');
  procEl.columnTitle().textContent = 'Mis PRs';
  // Mirrors the class added in renderLocalPanel(): the throw-safety wrapper
  // (mountPanelSafely) and the sidecar-gone path in initLocalPanel() both
  // route here, so either one restores "Mis PRs", the PR list, and the
  // two-equal-column grid.
  document.body.classList.remove('proc-panel-active');
}

// mountPanel() can throw mid-build (e.g. a malformed row). Never let that
// leave a half-mounted heading/list on screen — fall back to a clean unmount.
function mountPanelSafely() {
  try {
    mountPanel();
    return true;
  } catch (e) {
    console.warn('proc panel mount failed', e);
    try { unmountPanel(); } catch { /* already gone */ }
    return false;
  }
}

async function initLocalPanel() {
  let painted = false;
  try {
    const cached = localStorage.getItem(PROC_CACHE_KEY);
    if (cached) { window.LOCAL_STATE = JSON.parse(cached); painted = mountPanelSafely(); }
  } catch { /* ignore a corrupt cache */ }

  let payload;
  try {
    const res = await fetch('/api/local', { cache: 'no-store' });
    if (!res.ok) throw new Error('no sidecar');
    payload = await res.json();
    if (!payload || !Array.isArray(payload.processes)) throw new Error('bad payload');
  } catch {
    if (painted) unmountPanel();
    return;
  }

  window.LOCAL_STATE = payload;
  try { localStorage.setItem(PROC_CACHE_KEY, JSON.stringify(payload)); } catch { /* quota */ }

  mountPanelSafely();
}

initLocalPanel();
