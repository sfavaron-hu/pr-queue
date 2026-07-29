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
    const link = s.prLink && s.prLink.url
      ? ` <a href="${esc(s.prLink.url)}" target="_blank">#${esc(String(s.prLink.number))}</a>` : '';
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

function procRowHTML(row, now) {
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
    bits.push(`<a href="${esc(pr.url)}" target="_blank">#${esc(String(pr.number))}</a>` +
      (flags.length ? ` <span class="proc-detail">${esc(flags.join(' · '))}</span>` : ''));
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

  const prunable = p.worktrees.filter(w => w.prunable).length;
  if (prunable > 0) bits.push(`<span class="proc-detail">${prunable} worktree prunable</span>`);

  const detached = p.worktrees.filter(w => w.detached).length;
  if (detached > 0) bits.push(`<span class="proc-detail">${detached} detached</span>`);

  if (p.sessions.length > 0) {
    const sess = p.sessions.map(x =>
      `${esc(sessionLabel(x))}${x.status ? ' (' + esc(x.status) + ')' : ''}`).join(', ');
    // resumeCmd comes straight from the payload — collect.js already builds it,
    // so this is the only place that constructs it. Fall back to building it
    // from sessionId for an older cached payload that predates the field, and
    // show nothing rather than throw when there is no sessionId at all.
    const first = p.sessions[0];
    const resumeCmd = first.resumeCmd || (first.sessionId ? `claude --resume ${first.sessionId}` : null);
    bits.push(`<span class="proc-detail">sesión: ${sess}` +
      (resumeCmd ? ` · <code>${esc(resumeCmd)}</code>` : '') + `</span>`);
  }

  const repos = [...new Set(p.worktrees.map(w => w.repo))].join(', ');

  return `<div class="proc-row">
    <span class="proc-state ${s}">${procStateLabel(s)}</span>
    <span>
      <span class="proc-key">${esc(p.key)}</span>${p.ticket ? '' : '<span class="proc-noticket">sin ticket</span>'}
      ${repos ? `<span class="proc-detail"> · ${esc(repos)}</span>` : ''}
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
  const bodyHTML = sorted.map(r => procRowHTML(r, now)).join('')
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
