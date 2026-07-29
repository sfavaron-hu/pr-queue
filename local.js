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

function looseRowHTML(sessions) {
  const items = sessions.map(s => {
    const link = s.prLink && s.prLink.url
      ? ` <a href="${esc(s.prLink.url)}" target="_blank">#${s.prLink.number}</a>` : '';
    const when = s.lastActivity ? ` <span class="proc-detail">${timeAgo(new Date(s.lastActivity))}</span>` : '';
    return `${esc(s.name || s.sessionId.slice(0, 8))}${s.status ? ' (' + esc(s.status) + ')' : ''}${link}${when}`;
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
    bits.push(`<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a>` +
      (flags.length ? ` <span class="proc-detail">${esc(flags.join(' · '))}</span>` : ''));
  });

  const dirty = p.worktrees.reduce((n, w) => n + (w.dirty || 0), 0);
  if (dirty > 0) bits.push(`<span class="proc-detail">${dirty} sin commitear</span>`);

  const prunable = p.worktrees.filter(w => w.prunable).length;
  if (prunable > 0) bits.push(`<span class="proc-detail">${prunable} worktree prunable</span>`);

  const detached = p.worktrees.filter(w => w.detached).length;
  if (detached > 0) bits.push(`<span class="proc-detail">${detached} detached</span>`);

  if (p.sessions.length > 0) {
    const sess = p.sessions.map(x =>
      `${esc(x.name || x.sessionId.slice(0, 8))}${x.status ? ' (' + esc(x.status) + ')' : ''}`).join(', ');
    bits.push(`<span class="proc-detail">sesión: ${sess} · <code>claude --resume ${esc(p.sessions[0].sessionId)}</code></span>`);
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

  procEl.section().style.display = '';
  procEl.body().innerHTML = sorted.map(r => procRowHTML(r, now)).join('')
    + ((payload.looseSessions || []).length ? looseRowHTML(payload.looseSessions) : '');

  const states = sorted.map(r => classify(r.proc, r.prs, now));
  const count = s => states.filter(x => x === s).length;

  // The badge counts what needs a decision from you, not everything that exists.
  procEl.count().textContent = count('turno') || '';

  const warn = (payload.warnings || []).length;
  procEl.meta().textContent =
    `${sorted.length} procesos · ${count('turno')} tu turno · ${count('esperando')} esperando · ` +
    `${count('pausa')} en pausa · ${count('frio')} fríos (>${COLD_DAYS}d)` +
    (warn ? ` · ${warn} warnings` : '') +
    (payload.generatedAt ? ` · ${timeAgo(new Date(payload.generatedAt))}` : '');
}

function applyProcCollapsed() {
  const collapsed = localStorage.getItem(PROC_COLLAPSED_KEY) === '1';
  procEl.body().classList.toggle('hidden', collapsed);
  procEl.caret().textContent = collapsed ? '▸' : '▾';
}

async function initLocalPanel() {
  // Paint the cached payload first so the panel is never empty on load.
  try {
    const cached = localStorage.getItem(PROC_CACHE_KEY);
    if (cached) { window.LOCAL_STATE = JSON.parse(cached); renderLocalPanel(); }
  } catch { /* ignore a corrupt cache */ }

  let payload;
  try {
    const res = await fetch('/api/local', { cache: 'no-store' });
    if (!res.ok) return;              // no sidecar → not our environment
    payload = await res.json();
  } catch {
    return;                           // GitHub Pages lands here. Mount nothing.
  }
  if (!payload || !Array.isArray(payload.processes)) return;

  window.LOCAL_STATE = payload;
  try { localStorage.setItem(PROC_CACHE_KEY, JSON.stringify(payload)); } catch { /* quota */ }

  renderLocalPanel();
  applyProcCollapsed();

  // Own PRs load asynchronously and arrive after this point, so the first
  // render has no PR detail. Wrap the existing renderOwnPRs (a global, since
  // these are plain scripts) to re-render the panel whenever they land —
  // cheaper and less invasive than editing render.js.
  if (typeof window.renderOwnPRs === 'function') {
    const inner = window.renderOwnPRs;
    window.renderOwnPRs = function () {
      const out = inner.apply(this, arguments);
      try { renderLocalPanel(); } catch (e) { console.warn('proc panel render failed', e); }
      return out;
    };
  }

  procEl.toggle().addEventListener('click', () => {
    const collapsed = localStorage.getItem(PROC_COLLAPSED_KEY) === '1';
    localStorage.setItem(PROC_COLLAPSED_KEY, collapsed ? '0' : '1');
    applyProcCollapsed();
  });
}

initLocalPanel();
