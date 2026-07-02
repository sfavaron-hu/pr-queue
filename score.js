// ── Score ─────────────────────────────────────────────────────

function loadScore(label) {
  const all = JSON.parse(localStorage.getItem('prq_score_v2') || '{}');
  return { pts: 0, xs: 0, s: 0, m: 0, l: 0, xl: 0, autoIds: [], ...(all[label] || {}) };
}

function saveScore(score, label) {
  const all = JSON.parse(localStorage.getItem('prq_score_v2') || '{}');
  all[label] = score;
  localStorage.setItem('prq_score_v2', JSON.stringify(all));
}

function ptsForLines(n) {
  if (n <= 20)  return 1;
  if (n <= 80)  return 2;
  if (n <= 250) return 3.5;
  if (n <= 500) return 5.5;
  return 8;
}

function sizeKey(n) {
  if (n <= 20)  return 'xs';
  if (n <= 80)  return 's';
  if (n <= 250) return 'm';
  if (n <= 500) return 'l';
  return 'xl';
}

function renderScore() {
  const label = state.config.label;
  const score = loadScore(label);
  const el = document.getElementById('week-score');
  if (!el) return;
  const parts = ['xs','s','m','l','xl'].filter(k => score[k] > 0).map(k => `${k.toUpperCase()}×${score[k]}`);
  el.style.display = score.pts > 0 ? '' : 'none';
  el.title = parts.join(' · ');
  el.textContent = `🏆 ${score.pts % 1 === 0 ? score.pts : score.pts.toFixed(1)} pts`;
}


async function loadAutoScore() {
  if (!state.token || !state.me || !document.hasFocus()) return;
  const { org, label } = state.config;
  if (!label) return;
  try {
    const data = await apiFetch(
      `${API}/search/issues?q=is:pr+org:${encodeURIComponent(org)}+label:${encodeURIComponent(label)}+reviewed-by:${encodeURIComponent(state.me)}&per_page=50&sort=updated&order=desc`
    );
    const items = data.items || [];
    const score = loadScore(label);
    const autoIds = new Set(score.autoIds || []);

    // First run for this label: seed baseline without scoring (start from zero)
    if (autoIds.size === 0 && items.length > 0) {
      score.autoIds = items.map(i => i.id);
      saveScore(score, label);
      return;
    }

    const candidates = items.filter(pr => pr.user.login !== state.me && !autoIds.has(pr.id));
    if (candidates.length === 0) return;

    let gained = 0;
    for (let i = 0; i < candidates.length; i += 3) {
      const batch = candidates.slice(i, i + 3);
      await Promise.all(batch.map(async pr => {
        const [owner, repo] = pr.repository_url.replace(`${API}/repos/`, '').split('/');
        try {
          const [prDetails, reviews] = await Promise.all([
            apiFetch(`${API}/repos/${owner}/${repo}/pulls/${pr.number}`),
            apiFetch(`${API}/repos/${owner}/${repo}/pulls/${pr.number}/reviews`),
          ]);
          const userApproved = (reviews || []).some(r => r.user.login === state.me && r.state === 'APPROVED');
          if (!userApproved) return;
          const lines = (prDetails.additions || 0) + (prDetails.deletions || 0);
          const pts = ptsForLines(lines);
          const fresh = loadScore(label);
          fresh.pts += pts;
          fresh[sizeKey(lines)] = (fresh[sizeKey(lines)] || 0) + 1;
          fresh.autoIds = [...new Set([...(fresh.autoIds || []), pr.id])];
          saveScore(fresh, label);
          renderScore();
          gained += pts;
        } catch { /* silent */ }
      }));
    }
    if (gained > 0 && document.hasFocus()) triggerScoreGainEffect(gained);
  } catch { /* silent */ }
}

// ── Score gain effect (sound + totem-style popup) ───────────────

function playScoreSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [440, 660];
    notes.forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.2, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
    setTimeout(() => ctx.close(), 400);
  } catch { /* AudioContext unavailable/blocked: skip silently */ }
}

function triggerScoreGainEffect(delta) {
  if (state.config.fx === false) return;
  playScoreSound();
  const anchor = document.getElementById('week-score');
  if (!anchor) return;
  anchor.style.display = ''; // ensure visible even if score badge is currently hidden (pts=0)
  const pop = document.createElement('span');
  pop.className = 'score-pop';
  const spin = document.createElement('span');
  spin.className = 'score-pop-spin';
  spin.textContent = `+${delta % 1 === 0 ? delta : delta.toFixed(1)}`;
  pop.appendChild(spin);
  pop.addEventListener('animationend', () => pop.remove());
  anchor.appendChild(pop);
}
