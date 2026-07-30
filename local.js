// Local-only "procesos activos" panel.
//
// Mounts ONLY if /api/local answers. On GitHub Pages that request 404s and
// this file does nothing at all, which is what keeps the shared deploy
// byte-for-byte unchanged for everyone else.

const PROC_CACHE_KEY     = 'prq_proc_cache';
const PROC_COLLAPSED_KEY = 'prq_proc_collapsed';

const procEl = {
  section: () => document.getElementById('proc-section'),
  body:    () => document.getElementById('proc-body'),
  count:   () => document.getElementById('proc-count'),
  meta:    () => document.getElementById('proc-meta'),
  caret:   () => document.getElementById('proc-caret'),
  toggle:  () => document.getElementById('proc-toggle'),
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

function procPRsFor(proc) {
  const own = (typeof state !== 'undefined' && state.ownPRs) || [];
  return own.filter(pr => pr.headRef && proc.branches.indexOf(pr.headRef) !== -1);
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

const PROC_STATE_LABELS = { turno: 'Tu turno', esperando: 'Esperando',
                            pausa: 'En pausa', frio: 'Frío' };

function procStateLabel(s) {
  return PROC_STATE_LABELS[s] || s;
}

// `lastCommitSubject` and `aiTitle` are untrusted text (a commit subject can
// contain `<script>` or quotes; `aiTitle` is model-generated), and an older
// cached payload can hand back `null`/`undefined` for either. `esc()` has no
// type coercion and throws on non-strings, so every interpolation of these
// fields goes through this wrapper first.
function escS(v) {
  return (v === null || v === undefined) ? '' : esc(String(v));
}

// Line 2: the context subtitle. First available of the joined PR's title, an
// attached session's aiTitle, or a worktree's last commit subject — all three
// are free per the collector. `null` when none exist, so the row omits the
// line instead of rendering it empty.
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

// A click-to-copy chip. `text` is the untrusted-ish command string copied to
// the clipboard; both the visible label and the `data-copy` attribute go
// through esc()/escS(), since a data- attribute is exactly the kind of
// interpolation this feature warns about getting wrong. `title` defaults to
// `text` (the existing chips just want the full command on hover) but a
// caller can pass a richer tooltip — always still escaped here, not by the
// caller.
function copyChip(label, text, title) {
  const t = title === undefined ? text : title;
  return `<button type="button" class="proc-chip proc-copy" data-copy="${esc(text)}" title="${esc(t)}">${escS(label)}</button>`;
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

function procRowHTML(row, now, workspaceRoot) {
  const p = row.proc;
  const s = classify(p, row.prs, now);
  const last = lastActivity(p, row.prs);

  const bits = [];
  row.prs.forEach(pr => {
    const flags = [];
    if (pr.draft) flags.push('draft');
    if (pr.ci === 'failed') flags.push('CI roja');
    if (pr.ci === 'pending') flags.push('CI corriendo');
    if (pr.conflicts) flags.push('conflictos');
    if (pr.changesReq) flags.push('cambios pedidos');
    else if (pr.approved) flags.push('aprobado');
    else if ((pr.humanReviews || 0) === 0) flags.push('sin review');
    bits.push(safeLinkHTML(pr.url, '#' + pr.number, ' target="_blank"') +
      (flags.length ? ` <span class="proc-detail">${esc(flags.join(' · '))}</span>` : ''));
  });

  // A diff link is suppressed for a repo that already has a joined PR in
  // this row (see diffLinksFor) and shown otherwise — it is how you open a
  // PR for a branch that has none yet.
  const diffs = diffLinksFor(p, row.prs);
  diffs.forEach(d => {
    const label = diffs.length > 1 ? `diff ${d.repo}` : 'diff';
    bits.push(safeLinkHTML(d.url, label, ' class="proc-chip" target="_blank"'));
  });

  sessionChips(p).forEach(chip => bits.push(chip));

  const multiWorktree = p.worktrees.length > 1;
  p.worktrees.forEach(w => {
    const chip = worktreeChip(w, workspaceRoot, multiWorktree);
    if (chip) bits.push(chip);
  });

  const dirty = p.worktrees.reduce((n, w) => n + (w.dirty || 0), 0);
  if (dirty > 0) bits.push(`<span class="proc-detail">${dirty} sin commitear</span>`);

  // `unpushed` may be null (unknown, e.g. no base branch to diff against) on
  // any given worktree — that must not silently count as 0, but a `null` in
  // the sum must not render as NaN either. Only worktrees with a real number
  // contribute; if none do, there is nothing to show.
  const unpushedKnown = p.worktrees.some(w => typeof w.unpushed === 'number');
  const unpushed = unpushedKnown
    ? p.worktrees.reduce((n, w) => n + (typeof w.unpushed === 'number' ? w.unpushed : 0), 0)
    : null;
  if (unpushed > 0) bits.push(`<span class="proc-detail">${unpushed} sin pushear</span>`);

  const detached = p.worktrees.filter(w => w.detached).length;
  if (detached > 0) bits.push(`<span class="proc-detail">${detached} detached</span>`);

  const repos = [...new Set(p.worktrees.map(w => w.repo))].join(', ');
  const subtitle = subtitleFor(p, row.prs);

  return `<div class="proc-row">
    <span class="proc-state ${s}">${procStateLabel(s)}</span>
    <span>
      <span class="proc-key">${esc(p.key)}</span>${p.ticket ? '' : '<span class="proc-noticket">sin ticket</span>'}
      ${repos ? `<span class="proc-detail"> · ${esc(repos)}</span>` : ''}
      ${subtitle ? `<br><span class="proc-subtitle">${escS(subtitle)}</span>` : ''}
      <br>${bits.join(' · ') || '<span class="proc-detail">sin PR</span>'}
    </span>
    <span class="proc-detail">${last ? timeAgo(new Date(last)) : '—'}</span>
  </div>`;
}

function renderLocalPanel() {
  const payload = window.LOCAL_STATE;
  if (!payload || !payload.processes) return;

  const now = Date.now();
  mergeLooseSessions(payload);
  const rows = payload.processes.map(proc => ({ proc, prs: procPRsFor(proc) }));
  const sorted = sortProcesses(rows, now);

  // Build the entire body first. If anything here throws, nothing has been
  // mutated yet — the section stays exactly as it was (hidden, or showing the
  // previous good paint) instead of a half-built header with no body.
  const bodyHTML = sorted.map(r => procRowHTML(r, now, payload.workspaceRoot)).join('')
    + ((payload.looseSessions || []).length ? looseRowHTML(payload.looseSessions) : '');

  const states = sorted.map(r => classify(r.proc, r.prs, now));
  const count = s => states.filter(x => x === s).length;

  const warn = payload.warnings || [];
  const metaText =
    `${sorted.length} procesos · ${count('turno')} tu turno · ${count('esperando')} esperando · ` +
    `${count('pausa')} en pausa · ${count('frio')} fríos (>${COLD_DAYS}d)` +
    (warn.length ? ` · ${warn.length} warnings` : '') +
    (payload.generatedAt ? ` · ${timeAgo(new Date(payload.generatedAt))}` : '');

  procEl.body().innerHTML = bodyHTML;
  // The badge counts what needs a decision from you, not everything that exists.
  procEl.count().textContent = count('turno') || '';
  procEl.count().style.display = count('turno') > 0 ? '' : 'none';
  procEl.meta().textContent = metaText;
  // Hovering surfaces the actual warning messages — otherwise "· N warnings"
  // is a count with nowhere to see what went wrong.
  procEl.meta().title = warn.length
    ? warn.map(w => `${w.repo ? w.repo + ': ' : ''}${w.step}: ${w.message}`).join('\n')
    : '';
  procEl.section().style.display = '';
}

function applyProcCollapsed() {
  const collapsed = localStorage.getItem(PROC_COLLAPSED_KEY) === '1';
  procEl.body().classList.toggle('hidden', collapsed);
  procEl.caret().textContent = collapsed ? '▸' : '▾';
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

// One delegated listener on the panel body handles every copy chip, current
// and future — renderLocalPanel() replaces innerHTML on every repaint, which
// would stack a listener per row per paint if attached directly to buttons.
function installCopyDelegation() {
  procEl.body().addEventListener('click', (e) => {
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
// The cached paint and the fetched paint both go through here, so the
// collapse preference is applied from the very first frame and the toggle is
// never rendered without its listener.
function mountPanel() {
  renderLocalPanel();
  applyProcCollapsed();
  if (procMounted) return;
  procMounted = true;

  procEl.toggle().addEventListener('click', () => {
    const collapsed = localStorage.getItem(PROC_COLLAPSED_KEY) === '1';
    localStorage.setItem(PROC_COLLAPSED_KEY, collapsed ? '0' : '1');
    applyProcCollapsed();
  });

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

// The panel must never survive a failed fetch. A stale cached payload
// rendered as if it were current is worse than no panel at all — this
// feature exists to say which work is actually fresh.
function unmountPanel() {
  window.LOCAL_STATE = null;
  procEl.body().innerHTML = '';
  procEl.count().textContent = '';
  procEl.meta().textContent = '';
  procEl.section().style.display = 'none';
}

// mountPanel() can throw mid-build (e.g. a malformed row). Never let that
// leave a half-mounted header on screen — fall back to a clean unmount.
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
