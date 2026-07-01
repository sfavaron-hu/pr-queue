// ── Score ─────────────────────────────────────────────────────

function weekStart() {
  const d = new Date();
  const diff = d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1);
  return new Date(d.getFullYear(), d.getMonth(), diff).toISOString().split('T')[0];
}

function loadScore() {
  const saved = JSON.parse(localStorage.getItem('prq_score') || '{}');
  if (saved.week !== weekStart()) return { week: weekStart(), pts: 0, xs: 0, s: 0, m: 0, l: 0, xl: 0, autoIds: [] };
  return { autoIds: [], ...saved };
}

function saveScore(score) {
  localStorage.setItem('prq_score', JSON.stringify(score));
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
  const score = loadScore();
  const el = document.getElementById('week-score');
  if (!el) return;
  const parts = ['xs','s','m','l','xl'].filter(k => score[k] > 0).map(k => `${k.toUpperCase()}×${score[k]}`);
  el.style.display = score.pts > 0 ? '' : 'none';
  el.title = parts.join(' · ');
  el.textContent = `🏆 ${score.pts % 1 === 0 ? score.pts : score.pts.toFixed(1)} pts`;
}

function awardPoints(lines) {
  const score = loadScore();
  score.pts += ptsForLines(lines);
  score[sizeKey(lines)] = (score[sizeKey(lines)] || 0) + 1;
  saveScore(score);
  renderScore();
  const el = document.getElementById('week-score');
  if (el) { el.style.transform = 'scale(1.2)'; setTimeout(() => el.style.transform = '', 200); }
}

async function loadAutoScore() {
  if (!state.token || !state.me) return;
  const { org, label } = state.config;
  const since = weekStart();
  try {
    const data = await apiFetch(
      `${API}/search/issues?q=is:pr+org:${encodeURIComponent(org)}+label:${encodeURIComponent(label)}+reviewed-by:${encodeURIComponent(state.me)}+updated:>=${since}&per_page=50&sort=updated&order=desc`
    );
    const items = data.items || [];
    const score = loadScore();
    const autoIds = new Set(score.autoIds || []);
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
          const fresh = loadScore();
          fresh.pts += ptsForLines(lines);
          fresh[sizeKey(lines)] = (fresh[sizeKey(lines)] || 0) + 1;
          fresh.autoIds = [...new Set([...(fresh.autoIds || []), pr.id])];
          saveScore(fresh);
          renderScore();
        } catch { /* silent */ }
      }));
    }
  } catch { /* silent */ }
}
