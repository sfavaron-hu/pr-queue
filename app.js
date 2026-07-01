// ── Tribe picker ─────────────────────────────────────────────

function syncTribePicker() {
  const current = el.cfgLabel.value;
  const isKnown = TRIBES.some(t => t.label === current);
  document.querySelectorAll('.tribe-chip[data-label]').forEach(chip => {
    chip.classList.toggle('selected', chip.dataset.label === current);
  });
  const custom = document.getElementById('tribe-custom-input');
  if (!custom) return;
  if (!isKnown && current) {
    custom.value = current;
    custom.classList.add('selected');
  } else {
    custom.value = '';
    custom.classList.remove('selected');
  }
}

function buildTribePicker() {
  const picker = document.getElementById('tribe-picker');
  if (!picker) return;
  TRIBES.forEach(({ label, color }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tribe-chip';
    btn.dataset.label = label;
    btn.style.setProperty('--tc', color);
    btn.innerHTML = `<span class="tribe-chip-dot"></span>${label}`;
    btn.addEventListener('click', () => {
      el.cfgLabel.value = label;
      const custom = document.getElementById('tribe-custom-input');
      if (custom) custom.value = '';
      syncTribePicker();
    });
    picker.appendChild(btn);
  });

  const custom = document.createElement('input');
  custom.type = 'text';
  custom.id = 'tribe-custom-input';
  custom.className = 'tribe-chip';
  custom.placeholder = 'otra…';
  custom.addEventListener('input', () => {
    el.cfgLabel.value = custom.value.trim();
    document.querySelectorAll('.tribe-chip[data-label]').forEach(c => c.classList.remove('selected'));
    custom.classList.toggle('selected', !!custom.value.trim());
  });
  picker.appendChild(custom);

  syncTribePicker();
}

// ── Events ───────────────────────────────────────────────────

async function connectToken(val) {
  state.token = val;
  localStorage.setItem(STORAGE.token, val);
  try {
    const user = await apiFetch(`${API}/user`);
    state.me = user.login;
    state.meAvatar = user.avatar_url || '';
    localStorage.setItem('prq_me', state.me);
    localStorage.setItem('prq_me_avatar', state.meAvatar);
    el.loggedUser.textContent = '@' + state.me;
    el.loggedUser.classList.remove('hidden');
    el.signoutBtn.classList.remove('hidden');
  } catch { state.me = ''; }
  el.authSection.classList.add('hidden');
  loadPRs();
  loadOwnPRs();
  loadAutoScore();
}

el.saveTokenBtn.addEventListener('click', () => {
  const val = el.tokenInput.value.trim();
  if (val) connectToken(val);
});
el.tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.saveTokenBtn.click(); });

let configOpen = false;
el.configToggle.addEventListener('click', () => {
  configOpen = !configOpen;
  el.configSection.classList.toggle('hidden', !configOpen);
  el.configToggle.textContent = configOpen ? 'Done' : 'Config';
  if (configOpen) { writeConfigFields(); syncTribePicker(); }
});

[el.cfgOrg, el.cfgBots].forEach(input => {
  input.addEventListener('keydown', e => { if (e.key === 'Enter') el.configSave.click(); });
});

el.configSave.addEventListener('click', () => {
  readConfigFields();
  configOpen = false;
  el.configSection.classList.add('hidden');
  el.configToggle.textContent = 'Config';
  renderScore();
  if (state.token) { loadPRs(); loadOwnPRs(); loadAutoScore(); }
});

el.signoutBtn.addEventListener('click', () => {
  state.token = ''; state.me = ''; state.prs = [];
  localStorage.removeItem(STORAGE.token);
  localStorage.removeItem(STORAGE.prsCache);
  localStorage.removeItem('prq_me');
  el.authSection.classList.remove('hidden');
  el.configSection.classList.add('hidden');
  el.toolbar.classList.add('hidden');
  el.prList.innerHTML = '';
  el.ownPrList.innerHTML = '';
  el.ownColumn.style.display = 'none';
  configOpen = false;
  el.configToggle.textContent = 'Config';
  el.statusDot.className = 'header-dot';
  el.tokenInput.value = '';
  el.loggedUser.classList.add('hidden');
  el.signoutBtn.classList.add('hidden');
});

el.refreshBtn.addEventListener('click', () => { loadPRs(); loadOwnPRs(); loadAutoScore(); });
el.readyOnly.addEventListener('change',   () => { state.readyOnly   = el.readyOnly.checked;   updateURL(); renderList(); });
el.showIgnored.addEventListener('change', () => { state.showIgnored = el.showIgnored.checked; updateURL(); renderList(); });

setInterval(() => {
  if (state.lastUpdated) el.lastUpdated.textContent = `Updated ${timeAgo(state.lastUpdated)}`;
}, 30000);

// Poll only while tab is visible; stop timer when hidden, restart on focus
let pollInterval = null;

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    if (state.token && !state.loading) { loadPRs(); loadOwnPRs(); loadAutoScore(); }
  }, 3 * 60 * 1000);
}

function stopPolling() {
  clearInterval(pollInterval);
  pollInterval = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    if (state.token && !state.loading) {
      if (!state.lastUpdated || Date.now() - state.lastUpdated > 3 * 60 * 1000) {
        loadPRs(); loadOwnPRs();
      }
    }
    startPolling();
  }
});

// ── Tooltip ──────────────────────────────────────────────────

const tip = document.getElementById('tip');
let tipTimer;

document.addEventListener('mouseover', e => {
  const target = e.target.closest('[data-tip]');
  if (!target) return;
  clearTimeout(tipTimer);
  tip.textContent = target.dataset.tip;
  tip.classList.add('visible');
  moveTip(e);
});

document.addEventListener('mousemove', e => {
  if (tip.classList.contains('visible')) moveTip(e);
});

document.addEventListener('mouseout', e => {
  if (!e.target.closest('[data-tip]')) return;
  clearTimeout(tipTimer);
  tip.classList.remove('visible');
});

function moveTip(e) {
  const pad = 10;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + tip.offsetWidth  > window.innerWidth)  x = e.clientX - tip.offsetWidth  - pad;
  if (y + tip.offsetHeight > window.innerHeight) y = e.clientY - tip.offsetHeight - pad;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

// ── Init ─────────────────────────────────────────────────────

buildTribePicker();
readURL();
el.readyOnly.checked   = state.readyOnly;
el.showIgnored.checked = state.showIgnored;
renderScore();

if (!state.config.label) {
  configOpen = true;
  el.configSection.classList.remove('hidden');
  el.configToggle.textContent = 'Done';
  writeConfigFields();
  syncTribePicker();
}

if (!document.hidden) startPolling();

if (state.token) {
  el.authSection.classList.add('hidden');

  // Show stale data immediately while fetch runs in background
  const cachedRaw = localStorage.getItem(STORAGE.prsCache);
  if (cachedRaw) {
    try {
      state.prs = JSON.parse(cachedRaw).map(pr => ({ ...pr, createdAt: new Date(pr.createdAt) }));
      el.toolbar.classList.remove('hidden');
      renderList();
    } catch { localStorage.removeItem(STORAGE.prsCache); }
  }

  if (state.me && !state.meAvatar) {
    apiFetch(`${API}/user`).then(u => {
      state.meAvatar = u.avatar_url || '';
      localStorage.setItem('prq_me_avatar', state.meAvatar);
    }).catch(() => {});
  }
  if (state.me) {
    el.loggedUser.textContent = '@' + state.me;
    el.loggedUser.classList.remove('hidden');
    el.signoutBtn.classList.remove('hidden');
    loadPRs();
    loadOwnPRs();
    loadAutoScore();
  } else {
    // Token guardado pero sin login — inferirlo ahora
    apiFetch(`${API}/user`).then(user => {
      state.me = user.login;
      localStorage.setItem('prq_me', state.me);
      el.loggedUser.textContent = '@' + state.me;
      el.loggedUser.classList.remove('hidden');
      el.signoutBtn.classList.remove('hidden');
      loadPRs();
      loadOwnPRs();
      loadAutoScore();
    }).catch(() => { loadPRs(); });
  }
}
