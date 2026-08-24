// The "Trabajo activo" panel: one card per process inside #own-column,
// reusing the same .pr-card CSS the old "Mis PRs" list used.
//
// It mounts ALWAYS, sidecar or no sidecar. When /api/local answers, a card is
// a process: worktrees + Claude sessions + the PRs joined onto them. When it
// doesn't (the deployed static page), the payload is emptyLocalPayload() and
// every row comes out of synthesizeProcesses() — grouped by ticket, classified,
// sorted and filtered by exactly the same pure code in classify.js, just with
// nothing local to attach. That is the whole difference between the two
// deploys now: the local-only affordances (cd/push/resume chips, aiTitle,
// loose sessions, warnings, mission cards) are absent, and the con PR/sin PR
// split is hidden because it cannot partition a list where every row is a PR.
//
// unmountPanel() survives as the crash fallback only: if a render throws, the
// column falls back to render.js's flat PR list rather than going blank.

const PROC_CACHE_KEY = 'prq_proc_cache';

// What window.LOCAL_STATE holds when there is no sidecar. Every collector-fed
// field is present and empty rather than absent, so nothing downstream needs a
// "did the sidecar answer" branch: attachOwnPRs([], prs) matches nothing,
// synthesizeProcesses() turns every PR into its own row, and the worktree /
// session / warning / generatedAt segments of the card and meta line drop out
// on their own because there is nothing to iterate.
//
// `local: false` is the one explicit marker, and only one thing reads it: the
// "sin worktree local" note, which is news on a machine that has local work and
// noise on every card of a page that can never have any.
//
// A factory, not a frozen constant: renderLocalPanel's very first act is
// mergeLooseSessions(payload), which assigns payload.looseSessions. Against a
// frozen object that write fails — silently in this file's sloppy mode, loudly
// the day anything here becomes a module — and a shared mutable object would
// carry state across mounts. A fresh one per call is neither.
function emptyLocalPayload() {
  return { local: false, processes: [], looseSessions: [], warnings: [],
           workspaceRoot: null, generatedAt: null };
}

// Whether the payload carries local work at all. An older cached payload has
// no `local` field and is real collector output, so absent means true — only
// an explicit `false` (emptyLocalPayload) means "there is no sidecar".
function hasLocalPayload(payload) {
  return !!payload && payload.local !== false;
}

// Whether the real (unwrapped) window.renderOwnPRs has fired at least once
// since this page load. Flipped inside mountPanel()'s wrap, never reset —
// GitHub PR data (state.ownPRs / state.mergedPRs) arrives several seconds
// after the local collector's payload, and this is the only signal the panel
// has for "GitHub hasn't answered yet" vs. "GitHub answered and it's empty".
// See prDataState() for the three-way state this feeds.
let ownPRsFired = false;

// True while the panel is painted from the localStorage cache, false once
// the fresh /api/local payload has replaced it. A cached payload can predate
// the drain pushing a branch, so diffLinksFor (below) treats an unconfirmed
// onOrigin as "no link" only while this is true — see compareLinkAllowed in
// mission.js for the rule itself. Set in initLocalPanel(); left untouched
// (still true) if the fresh fetch fails, since window.LOCAL_STATE then stays
// the stale cached payload.
let payloadFromCache = false;

// Which of the two chips is on: 'con', 'sin', or PR_FILTER_ALL (null) for
// neither, which means todos. Module-level rather than read off the DOM
// because renderLocalPanel() runs again every time GitHub answers — the
// selection has to survive a repaint it didn't cause. Reset by unmountPanel(),
// and dropped whenever PR data is unavailable (see renderLocalPanel).
let prFilter = PR_FILTER_ALL;

// Hides every mission-control card when set to 'off'; null (default) shows
// them. Module-level and reset by unmountPanel() for the same reason
// prFilter is.
let mcFilter = null;

// The second row's selection: 'abierto', 'draft', or PR_FILTER_ALL. Only ever
// meaningful while prFilter === 'con' — renderLocalPanel() clears it whenever
// that stops being true, so it can never keep filtering from behind a hidden
// row.
let prStatusFilter = PR_FILTER_ALL;

// The mission poll's own timer handle and stop flag. Declared here (not
// beside initMissionPanel() near the bottom of the file) because
// unmountPanel() — defined and reachable well before initMissionPanel() is
// even called — calls stopMissionPoll() synchronously on the very first,
// pre-`await` line of initLocalPanel() when a corrupt/absent cache makes
// mountPanelSafely() throw. A `let` declared after that call site would
// still be in its TDZ at that point and throw a ReferenceError instead of
// cleanly no-op'ing.
let missionPollTimer = null;
let missionPollStopped = false;

// unmountPanel() calls this: once the panel is gone for this page load,
// firing fetches on a timer forever serves nobody. Idempotent — safe to call
// whether or not a poll is currently scheduled.
function stopMissionPoll() {
  missionPollStopped = true;
  if (missionPollTimer !== null) { clearTimeout(missionPollTimer); missionPollTimer = null; }
}

// Fallback only: used if a fetch fails outright (no response at all, so no
// header to read) or against an older sidecar build that doesn't send
// x-mission-ttl-ms yet. Matches bin/mission.js's DEFAULT_TTL_MS today, but
// this file has no way to import that Node-only module, so the real number
// comes from the header on every successful response instead of living here
// twice.
const DEFAULT_MISSION_POLL_MS = 60000;

const PR_MODES = ['con', 'sin'];
const PR_STATUS_MODES = ['abierto', 'draft'];

const procEl = {
  workList:    () => document.getElementById('work-list'),
  columnTitle: () => document.getElementById('own-column-title'),
  metaLine:    () => document.getElementById('proc-meta-line'),
  filterRow:   () => document.getElementById('proc-filter'),
  filterMainRow: () => document.getElementById('proc-filter-main'),
  statusRow:   () => document.getElementById('proc-filter-status'),
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
// only a confirmed `false` suppresses the link — but only while `fromCache`
// is false: the panel paints from the localStorage cache before the fresh
// payload lands, and a cached snapshot can predate the drain pushing the
// branch. compareLinkAllowed (mission.js) is the actual rule; here we just
// hand it the worktree and the cache flag.
//
// A worktree whose link is withheld only for that cache-uncertainty reason
// (not a confirmed `onOrigin === false`, which already gets its push chip
// from noOriginWorktrees in procCardHTML) is collected into `pushFallbacks`
// so the caller can offer the push chip in the link's place — the panel is
// read-only, but "push this yourself" is a truthful substitute for a link
// GitHub can't resolve.
function diffLinksFor(p, prs, fromCache) {
  const seen = new Set();
  const links = [];
  const pushFallbacks = [];
  const prRepos = prRepoSlugs(prs);
  p.worktrees.forEach(w => {
    if (seen.has(w.repo) || w.detached || w.prunable) return;
    if (!compareLinkAllowed(w, fromCache)) {
      if (w.onOrigin !== false && w.path && w.branch) pushFallbacks.push(w);
      return;
    }
    if (!w.githubRepo || !w.baseBranch || !w.branch) return;
    seen.add(w.repo);
    if (prRepos.has(w.githubRepo.toLowerCase())) return;
    links.push({ repo: w.repo, url: `https://github.com/${w.githubRepo}/compare/${w.baseBranch}...${w.branch}` });
  });
  return { links, pushFallbacks };
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

// The one case where an empty #work-list is not a bug and not "no hay
// trabajo": a filter is on and nothing matched it. Without this the column
// goes blank and reads as a broken panel — the same failure mode the "sin PR"
// badge avoids by never being silent.
function filterEmptyHTML(label) {
  return `<div class="proc-notice">Ningún proceso ${escS(label)} — el resto está escondido por el filtro.</div>`;
}

// What the active filter is keeping, as one phrase: 'con PR', 'sin PR',
// 'con PR abierto', 'con PR draft'. Used by both the empty-result notice and
// the meta line, so the two can never describe the same filter differently.
function filterLabel() {
  // The status row can be the only row on screen (see renderFilterChips: the
  // con/sin split is hidden when every row has a PR), so a selected status
  // with no con/sin selection is a real, active filter — not the off state it
  // used to be. It still describes itself as "con PR <status>", because that
  // is what it keeps.
  if (prFilter === PR_FILTER_ALL) {
    return prStatusFilter === PR_FILTER_ALL ? '' : `con PR ${prStatusFilter}`;
  }
  const base = `${prFilter} PR`;
  return prStatusFilter === PR_FILTER_ALL ? base : `${base} ${prStatusFilter}`;
}

// Paints one row of chips against `selected`, with the row count each chip
// would show. `disabled` mirrors prPending: with no PR data the counts would
// read "0 con PR" for a machine full of open PRs, so the numbers are blanked
// rather than printed as facts — the same rule the meta line follows while
// loading. Only ever updates existing nodes (never innerHTML), so the single
// delegated listener installed in mountPanel() keeps working across repaints.
function paintChipRow(row, selector, dataKey, selected, counts, disabled) {
  row.querySelectorAll(selector).forEach(chip => {
    const mode = chip.dataset[dataKey];
    chip.classList.toggle('selected', selected === mode);
    chip.disabled = !!disabled;
    chip.title = disabled ? 'Esperando el estado de los PRs de GitHub' : '';
    const countEl = chip.querySelector('.proc-chip-count');
    if (countEl) countEl.textContent = disabled ? '' : String(counts[mode]);
  });
}

// Both rows. The second one is only shown while "con PR" is the active
// filter — its counts are over the con-PR rows alone, since that's the set it
// narrows — and is hidden (not merely emptied) otherwise, so it can never
// suggest a choice that wouldn't apply to anything.
//
// The `mc` chip is furniture for a source that doesn't exist yet for a
// teammate who never installed mission-control: gate it on `mcAvailable`
// (not on `disabled`, which is about GitHub PR data) so the row stays
// pixel-identical to pre-Task-6 for that teammate instead of shipping a
// clickable chip with nothing behind it.
// `splitMeaningful` (prSplitIsMeaningful in classify.js) decides whether the
// con PR / sin PR chips exist at all. On the static deploy every row is
// synthesized from a PR, so "sin PR" is always empty and "con PR" is the whole
// list: two chips that cannot change what you see, which reads as a broken
// filter rather than an inapplicable one. They are hidden, and the
// abierto/draft row is promoted to stand on its own — unindented, and shown
// without waiting for a con/sin selection that can no longer be made.
function renderFilterChips(counts, statusCounts, disabled, mcAvailable, splitMeaningful) {
  const row = procEl.filterRow();
  if (!row) return;
  row.classList.remove('hidden');
  paintChipRow(row, '.proc-chip[data-pr-filter]', 'prFilter', prFilter, counts, disabled);
  const splitOn = !!splitMeaningful;
  row.querySelectorAll('.proc-chip[data-pr-filter]')
     .forEach(chip => chip.classList.toggle('hidden', !splitOn));
  const mcChip = row.querySelector('.proc-chip[data-mc-filter]');
  if (mcChip) mcChip.classList.toggle('hidden', !mcAvailable);
  // With every chip in it hidden the row is an empty flex box that still eats
  // the parent's 6px gap, so it goes away as a row rather than as three
  // invisible children.
  const mainRow = procEl.filterMainRow();
  if (mainRow) mainRow.classList.toggle('hidden', !splitOn && !mcAvailable);

  const statusRow = procEl.statusRow();
  if (!statusRow) return;
  const showStatus = (prFilter === 'con' || !splitOn) && !disabled;
  statusRow.classList.toggle('hidden', !showStatus);
  // Indented only while it is subordinate to a visible "con PR" chip.
  statusRow.classList.toggle('proc-filter-sub', splitOn);
  if (showStatus) {
    paintChipRow(statusRow, '.proc-chip[data-pr-status]', 'prStatus', prStatusFilter, statusCounts, false);
  } else {
    resetChipRow(statusRow);
  }
}

// Back to how index.html ships a row: nothing selected, nothing disabled, no
// counts, no tooltip. Used both when the status row goes away and by
// unmountPanel(), so a re-mount can never inherit a stale-looking chip.
function resetChipRow(row) {
  row.querySelectorAll('.proc-chip').forEach(chip => {
    chip.classList.remove('selected');
    // No chip ships hidden in index.html — only the mc chip is ever hidden
    // individually (see renderFilterChips), so clearing it here is safe for
    // every other chip and undoes that one on unmount/reset.
    chip.classList.remove('hidden');
    chip.disabled = false;
    chip.title = '';
    const countEl = chip.querySelector('.proc-chip-count');
    if (countEl) countEl.textContent = '';
  });
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
// `hasLocal` says whether the payload came from a sidecar at all (see
// hasLocalPayload). It gates only the "sin worktree local" note: on a page
// that can never have a worktree, printing it on every card states the
// obvious once per row.
function procCardHTML(row, now, workspaceRoot, prPending, stitched, hasLocal) {
  const p = row.proc;
  const prs = row.prs;
  const s = classify(p, prs, now);
  const last = lastActivity(p, prs);
  // No diff link for a mergeado card at all: comparing a merged branch
  // against base is pointless, and its branch is usually gone from the
  // remote anyway. (diffLinksFor would already suppress the merged PR's own
  // repo via prRepoSlugs, but this also covers a multi-repo process where
  // another repo's worktree has no PR of its own.)
  const diffResult = s === 'mergeado' ? { links: [], pushFallbacks: [] } : diffLinksFor(p, prs, payloadFromCache);
  const diffs = diffResult.links;

  // Title: PR title, else last commit subject, else the process key itself
  // so the card never has an empty title (see subtitleFor for why aiTitle is
  // no longer in this chain). Linked to the PR when one exists, else the
  // compare/diff URL, else plain text.
  const titleText = subtitleFor(p, prs) || p.key;
  const linkPr = prs.find(x => x.title) || prs[0] || null;
  const titleUrl = linkPr ? linkPr.url : (diffs[0] ? diffs[0].url : null);
  // `data-pr-id` is what the mark-as-read delegation keys off (see
  // installActivityDelegation): opening a PR is the act of reading it, exactly
  // as it was in the flat list. Only the PR the title actually links to gets
  // marked — a multi-repo row's other PRs were not opened. Number() so a
  // hostile/garbled id can never become an attribute payload; NaN drops the
  // attribute entirely rather than emitting `data-pr-id="NaN"`.
  const titleId = linkPr && Number.isFinite(Number(linkPr.id)) ? Number(linkPr.id) : null;
  const titleAttrs = ' target="_blank" rel="noopener"' +
    (titleId === null ? '' : ` data-pr-id="${titleId}"`);
  const titleInner = titleUrl
    ? safeLinkHTML(titleUrl, titleText, titleAttrs)
    : escS(titleText);

  // Secondary line under the title, visibly subordinate (smaller, dimmer) —
  // a session's aiTitle, when one is attached. Helps read a card as "this is
  // a PR" (or "this is still only local") plus "here's what a session was
  // last doing here", without either being mistaken for the other.
  const aiTitle = aiTitleFor(p);
  const aiTitleHTML = aiTitle ? `<div class="proc-ai-title">${escS(aiTitle)}</div>` : '';

  // Every repo this process touches, PR numbers included — see
  // processRepoLabel. It used to be the worktree repos alone, which on the
  // static deploy names nothing at all (there are no worktrees) and even with
  // a sidecar dropped the `#number` that render.js's flat list always showed.
  // The old "sin worktree local" text that used to fill this slot for a
  // worktree-less row moved into an `identity` badge below, where it no longer
  // competes with that information.
  const repoLabel = processRepoLabel(p.worktrees, prs);

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
  // Unseen comments and reviews across the row (rowNewActivity in classify.js),
  // read by the eye badge below and by the corner dot on the card itself.
  const act = rowNewActivity(row);
  const rightBadges = [];
  // A mergeado card's PR-status badges reduce to just "✓ Merged" — CI/Draft/
  // Aprobado/Conflicts describe an open PR's review lifecycle, none of which
  // still applies once the PR is merged. Matches render.js's own vocabulary
  // for its merged cards (see renderCard's `pr.merged` branch) rather than
  // inventing new wording or a new color.
  if (s === 'mergeado') {
    rightBadges.push('<span class="badge badge-green">✓ Merged</span>');
  } else if (prs.length) {
    // Diff size first, matching the reading order of render.js's own card
    // (size/lines, then CI, then review state). Only ever present for a
    // single-PR row — see rowSizeStats for why a multi-repo row gets none —
    // and never on a mergeado card, whose diff is no longer a decision.
    const size = rowSizeStats(row);
    if (size) {
      rightBadges.push(sizeBadgeHTML(size.lines));
      rightBadges.push(lineCountHTML(size.lines, size.additions, size.deletions));
    }
    const ci = prs.some(x => x.ci === 'failed')  ? 'failed'
             : prs.some(x => x.ci === 'pending') ? 'pending'
             : prs.some(x => x.ci === 'green')   ? 'green' : 'unknown';
    rightBadges.push(ciBadge(ci));
    // Unseen human comments, summed over the row. classify() already reads the
    // same counter to put the card in TU TURNO, but the state badge only says
    // *that* it's your move — this says how much is waiting. render.js's flat
    // card had this and nothing in the panel replaced it, so replacing that
    // list without it would have quietly dropped the count.
    if (act.comments > 0) {
      rightBadges.push(`<span class="badge badge-blue" data-tip="${act.comments} comentario${act.comments > 1 ? 's' : ''} sin leer">👁 ${act.comments}</span>`);
    }
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

  // Stitched from mission-control: the question and the lease belong on the
  // card of the work they describe, not in a separate list.
  const stitchedHTML = !stitched ? '' :
    (stitched.lease ? `<div class="proc-detail">🔒 lease: ${escS(stitched.lease.forWhat || 'tomado')} · vence en ${escS(stitched.lease.minutesLeft)}m</div>` : '')
    + stitched.questions.map(q => `<div class="proc-detail">❓ ${escS(q.item.question)}</div>`
        + (q.item.options || []).map(o => `<div class="proc-detail">· ${escS(o.label)} — ${escS(o.description || '')}</div>`).join('')).join('');

  // .pr-actions: every actionable link/chip. No "Open →" here — the title
  // already links to the PR (or the compare diff when there is no PR), and
  // that's what the owner actually clicks; render.js's own PR cards keep
  // their "Open →" since that column has no such title link. So: a diff
  // chip per repo still missing a PR, then a push chip per worktree confirmed
  // absent from origin (the actionable that pairs with the badge above —
  // pushing is what would actually let a diff/PR happen) or one whose diff
  // link diffLinksFor withheld only because the cached payload couldn't
  // confirm onOrigin, then a resume chip per session, then a cd/prune chip
  // per worktree.
  const actions = [];
  diffs.forEach(d => {
    const label = diffs.length > 1 ? `diff ${d.repo}` : 'diff';
    actions.push(safeLinkHTML(d.url, label, ' target="_blank" rel="noopener" class="btn btn-ghost btn-sm"'));
  });
  noOriginWorktrees.forEach(w => actions.push(pushChip(w, multiWorktree)));
  diffResult.pushFallbacks.forEach(w => actions.push(pushChip(w, multiWorktree)));
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
  // A PR with nothing checked out for it is worth flagging on a machine that
  // does have worktrees — it's work you can't resume without cloning it first.
  // On the static deploy it is true of every row by construction, so it says
  // nothing and is left out entirely (see procCardHTML's `hasLocal`).
  if (hasLocal && p.synthetic) identity.push('<span class="badge badge-gray">sin worktree local</span>');
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

  // The same unseen-review dot render.js's flat card used: a review is a
  // decision someone made about your work, and it should read before the
  // badges do. Reviews, not comments — the eye badge covers those.
  //
  // It sits INSIDE .pr-badges rather than absolutely positioned at the card's
  // top-right corner the way render.js places it: that corner is where a
  // process card puts its state badge, so the two would overlap. Scoped CSS in
  // index.html (#work-list .new-review-dot) turns off the absolute positioning
  // for this one placement.
  const reviewDot = act.reviews > 0
    ? '<span class="new-review-dot" data-tip="Review nuevo sin ver"></span>' : '';

  return `<div class="pr-card${cardCls}" data-proc-key="${esc(p.key)}">
    <div class="pr-top">
      <div style="margin:0;flex:1;min-width:0;">
        <div class="pr-title" style="margin:0;">${titleInner}</div>
        ${aiTitleHTML}
      </div>
      <div class="pr-badges">${reviewDot}${procStateBadgeHTML(s)}</div>
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
      ${stitchedHTML}
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

  // While PR data is pending, every row looks "sin PR" whether it is or not —
  // so a chip selection is dropped instead of quietly filtering on data the
  // panel doesn't have. In practice this only fires if GitHub errors on a
  // later repaint ('unavailable'); the initial 'loading' paint happens before
  // there is anything to click.
  if (prPending) prFilter = PR_FILTER_ALL;
  // Whether the con PR / sin PR chips are on screen at all. Degenerate (and so
  // hidden) whenever every row has a PR — always the case with no sidecar. The
  // selection is dropped along with the chips, so a row that cannot be clicked
  // can never keep filtering from behind.
  const splitMeaningful = prSplitIsMeaningful(sorted) && !prPending;
  if (!splitMeaningful) prFilter = PR_FILTER_ALL;
  // The status row only narrows "con PR" — except when the con/sin row is
  // hidden, where it stands on its own and its selection is the only filter
  // there is. Outside those two cases the selection is dropped, so a hidden
  // row can never keep filtering the list from behind the scenes.
  if (splitMeaningful && prFilter !== 'con') prStatusFilter = PR_FILTER_ALL;
  if (prPending) prStatusFilter = PR_FILTER_ALL;
  const filterActive = prFilter !== PR_FILTER_ALL || prStatusFilter !== PR_FILTER_ALL;
  const withPR = filterRowsByPR(sorted, prFilter);
  const visible = filterRowsByPRStatus(withPR, prStatusFilter);
  const conCount = sorted.filter(rowHasPR).length;
  const filterCounts = { con: conCount, sin: sorted.length - conCount };
  // Counted over the con-PR rows, which is the set these chips narrow. They
  // can sum to less than `con` (a mergeado row is neither abierto nor draft)
  // and can overlap (a multi-repo process with a draft in one repo and a ready
  // PR in another is both) — the numbers on the chips are what make that
  // legible instead of surprising.
  const statusCounts = {
    abierto: withPR.filter(rowHasOpenPR).length,
    draft:   withPR.filter(rowHasDraftPR).length,
  };
  const hasLocal = hasLocalPayload(payload);

  // mission-control's cards are fetched independently (initMissionPanel) and
  // may not have arrived yet, or may be off entirely — both render the panel
  // exactly as it looked before Task 6 existed, never a blank list.
  const mission = window.MISSION_STATE || null;
  // Stitched against `visible`, not `sorted`: a question whose processKey
  // belongs to a process the PR-chip filters (con PR / sin PR / abierto /
  // draft) hid still gets matched-off by stitchMission over the wider set,
  // but its process card is never painted — the question would exist
  // nowhere on screen. stitch.perKey is only read per RENDERED row below, so
  // narrowing the input set to what's actually visible changes nothing else.
  const stitch = stitchMission(mission, visible);
  const mcCards = mission ? missionCards(Object.assign({}, mission, { matchedAskIds: stitch.matchedAskIds })) : [];
  const mcHidden = mcFilter === 'off';
  const topCards = mcHidden ? '' : mcCards.filter(c => c.slot === 'top').map(missionCardHTML).join('');
  const bottomCards = mcHidden ? '' : mcCards.filter(c => c.slot === 'bottom').map(missionCardHTML).join('');

  // Build the entire list first. If anything here throws, nothing has been
  // mutated yet — #work-list stays exactly as it was (empty, or showing the
  // previous good paint) instead of a half-built list.
  //
  // The loose-sessions row is only shown with the filter off: it isn't a
  // process and has no joined PR, so filing it under either chip would be a
  // claim the panel can't back.
  const listHTML = topCards
    + (prShowNotice ? prNoticeHTML() : '')
    + (filterActive && !visible.length ? filterEmptyHTML(filterLabel()) : '')
    + visible.map(r => procCardHTML(r, now, payload.workspaceRoot, prPending, stitch.perKey[r.proc.key] || null, hasLocal)).join('')
    + ((!filterActive && (payload.looseSessions || []).length) ? looseRowHTML(payload.looseSessions) : '')
    + bottomCards;

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
      // Every count above stays a total over all processes, filter or no
      // filter — they're the panel's answer to "what's in flight", and
      // silently recomputing them over a filtered subset would turn the same
      // line into a different question. The filter says what's on screen
      // instead.
      (filterActive ? ` · mostrando ${visible.length} ${filterLabel()}` : '') +
      (warn.length ? ` · ${warn.length} warnings` : '') +
      (payload.generatedAt ? ` · ${timeAgo(new Date(payload.generatedAt))}` : '');

  procEl.workList().innerHTML = listHTML;
  // Checked directly against status rather than trusting `mission` to always
  // exclude 'off' (which initMissionPanel happens to guarantee today) — the
  // chip's visibility rule shouldn't silently depend on that staying true.
  renderFilterChips(filterCounts, statusCounts, prPending, !!(mission && mission.status !== 'off'), splitMeaningful);
  // The badge next to the heading counted render.js's open own-PRs; with the
  // panel always mounted the list under it is cards, so the badge counts those
  // instead. Set after renderFilterChips and before the meta line for no
  // reason beyond keeping the DOM writes together; renderOwnPRs sets the same
  // node first on every GitHub answer, and this always runs after it (the wrap
  // calls through, then repaints).
  const countBadge = document.getElementById('own-count');
  if (countBadge) {
    countBadge.textContent = sorted.length > 0 ? String(sorted.length) : '';
    countBadge.style.display = sorted.length > 0 ? '' : 'none';
  }
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

// One delegated listener on #proc-filter covering both rows, for the same
// reason the copy chips get one: the chips themselves are only repainted
// (never rebuilt), but delegating keeps the wiring in one place and immune to
// any future rebuild. nextChipFilter() owns the toggle semantics for both
// rows — clicking the lit chip turns it off (todos), clicking another one
// turns the previous one off.
function installFilterDelegation() {
  procEl.filterRow().addEventListener('click', (e) => {
    const chip = e.target.closest('.proc-chip[data-pr-filter], .proc-chip[data-pr-status], .proc-chip[data-mc-filter]');
    if (!chip || chip.disabled) return;
    if (chip.dataset.mcFilter) {
      mcFilter = mcFilter === 'off' ? null : 'off';
      chip.classList.toggle('selected', mcFilter === 'off');
      renderLocalPanel();
      return;
    }
    if (chip.dataset.prFilter) {
      prFilter = nextChipFilter(prFilter, chip.dataset.prFilter, PR_MODES);
    } else {
      prStatusFilter = nextChipFilter(prStatusFilter, chip.dataset.prStatus, PR_STATUS_MODES);
    }
    renderLocalPanel();
  });
}

// Opening a PR from its card is the act of reading it — the same rule
// render.js's flat list followed, ported here because replacing that list
// without it would leave the 👁 count and the review dot with no way to ever
// clear, and TU TURNO permanently stuck on a comment already read.
//
// Delegated on #work-list for the same reason the copy chips are: every
// repaint replaces its innerHTML. Writes through state.ownActivity /
// saveOwnActivity (both globals from render.js) so the seen-set is the very
// same one enrichOwnPR reads on the next poll — otherwise the counters would
// come straight back.
function installActivityDelegation() {
  procEl.workList().addEventListener('click', (e) => {
    const link = e.target.closest('a[data-pr-id]');
    if (!link) return;
    const id = Number(link.dataset.prId);
    const pr = (state.ownPRs || []).find(p => p.id === id);
    // A merged PR (from state.mergedPRs) has no comment/review ids to store
    // and no counters to clear, so there is deliberately nothing to do.
    if (!pr) return;
    state.ownActivity[id] = { commentIds: pr.allCommentIds || [],
                              reviewIds:  pr.allReviewIds  || [] };
    saveOwnActivity();
    pr.newComments = 0; pr.newApprovals = 0; pr.newChanges = 0;
    renderLocalPanel();
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
  installFilterDelegation();
  installActivityDelegation();
}

// The renderOwnPRs wrap, installed at file load rather than on mount — it is
// the only signal for "GitHub has answered at least once" (see prDataState) and
// it depends on nothing the payload provides.
//
// It used to live inside mountPanel(), which meant it was installed only after
// the /api/local fetch resolved. With a sidecar that ordering held by luck (the
// collector answers in milliseconds, loadOwnPRs takes several round trips), but
// the panel now also mounts on the *failure* path — and a failing fetch against
// a static host can easily lose that race, leaving ownPRsFired false forever
// and the meta line stuck on "cargando PRs…". Installing it eagerly removes the
// race instead of relying on winning it. Safe to call before any payload
// exists: renderLocalPanel() returns immediately while window.LOCAL_STATE is
// null.
function installOwnPRsWrap() {
  if (typeof window.renderOwnPRs !== 'function' || window.renderOwnPRs.__procWrapped) return;
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

installOwnPRsWrap();

// The panel must never survive a failed fetch, and a bug in it must never
// cost the user sight of their own PRs. A stale cached payload rendered as
// if it were current is worse than no panel at all — this restores
// #own-column to exactly its pre-mount state: "Mis PRs" heading, empty
// #work-list, PR list visible, 2fr/1fr grid.
function unmountPanel() {
  window.LOCAL_STATE = null;
  // Mirrors LOCAL_STATE: leaving mission-control's payload behind here would
  // let a later poll repaint stitched detail from a fetch that predates the
  // unmount instead of starting clean.
  window.MISSION_STATE = null;
  // Deliberately NOT stopping the mission poll here. This function has two
  // callers and only one of them is terminal: mountPanelSafely() unmounts on
  // any mount throw — including one from a stale cached payload, moments
  // before the fresh fetch mounts cleanly. Latching the poll off here meant a
  // single recoverable failure silently cost the mission cards for the whole
  // page load. The poll is stopped from the sidecar-gone path instead.
  procEl.workList().innerHTML = '';
  procEl.metaLine().textContent = '';
  procEl.metaLine().title = '';
  procEl.metaLine().classList.add('hidden');
  // The chips are panel-only furniture and must leave no trace on the
  // unmounted column — back to hidden, unselected, enabled and countless,
  // exactly as index.html ships them.
  prFilter = PR_FILTER_ALL;
  prStatusFilter = PR_FILTER_ALL;
  mcFilter = null;
  const filterRow = procEl.filterRow();
  if (filterRow) {
    filterRow.classList.add('hidden');
    resetChipRow(filterRow);
  }
  // Both inner rows go back to how index.html ships them: the main row shown
  // (its own parent is what hides it), the status row hidden and indented.
  const mainRow = procEl.filterMainRow();
  if (mainRow) mainRow.classList.remove('hidden');
  const statusRow = procEl.statusRow();
  if (statusRow) {
    statusRow.classList.add('hidden');
    statusRow.classList.add('proc-filter-sub');
  }
  // The heading badge counted cards while the panel was up; hand it back to
  // the number render.js's own list shows under it.
  const countBadge = document.getElementById('own-count');
  if (countBadge) {
    const n = (typeof state !== 'undefined' && state.ownPRs) ? state.ownPRs.length : 0;
    countBadge.textContent = n > 0 ? String(n) : '';
    countBadge.style.display = n > 0 ? '' : 'none';
  }
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

const HINT_DISMISS_KEY = 'prq_sidecar_hint_dismissed';

function showSidecarHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem(HINT_DISMISS_KEY) === '1'; } catch { /* modo privado */ }
  if (!shouldShowSidecarHint({ fetchFailed: true, dismissed })) return;
  const el = document.getElementById('sidecar-hint');
  if (!el) return;
  el.classList.remove('hidden');
  const btn = document.getElementById('sidecar-hint-dismiss');
  if (btn) btn.addEventListener('click', () => {
    el.classList.add('hidden');
    try { localStorage.setItem(HINT_DISMISS_KEY, '1'); } catch { /* quota */ }
  });
}

async function initLocalPanel() {
  try {
    const cached = localStorage.getItem(PROC_CACHE_KEY);
    if (cached) { payloadFromCache = true; window.LOCAL_STATE = JSON.parse(cached); mountPanelSafely(); }
  } catch { /* ignore a corrupt cache */ }

  let payload;
  try {
    const res = await fetch('/api/local', { cache: 'no-store' });
    if (!res.ok) throw new Error('no sidecar');
    payload = await res.json();
    if (!payload || !Array.isArray(payload.processes)) throw new Error('bad payload');
  } catch {
    // No sidecar (or it broke). This used to unmount the panel and hand the
    // column back to render.js's flat PR list; now it mounts the panel over an
    // empty local payload instead, so the deployed page gets the whole
    // PR-derived half of the view — cards grouped by ticket, states, ordering
    // and the abierto/draft filter — and only the local affordances are
    // missing. Everything downstream is the same code path as with a sidecar.
    //
    // The cached payload is dropped rather than kept: a stale worktree list
    // rendered as if it were current is the one thing worse than no worktree
    // list at all, and that was the whole reason this branch unmounted before.
    // payloadFromCache goes back to false along with it — there is no cached
    // payload in play any more, so nothing should be suppressed as if there
    // were (compareLinkAllowed).
    window.LOCAL_STATE = emptyLocalPayload();
    payloadFromCache = false;
    mountPanelSafely();
    // No sidecar means nothing will ever answer /api/mission either — a
    // ticking fetch against a 404 helps nobody.
    stopMissionPoll();
    showSidecarHint();
    return;
  }

  payloadFromCache = false;
  window.LOCAL_STATE = payload;
  try { localStorage.setItem(PROC_CACHE_KEY, JSON.stringify(payload)); } catch { /* quota */ }

  mountPanelSafely();
}

initLocalPanel();

// One fetch-and-render pass. Returns the interval (ms) the next pass should
// wait, taken from the sidecar's x-mission-ttl-ms header so this file never
// hardcodes a second copy of bin/mission.js's TTL that could drift out of
// sync with it.
async function pollMissionOnce() {
  try {
    const res = await fetch('/api/mission', { cache: 'no-store' });
    if (!res.ok) return DEFAULT_MISSION_POLL_MS;
    const headerMs = Number(res.headers.get('x-mission-ttl-ms'));
    const pollMs = Number.isFinite(headerMs) && headerMs > 0 ? headerMs : DEFAULT_MISSION_POLL_MS;
    const payload = await res.json();
    if (!payload || payload.status === 'off') return pollMs;
    window.MISSION_STATE = payload;
    if (window.LOCAL_STATE) mountPanelSafely();
    return pollMs;
  } catch {
    // A failed pass is not the end of the poll: retry at the default
    // interval, and if the sidecar comes back the next pass reads its real
    // TTL from the header again. The one case where no next pass happens is
    // initLocalPanel's sidecar-gone path, which stops the poll outright —
    // there the hint, not a retry, is the answer.
    return DEFAULT_MISSION_POLL_MS;
  }
}

// Fetched separately from /api/local on purpose: mc's `work` source carries
// 180s internal timeouts, so coupling both into one payload would leave the
// whole panel blank whenever one source is slow.
//
// Polls on an interval instead of fetching once: a page left open against a
// stale snapshot shows "refrescando en segundo plano; la próxima pasada
// trae lo nuevo" on the mission card (missionCard() in mission.js) — a
// promise that was false until this loop existed, because nothing ever
// fetched that next pass. `missionPollStopped` (set by unmountPanel) is
// re-checked after every await, so a poll already in flight when the panel
// dies still finishes cleanly instead of scheduling one more.
async function initMissionPanel() {
  if (missionPollStopped) return;
  const pollMs = await pollMissionOnce();
  if (missionPollStopped) return;
  missionPollTimer = setTimeout(initMissionPanel, pollMs);
}

initMissionPanel();
