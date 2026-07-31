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

// Whether the real (unwrapped) window.renderOwnPRs has fired at least once
// since this page load. Flipped inside mountPanel()'s wrap, never reset —
// GitHub PR data (state.ownPRs / state.mergedPRs) arrives several seconds
// after the local collector's payload, and this is the only signal the panel
// has for "GitHub hasn't answered yet" vs. "GitHub answered and it's empty".
// See prDataState() for the three-way state this feeds.
let ownPRsFired = false;

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

// A merged PR from state.mergedPRs carries no `headRef` at all (see
// mergedSectionHTML's former caller / renderLocalPanel for the shape) — so
// the ticket it should join on has to come from its title instead, which is
// where a Jira ticket normally also appears. Open PRs always have `headRef`
// and keep using that, unchanged.
function prTicket(pr) {
  if (pr.headRef) return extractTicket(pr.headRef);
  return pr.title ? extractTicket(pr.title) : null;
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
    const ticket = prTicket(pr);
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
    const ticket = prTicket(pr);
    // A merged PR has no `headRef` — falling back to it here (like an open
    // PR would) collapses every ticket-less merged PR onto one shared key.
    // owner/repo#number is always unique per PR, so it's the fallback
    // instead.
    const key = ticket || pr.headRef || `${pr.owner}/${pr.repo}#${pr.number}`;
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
  mergeado:  ['badge-green',      'MERGEADO'],
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

// The card's title line: the joined PR's title, else the branch's own last
// commit subject, else null (procCardHTML falls back to the process key).
//
// A session's aiTitle used to be eligible here and that was wrong: aiTitle
// describes what a *session* was doing, which is frequently a side errand in
// that worktree (checking a colleague's PR, fixing an unrelated conflict) —
// not the process itself — so it could misrepresent the card, and the same
// aiTitle could even appear as the "title" of two unrelated cards. It still
// appears on the card, just as a subordinate second line (see aiTitleFor).
//
// lastCommitSubject is the subject of the branch's own most recent commit
// (origin/<base>..HEAD) as of commit b2ff15b, and is legitimately null when
// the branch has no commits of its own yet — common (5 of 36 worktrees on
// the owner's machine) and expected, not a bug; it must fall through to the
// key, never render as an empty title.
function subtitleFor(p, prs) {
  const pr = prs.find(x => x.title);
  if (pr) return pr.title;
  const wt = p.worktrees.find(w => w.lastCommitSubject);
  if (wt) return wt.lastCommitSubject;
  return null;
}

// The secondary, visually-subordinate line under the title: the aiTitle of
// the most recently active session attached to this process, if any. Several
// sessions can each carry their own aiTitle; the most recently active one is
// the most likely to still be relevant.
function aiTitleFor(p) {
  const withTitle = p.sessions.filter(x => x.aiTitle);
  if (!withTitle.length) return null;
  withTitle.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  return withTitle[0].aiTitle;
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
//
// Nor does a worktree the collector has confirmed (`onOrigin === false`) is
// genuinely absent from the remote: GitHub's compare page for a branch that
// isn't pushed opens an empty diff, which is worse than no link. This skip
// is per-worktree, not per-repo — it doesn't mark the repo `seen`, so a
// second worktree for the same repo whose branch *is* on origin (or whose
// onOrigin is unknown/absent) can still produce the link. `onOrigin === null`
// (undetermined) and an absent field (older cached payload) both mean
// "unknown", which must keep behaving exactly as before onOrigin existed —
// only a confirmed `false` suppresses the link.
function diffLinksFor(p, prs) {
  const seen = new Set();
  const links = [];
  const prRepos = prRepoSlugs(prs);
  p.worktrees.forEach(w => {
    if (seen.has(w.repo) || w.detached || w.prunable) return;
    if (w.onOrigin === false) return;
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

// A copy-able `git push -u origin <branch>` for a worktree the collector has
// confirmed is genuinely absent from the remote. This is the actionable
// that pairs with the "no está en origin" marker in procCardHTML: the
// number that used to render as "N sin pushear" for a squash-merged branch
// was arithmetically correct and utterly misleading (a squash merge means
// the local commits are never going to become ancestors of base, merged PR
// or not) — so instead of a stat, the card offers the one command that
// would actually change the state. Callers filter to worktrees that are
// confirmed absent (not merely detached/prunable, which carry the same
// `onOrigin: false` for an unrelated reason and have no branch+directory
// pair to push) before calling this.
function pushChip(w, multi) {
  const repoLabel = multi ? ` ${w.repo}` : '';
  return copyChip(`push${repoLabel} ⎘`, `git -C ${w.path} push -u origin ${w.branch}`);
}

// A copy-able `git worktree remove <path>` for a worktree that still exists
// locally on a process whose only PRs are merged — the actionable insight
// for a mergeado card: the branch is done, and the worktree is leftover local
// state worth cleaning up. Reconstructs the repo's main checkout path the
// same way worktreeChip's prune command does. Deliberately no `--force`: git
// itself refuses this when the worktree has uncommitted changes, which is
// exactly the safety net the owner relied on when doing this by hand.
function worktreeRemoveChip(w, workspaceRoot, multi) {
  const repoLabel = multi ? ` ${w.repo}` : '';
  const repoPath = workspaceRoot ? `${workspaceRoot}/${w.repo}` : w.repo;
  return copyChip(`remove${repoLabel} ⎘`, `git -C ${repoPath} worktree remove ${w.path}`);
}

// A soft first-person notice, never phrased as an accusation against GitHub:
// state.ownPRs can legitimately end up empty while a token is configured
// (loadOwnPRs in render.js skips while the tab is hidden, and silently
// swallows fetch/enrichment failures) — that must never be confused with a
// user who has a token and genuinely has zero open PRs, so the panel is
// conservative and treats "token present, zero PRs" as unavailable data
// rather than trying to tell the two apart from ownPRs.length alone. Only
// shown for prDataState() === 'unavailable' — never while still loading,
// which is not a failure and must not be reported as one.
function prNoticeHTML() {
  return `<div class="proc-notice">No pude cargar el estado de los PRs — puede haber PRs abiertos sin reflejar en esta vista.</div>`;
}

// Three PR-data states, in order of confidence — every place in this file
// that used to ask "do I have PR data" now asks this instead:
//  - 'no-token'    — no token configured at all. Today's behaviour, honest:
//                    the panel genuinely has no way to fetch PRs, ever.
//  - 'loading'     — a token exists but window.renderOwnPRs (wrapped in
//                    mountPanel) has not fired yet this page load. GitHub
//                    data can be several seconds behind the collector's, and
//                    nothing PR-shaped may be asserted as absent yet.
//  - 'unavailable' — renderOwnPRs fired at least once and state.ownPRs is
//                    still empty while a token exists. This is the
//                    pre-existing case: silent loadOwnPRs failure, or a tab
//                    that was hidden, or (rarely) a genuine zero.
//  - 'loaded'      — renderOwnPRs fired and state.ownPRs came back non-empty.
// The `ownPRs.length > 0` check is tested before `!ownPRsFired`, not after,
// so that a PR list which — despite the ordering mountPanel relies on
// (collector answers first, wrap installs, then GitHub answers) — somehow
// still lands before the wrap ever fires is read as 'loaded' rather than
// stuck showing 'loading' forever.
function prDataState() {
  const tokenConfigured = typeof state !== 'undefined' && !!state.token;
  if (!tokenConfigured) return 'no-token';
  const ownPRs = (typeof state !== 'undefined' && state.ownPRs) || [];
  if (ownPRs.length > 0) return 'loaded';
  return ownPRsFired ? 'unavailable' : 'loading';
}

// One `.pr-card` per process, built mostly from the same class vocabulary
// renderCard() in render.js uses for a PR card — .pr-title, .pr-repo,
// .pr-number, .pr-meta, .pr-actions, .badge(-red/-amber/-green/-gray),
// .btn.btn-ghost.btn-sm — so a process card sits natively among PR cards.
// A few classes are process-card-only additions, scoped under #work-list in
// index.html's CSS so they never touch render.js's cards: .proc-ai-title
// (the subordinate aiTitle line), .proc-identity (the wrapping key+repo
// block), and .proc-has-pr (the PR-backed left accent).
function procCardHTML(row, now, workspaceRoot, prPending) {
  const p = row.proc;
  const prs = row.prs;
  const s = classify(p, prs, now);
  const last = lastActivity(p, prs);
  // No diff link for a mergeado card at all: comparing a merged branch
  // against base is pointless, and its branch is usually gone from the
  // remote anyway. (diffLinksFor would already suppress the merged PR's own
  // repo via prRepoSlugs, but this also covers a multi-repo process where
  // another repo's worktree has no PR of its own.)
  const diffs = s === 'mergeado' ? [] : diffLinksFor(p, prs);

  // Title: PR title, else last commit subject, else the process key itself
  // so the card never has an empty title (see subtitleFor for why aiTitle is
  // no longer in this chain). Linked to the PR when one exists, else the
  // compare/diff URL, else plain text.
  const titleText = subtitleFor(p, prs) || p.key;
  const linkPr = prs.find(x => x.title) || prs[0] || null;
  const titleUrl = linkPr ? linkPr.url : (diffs[0] ? diffs[0].url : null);
  const titleInner = titleUrl
    ? safeLinkHTML(titleUrl, titleText, ' target="_blank" rel="noopener"')
    : escS(titleText);

  // Secondary line under the title, visibly subordinate (smaller, dimmer) —
  // a session's aiTitle, when one is attached. Helps read a card as "this is
  // a PR" (or "this is still only local") plus "here's what a session was
  // last doing here", without either being mistaken for the other.
  const aiTitle = aiTitleFor(p);
  const aiTitleHTML = aiTitle ? `<div class="proc-ai-title">${escS(aiTitle)}</div>` : '';

  const repos = [...new Set(p.worktrees.map(w => w.repo))];
  const repoLabel = repos.length ? repos.join(', ') : (p.synthetic ? 'sin worktree local' : '');

  const dirty = p.worktrees.reduce((n, w) => n + (w.dirty || 0), 0);
  // `unpushed` may be null (unknown, e.g. no base branch to diff against) on
  // any given worktree — that must not silently count as 0, but a `null` in
  // the sum must not render as NaN either. Only worktrees with a real number
  // contribute; if none do, there is nothing to show. A worktree the
  // collector has confirmed is genuinely absent from origin
  // (`onOrigin === false`) is excluded from this sum even when it does carry
  // a number — see noOriginWorktrees below for why. `onOrigin === null`
  // (undetermined) or an absent field (older cached payload) both mean
  // "unknown" and must keep counting exactly as before onOrigin existed —
  // only a confirmed `false` is excluded.
  const unpushedKnown = p.worktrees.some(w => w.onOrigin !== false && typeof w.unpushed === 'number');
  const unpushed = unpushedKnown
    ? p.worktrees.reduce((n, w) => n + (w.onOrigin !== false && typeof w.unpushed === 'number' ? w.unpushed : 0), 0)
    : null;
  const detached = p.worktrees.filter(w => w.detached).length;
  const multiWorktree = p.worktrees.length > 1;
  // Detached and prunable worktrees also carry `onOrigin: false` from the
  // collector (no branch to compare against / no directory left to
  // inspect), but for a different reason than "genuinely unpushed": neither
  // has a branch+directory pair a push command could use, and a marker/chip
  // for every prunable worktree would be noise, not signal. Only a worktree
  // that is neither of those and still confirmed absent from origin
  // qualifies for the "no está en origin" badge and push chip below.
  const noOriginWorktrees = p.worktrees.filter(w => w.onOrigin === false && !w.detached && !w.prunable);

  // Second row, right: the same badge vocabulary a PR card uses (CI, Draft,
  // ✗ Cambios / ✓ Aprobado, ⚡ Conflicts), aggregated across every PR in the
  // row, plus local worktree state and a gray timeAgo badge. No badge for
  // any of this when the row has no PR at all — there is nothing to report.
  const rightBadges = [];
  // A mergeado card's PR-status badges reduce to just "✓ Merged" — CI/Draft/
  // Aprobado/Conflicts describe an open PR's review lifecycle, none of which
  // still applies once the PR is merged. Matches render.js's own vocabulary
  // for its merged cards (see renderCard's `pr.merged` branch) rather than
  // inventing new wording or a new color.
  if (s === 'mergeado') {
    rightBadges.push('<span class="badge badge-green">✓ Merged</span>');
  } else if (prs.length) {
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
  // "no está en origin" instead of a (misleading) count — see
  // noOriginWorktrees above. One badge per qualifying worktree, repo-suffixed
  // only when the row has more than one, matching worktreeChip's convention.
  noOriginWorktrees.forEach(w => {
    const repoLabel = multiWorktree ? ` ${w.repo}` : '';
    rightBadges.push(`<span class="badge badge-gray" data-tip="La rama no existe en el remoto — nunca se pusheó, o se mergeó por squash">no está en origin${escS(repoLabel)}</span>`);
  });
  if (dirty > 0) rightBadges.push(`<span class="badge badge-gray">${dirty} sin commitear</span>`);
  rightBadges.push(`<span class="badge badge-gray">${last ? timeAgo(new Date(last)) : '—'}</span>`);

  // .pr-actions: every actionable link/chip. No "Open →" here — the title
  // already links to the PR (or the compare diff when there is no PR), and
  // that's what the owner actually clicks; render.js's own PR cards keep
  // their "Open →" since that column has no such title link. So: a diff
  // chip per repo still missing a PR, then a push chip per worktree confirmed
  // absent from origin (the actionable that pairs with the badge above —
  // pushing is what would actually let a diff/PR happen), then a resume chip
  // per session, then a cd/prune chip per worktree.
  const actions = [];
  diffs.forEach(d => {
    const label = diffs.length > 1 ? `diff ${d.repo}` : 'diff';
    actions.push(safeLinkHTML(d.url, label, ' target="_blank" rel="noopener" class="btn btn-ghost btn-sm"'));
  });
  noOriginWorktrees.forEach(w => actions.push(pushChip(w, multiWorktree)));
  // The leftover-cleanup actionable for a mergeado card: a worktree still on
  // disk for a process whose PR(s) are all merged is exactly the combination
  // worth surfacing. Skipped for a prunable worktree — its directory is
  // already gone, so `worktree remove` has nothing to act on; `git worktree
  // prune` below already covers that case.
  if (s === 'mergeado') {
    p.worktrees.forEach(w => {
      if (w.path && !w.prunable) actions.push(worktreeRemoveChip(w, workspaceRoot, multiWorktree));
    });
  }
  sessionChips(p).forEach(chip => actions.push(chip));
  p.worktrees.forEach(w => {
    const chip = worktreeChip(w, workspaceRoot, multiWorktree);
    if (chip) actions.push(chip);
  });

  // .pr-meta left: process identity — no ticket, detached-worktree count,
  // and (only when the row truly has no joined PR) the "sin PR"/"PR: —"
  // fallback, matching the same distinction the old panel drew between "no
  // PR data" and "genuinely zero PRs". Keyed off `prs.length` directly, not
  // `actions.length` — removing the "Open →" chip above means actions can
  // legitimately be empty for a PR-backed row (a PR with no local worktree
  // or session attached), and that must not be mistaken for "sin PR".
  //
  // `prPending` covers both 'loading' and 'unavailable' (see prDataState):
  // a row must not claim "sin PR" while GitHub hasn't answered yet, exactly
  // as it must not once GitHub has answered and come back empty — in both
  // cases the panel simply does not know, and "PR: —" says so honestly.
  const hasPr = prs.length > 0;
  const identity = [];
  if (!p.ticket) identity.push('<span class="badge badge-gray">sin ticket</span>');
  if (detached > 0) identity.push(`<span class="badge badge-gray">${detached} detached</span>`);
  if (!hasPr) {
    identity.push(prPending
      ? '<span class="badge badge-gray">PR: —</span>'
      : '<span class="badge badge-gray">sin PR</span>');
  }

  // A card whose work exists as a PR reads differently from one that is
  // still only on disk — a subtle left accent edge built from the existing
  // --accent token, not a new badge (the state badge already carries the
  // loud signal).
  const cardCls = hasPr ? ' proc-has-pr' : '';

  return `<div class="pr-card${cardCls}" data-proc-key="${esc(p.key)}">
    <div class="pr-top">
      <div style="margin:0;flex:1;min-width:0;">
        <div class="pr-title" style="margin:0;">${titleInner}</div>
        ${aiTitleHTML}
      </div>
      <div class="pr-badges">${procStateBadgeHTML(s)}</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
      <div class="proc-identity">
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
  // See prDataState() for the full three-way split. `prPending` covers both
  // 'loading' and 'unavailable' — the two states where a row must not claim
  // "sin PR" and PR-derived totals must not be asserted — while
  // `prShowNotice` narrows to 'unavailable' alone, the only state that is
  // actually a (possible) failure worth a notice.
  const prState = prDataState();
  const prPending = prState === 'loading' || prState === 'unavailable';
  const prShowNotice = prState === 'unavailable';
  // state.mergedPRs (recent-3-day merges, populated by loadOwnPRs in
  // render.js) carries no `merged` marker of its own — render.js adds that
  // at render time for its own compact display, which this panel no longer
  // uses. Tag copies here (never state.mergedPRs itself) so classify() and
  // procCardHTML can tell a merged PR from an open one once it's joined
  // through the very same attachment path as ownPRs.
  const mergedPRs = (typeof state !== 'undefined' && state.mergedPRs) || [];
  const taggedMerged = mergedPRs.map(pr => Object.assign({ merged: true }, pr));
  const { rows, unmatched } = attachOwnPRs(payload.processes, ownPRs.concat(taggedMerged));
  const allRows = rows.concat(synthesizeProcesses(unmatched));
  const sorted = sortProcesses(allRows, now);

  // Build the entire list first. If anything here throws, nothing has been
  // mutated yet — #work-list stays exactly as it was (empty, or showing the
  // previous good paint) instead of a half-built list.
  const listHTML = (prShowNotice ? prNoticeHTML() : '')
    + sorted.map(r => procCardHTML(r, now, payload.workspaceRoot, prPending)).join('')
    + ((payload.looseSessions || []).length ? looseRowHTML(payload.looseSessions) : '');

  const states = sorted.map(r => classify(r.proc, r.prs, now));
  const count = st => states.filter(x => x === st).length;

  const warn = payload.warnings || [];
  // While still loading, EVERY state count is provisional, not just
  // `esperando`/`mergeado` — measured second-by-second on a real machine:
  //   loading:  25 procesos ·  8 tu turno · 0 esperando · 6 en pausa · 11 fríos
  //   loaded:   31 procesos · 11 tu turno · 5 esperando · 1 en pausa ·  9 fríos
  // `turno`, `pausa` and `frio` all moved too (8→11, 6→1, 11→9): a process
  // whose PR is unreviewed leaves `pausa`/`frio` and enters `esperando` once
  // classify() sees its `prs`, and PR-backed synthesized rows add to
  // `turno`. They are not "driven by the collector's own local-activity
  // data" the way this comment used to claim — classify() reads `prs` for
  // all four buckets, and `prs` is empty for every row until ownPRs/mergedPRs
  // land. So no state count may be printed while loading; only the warning
  // count and the timestamp are collector-derived and stable.
  const metaText = prState === 'loading'
    ? `cargando PRs…` +
      (warn.length ? ` · ${warn.length} warnings` : '') +
      (payload.generatedAt ? ` · ${timeAgo(new Date(payload.generatedAt))}` : '')
    : `${sorted.length} procesos · ${count('turno')} tu turno · ${count('esperando')} esperando · ` +
      `${count('pausa')} en pausa · ${count('frio')} fríos (>${COLD_DAYS}d) · ${count('mergeado')} mergeados` +
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
      // Every real invocation — including this very first one — means
      // GitHub has answered at least once this page load. Set before
      // calling through, so the renderLocalPanel() a few lines down (and
      // any other observer of ownPRsFired) sees the post-answer state.
      ownPRsFired = true;
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
