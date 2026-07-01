// ── Helpers ──────────────────────────────────────────────────

function timeAgo(date) {
  const m = Math.floor((Date.now() - date) / 60000);
  if (m < 60)   return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m/60)}h ago`;
  return `${Math.floor(m/1440)}d ago`;
}

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showError(msg) {
  el.errorMsg.textContent = msg;
  el.errorMsg.classList.remove('hidden');
}

function ciBadge(ci) {
  const map = {
    green:   ['badge-green', '✓ CI'],
    pending: ['badge-amber', '◐ CI'],
    failed:  ['badge-red',   '✗ CI'],
    unknown: ['badge-gray',  '— CI'],
  };
  const [cls, lbl] = map[ci] || map.unknown;
  return `<span class="badge ${cls}">${lbl}</span>`;
}

function lineCountHTML(n) {
  if (n == null || n === 0) return '';
  let color, weight, extra = '';
  if      (n <= 10)  { color = '#ffd700'; weight = 700; extra = ' ✦'; }
  else if (n <= 20)  { color = '#f0c040'; weight = 600; }
  else if (n <= 50)  { color = '#9fcf6f'; weight = 500; }
  else if (n <= 150) { color = '#3fb950'; weight = 400; }
  else if (n <= 400) { color = '#6e7681'; weight = 400; }
  else               { color = '#3d4451'; weight = 400; }
  return `<span class="badge" style="color:${color};font-weight:${weight};background:transparent;padding:2px 4px;">${n} líneas${extra}</span>`;
}

function sizeBadgeHTML(n) {
  if (n == null || n === 0) return '';
  let label, bg, clr;
  if      (n <= 20)  { label = 'XS'; bg = 'rgba(251,191,36,0.14)';  clr = '#FBBF24'; }
  else if (n <= 80)  { label = 'S';  bg = 'rgba(52,211,153,0.12)';  clr = '#34D399'; }
  else if (n <= 250) { label = 'M';  bg = 'rgba(96,165,250,0.12)';  clr = '#60A5FA'; }
  else if (n <= 500) { label = 'L';  bg = 'rgba(167,139,250,0.12)'; clr = '#A78BFA'; }
  else               { label = 'XL'; bg = 'rgba(79,96,112,0.18)';   clr = '#6e7681'; }
  return `<span class="badge" style="background:${bg};color:${clr};font-weight:600;">${label}</span>`;
}

// ── Render ───────────────────────────────────────────────────

function renderCard(pr, isNew = false, delay = 0) {
  const ignored = state.ignored.has(pr.id);
  const activityBadge = pr.humanActivity > 0
    ? `<span class="badge badge-blue" data-tip="${pr.humanActivity} comentario${pr.humanActivity > 1 ? 's' : ''} de ${pr.activityBy.join(', ')}">👁 ${pr.humanActivity}</span>`
    : '';
  const approvalBadge = pr.changesReq ? `<span class="badge badge-red" data-tip="Alguien pidió cambios">✗ Cambios</span>`
    : pr.approved ? `<span class="badge badge-green" data-tip="Tiene al menos un approve">✓ Aprobado</span>` : '';
  const draftBadge     = pr.draft      ? `<span class="badge badge-amber" data-tip="PR en borrador, no listo para review">Draft</span>` : '';
  const conflictBadge  = pr.conflicts  ? `<span class="badge badge-red">⚡ Conflicts</span>` : '';
  const dontMergeBadge = pr.dontMerge  ? `<span class="badge badge-amber">🚧 Don't merge</span>` : '';

  const newReviewDot = (pr.newApprovals > 0 || pr.newChanges > 0)
    ? `<span class="new-review-dot" data-tip="Review nuevo sin ver"></span>` : '';

  const newCls   = isNew ? ' is-new' : '';
  const newStyle = isNew && delay ? ` style="animation-delay:${delay}ms"` : '';

  if (pr.merged) {
    return `
    <div class="pr-card is-merged" data-id="${pr.id}">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:7px;">
        <div class="pr-title" style="margin:0;flex:1;">
          <a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.title)}</a>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="pr-repo">${esc(pr.repo)}</span>
        <span class="pr-number">#${pr.number}</span>
        <span class="badge badge-green" style="margin-left:auto;">✓ Merged</span>
        <span class="badge badge-gray">${timeAgo(pr.createdAt)}</span>
      </div>
    </div>`;
  }

  return `
    <div class="pr-card${ignored ? ' is-ignored' : ''}${newCls}" data-id="${pr.id}"${newStyle}>
      ${newReviewDot}
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:7px;">
        <div class="pr-title" style="margin:0;flex:1;">
          <a href="${esc(pr.url)}" target="_blank" rel="noopener">${esc(pr.title)}</a>
        </div>
        <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
          ${sizeBadgeHTML(pr.lines)}${lineCountHTML(pr.lines)}
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="pr-repo">${esc(pr.repo)}</span>
          <span class="pr-number">#${pr.number}</span>
        </div>
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end;">
          ${ciBadge(pr.ci)}${activityBadge}${approvalBadge}${conflictBadge}${dontMergeBadge}${draftBadge}<span class="badge badge-gray">${timeAgo(pr.createdAt)}</span>
        </div>
      </div>
      <div class="pr-meta">
        <div class="pr-author">
          ${pr.authorAvatar ? `<img src="${esc(pr.authorAvatar)}" alt="${esc(pr.author)}" loading="lazy" />` : ''}
          <span>${esc(pr.author)}</span>
        </div>
        <div class="pr-actions">
          <a href="${esc(pr.url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Open →</a>
          ${pr.noSkip ? '' : `<button class="btn btn-ghost btn-sm ignore-btn" data-id="${pr.id}">${ignored ? 'Restore' : 'Skip'}</button>`}
        </div>
      </div>
    </div>`;
}

function renderList() {
  state.cardTimers.forEach(clearTimeout);
  state.cardTimers = [];
  const visible = state.prs.filter(pr => {
    if (!state.showIgnored && state.ignored.has(pr.id)) return false;
    if (state.readyOnly && !pr.ready) return false;
    return true;
  });

  const botPRs  = state.prs.filter(p => p.botPR);
  const ready   = visible.filter(p => p.ready && !state.ignored.has(p.id) && !p.botPR);
  const others  = visible
    .filter(p => (!p.ready || state.ignored.has(p.id)) && !p.botPR)
    .sort((a, b) => {
      const aSkippedReady = a.ready && state.ignored.has(a.id) ? 0 : 1;
      const bSkippedReady = b.ready && state.ignored.has(b.id) ? 0 : 1;
      return aSkippedReady - bSkippedReady;
    });

  el.empty.classList.toggle('hidden', visible.length > 0 || botPRs.length > 0);
  const emptyLabel = document.getElementById('empty-label');
  if (emptyLabel) emptyLabel.textContent = state.config.label;

  if (visible.length === 0 && botPRs.length === 0) { el.prList.innerHTML = ''; return; }

  let newIdx = 0;
  const rc = pr => {
    const isNew = !state.renderedIds.has(pr.id);
    return renderCard(pr, isNew, isNew ? newIdx++ * 500 : 0);
  };

  const quickWins    = ready.filter(p => (p.lines || 0) > 0 && (p.lines || 0) <= 20);
  const regularReady = ready.filter(p => (p.lines || 0) === 0 || (p.lines || 0) > 20);

  let html = '';
  if (quickWins.length > 0) {
    html += `<div class="quick-wins-section">`;
    html += `<div class="section-label">⚡ quick wins <span class="count-badge ready">${quickWins.length}</span></div>`;
    html += quickWins.map(rc).join('');
    html += `</div>`;
  }
  html += `<div class="section-label">Ready to review ${regularReady.length > 0 ? `<span class="count-badge ready">${regularReady.length}</span>` : ''}</div>`;
  html += regularReady.length > 0
    ? regularReady.map(rc).join('')
    : quickWins.length > 0
      ? `<div style="padding:16px 0;text-align:center;font-size:12px;color:var(--muted);">No hay más PRs listos para review.</div>`
      : `<div style="padding:20px 0;text-align:center;font-size:12px;color:var(--muted);">Ningún PR listo para review 🎉</div>`;
  if (!state.readyOnly && others.length > 0) {
    html += `<div class="section-label">Has activity <span class="count-badge">${others.length}</span></div>`;
    html += others.map(rc).join('');
  }
  if (botPRs.length > 0) {
    html += `<div class="section-label">Bots <span class="count-badge">${botPRs.length}</span></div>`;
    html += botPRs.map(rc).join('');
  }

  // Mark all as rendered after this paint
  [...ready, ...others, ...botPRs].forEach(p => state.renderedIds.add(p.id));

  el.prList.innerHTML = html;

  // Stagger-animate newly appeared cards
  el.prList.querySelectorAll('.pr-card.is-new').forEach(card => {
    const delay  = parseFloat(card.style.animationDelay) || 0;
    const parent = card.parentNode;
    const next   = card.nextSibling;
    parent.removeChild(card);
    card.style.removeProperty('animation-delay');
    state.cardTimers.push(setTimeout(() => {
      if (next && next.parentNode === parent) parent.insertBefore(card, next);
      else parent.appendChild(card);
      card.style.animation = 'none';
      card.offsetHeight;
      card.style.animation = '';
    }, delay));
  });

  el.prList.querySelectorAll('.ignore-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      if (state.ignored.has(id)) state.ignored.delete(id);
      else state.ignored.add(id);
      saveIgnored();
      renderList();
    });
  });

}

// ── Own PRs ──────────────────────────────────────────────────

function saveOwnActivity() {
  localStorage.setItem('prq_own_activity', JSON.stringify(state.ownActivity));
}

function renderOwnPRs() {
  const prs = state.ownPRs;
  el.ownEmpty.classList.toggle('hidden', prs.length > 0 || state.mergedPRs.length > 0);
  el.ownCount.textContent = prs.length > 0 ? prs.length : '';
  el.ownCount.style.display = prs.length > 0 ? '' : 'none';

  let html = prs.map(p => renderCard({
    ...p,
    author: state.me, authorAvatar: state.meAvatar,
    humanActivity: p.newComments || 0, activityBy: [], dontMerge: false, ready: false,
    noSkip: true,
  })).join('');

  if (state.mergedPRs.length > 0) {
    html += `<div class="section-label" style="margin-top:16px;font-size:10px;">Mergeados <span class="count-badge" style="font-size:10px">${state.mergedPRs.length}</span></div>`;
    html += state.mergedPRs.map(pr => renderCard({
      ...pr,
      merged: true,
      createdAt: pr.updatedAt,
    })).join('');
  }

  el.ownPrList.innerHTML = html;

  el.ownPrList.querySelectorAll('.pr-card[data-id]').forEach(card => {
    const id = Number(card.dataset.id);
    const pr = state.ownPRs.find(p => p.id === id);
    if (!pr) return;
    card.querySelector('.pr-title a')?.addEventListener('click', () => {
      state.ownActivity[id] = { commentIds: pr.allCommentIds || [], reviewIds: pr.allReviewIds || [] };
      saveOwnActivity();
      pr.newComments = 0; pr.newApprovals = 0; pr.newChanges = 0;
      renderOwnPRs();
    });
  });
}

async function loadOwnPRs() {
  if (!state.token || !document.hasFocus()) return;
  const { org, label } = state.config;
  if (!state.me) return;

  el.ownColumn.style.display = '';
  if (state.ownPRs.length === 0) el.ownLoading.classList.remove('hidden');

  try {
    const [openData, mergedData] = await Promise.all([
      apiFetch(`${API}/search/issues?q=is:pr+is:open+label:${encodeURIComponent(label)}+org:${encodeURIComponent(org)}+author:${encodeURIComponent(state.me)}&per_page=50&sort=created&order=desc`),
      apiFetch(`${API}/search/issues?q=is:pr+is:merged+label:${encodeURIComponent(label)}+org:${encodeURIComponent(org)}+author:${encodeURIComponent(state.me)}+merged:>${threeDAysAgo()}&per_page=20&sort=updated&order=desc`),
    ]);

    const items = openData.items || [];
    const results = [];
    for (let i = 0; i < items.length; i += 4) {
      const batch = items.slice(i, i + 4);
      const out   = await Promise.all(batch.map(enrichOwnPR));
      results.push(...out);
    }
    state.ownPRs       = results.filter(Boolean);
    state.mergedPRs    = (mergedData.items || []).map(pr => {
      const [owner, repo] = pr.repository_url.replace(`${API}/repos/`, '').split('/');
      return { id: pr.id, number: pr.number, owner, repo, title: pr.title, url: pr.html_url, updatedAt: new Date(pr.updated_at) };
    });
    renderOwnPRs();
  } catch { /* silent */ } finally {
    el.ownLoading.classList.add('hidden');
  }
}

function threeDAysAgo() {
  const d = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

// ── Load PRs ─────────────────────────────────────────────────

async function loadPRs() {
  if (!state.token || state.loading || !state.config.label || !document.hasFocus()) return;
  state.loading = true;

  const hasExisting = state.prs.length > 0;
  if (!hasExisting) state.renderedIds = new Set();

  el.progressFill.style.width = '0%';
  if (!hasExisting) {
    el.loading.classList.remove('hidden');
    el.loadingText.textContent = 'Fetching PR list…';
  }
  el.errorMsg.classList.add('hidden');
  el.empty.classList.add('hidden');
  el.refreshBtn.disabled = true;
  el.statusDot.className = 'header-dot';

  try {
    const { org, label } = state.config;
    const botRe = new RegExp(state.config.bots, 'i');

    const data = await apiFetch(
      `${API}/search/issues?q=is:pr+is:open+label:${encodeURIComponent(label)}+org:${encodeURIComponent(org)}&per_page=100&sort=created&order=desc`
    );

    const items = data.items || [];
    el.progressFill.style.width = '8%';

    if (items.length === 0) {
      state.prs = [];
      el.loading.classList.add('hidden');
      renderList();
      el.toolbar.classList.remove('hidden');
      el.statusDot.className = 'header-dot live';
      return;
    }

    let done = 0;
    const onProgress = () => {
      done++;
      if (!hasExisting) el.loadingText.textContent = `Checking PR ${done} of ${items.length}…`;
      el.progressFill.style.width = `${8 + Math.round((done / items.length) * 87)}%`;
    };

    const newSearchIds = new Set(items.map(i => i.id));

    for (let i = 0; i < items.length; i += 4) {
      const batch = items.slice(i, i + 4);
      const out   = await Promise.all(batch.map(pr => enrichPR(pr, botRe, onProgress)));
      for (const pr of out.filter(Boolean)) {
        const idx = state.prs.findIndex(p => p.id === pr.id);
        if (idx >= 0) state.prs[idx] = pr;
        else state.prs.push(pr);
      }
    }

    // Remove PRs that are no longer in the search results
    state.prs = state.prs.filter(p => newSearchIds.has(p.id));
    state.lastUpdated = Date.now();
    el.lastUpdated.textContent = 'Updated just now';
    try { localStorage.setItem(STORAGE.prsCache, JSON.stringify(state.prs)); } catch { /* quota */ }
    el.progressFill.style.width = '100%';
    setTimeout(() => { el.progressFill.style.width = '0%'; }, 500);
    el.toolbar.classList.remove('hidden');
    el.statusDot.className = 'header-dot live';
    renderList();

  } catch (err) {
    // Token might be expired — if 401 reset to auth
    if (err.message.includes('401')) {
      state.token = '';
      localStorage.removeItem(STORAGE.token);
      el.authSection.classList.remove('hidden');
      showError('Session expired. Please sign in again.');
    } else {
      showError(err.message);
    }
    el.progressFill.style.width = '0%';
    el.statusDot.className = 'header-dot';
  } finally {
    state.loading = false;
    el.loading.classList.add('hidden');
    el.refreshBtn.disabled = false;
  }
}
