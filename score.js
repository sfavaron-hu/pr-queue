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

function awardPoints(lines) {
  const label = state.config.label;
  const score = loadScore(label);
  score.pts += ptsForLines(lines);
  score[sizeKey(lines)] = (score[sizeKey(lines)] || 0) + 1;
  saveScore(score, label);
  renderScore();
  const el = document.getElementById('week-score');
  if (el) { el.style.transform = 'scale(1.2)'; setTimeout(() => el.style.transform = '', 200); }
}

async function loadAutoScore() {
  if (!state.token || !state.me) return;
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
          const fresh = loadScore(label);
          fresh.pts += ptsForLines(lines);
          fresh[sizeKey(lines)] = (fresh[sizeKey(lines)] || 0) + 1;
          fresh.autoIds = [...new Set([...(fresh.autoIds || []), pr.id])];
          saveScore(fresh, label);
          renderScore();
        } catch { /* silent */ }
      }));
    }
  } catch { /* silent */ }
}
