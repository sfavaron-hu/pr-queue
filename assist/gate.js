// The deterministic half of the work assistant: a pure function of the ledger
// that splits mechanical actions from human decisions. No model, no execution,
// no IO except the injected pr-babysit reads. The gate only *identifies* work;
// running it is a later increment.

function repoPath(workspaceRoot, repo) {
  return workspaceRoot ? `${workspaceRoot}/${repo}` : repo;
}

// Stable, human-readable, and content-derived: the same (kind, process, repo,
// branch) always yields the same id, so re-deriving an action across passes
// does not duplicate it. The queue (Increment 3) may hash this; a stable string
// already dedups.
function actionId(kind, processKey, repo, branch) {
  return `${kind}:${processKey}:${repo}:${branch || ''}`;
}

// One action per worktree, at most. Order of checks is the priority order:
// a gone directory prunes; a not-on-origin unconsumed branch pushes; an
// all-merged clean worktree gets removed; an on-origin branch with commits and
// no PR opens a draft. `continue` after each keeps them mutually exclusive per
// worktree (you cannot open a PR for a branch you are still pushing).
function buildActions(ledger) {
  const actions = [];
  const root = ledger.workspaceRoot;

  for (const p of ledger.processes) {
    const prs = p.prs || [];
    // Reversibility is a property of the environment: a branch any PR points at
    // (open = referenced, merged = consumed) is off-limits for an autonomous push.
    const consumed = (branch) => prs.some(pr => pr.headRef === branch);

    for (const w of (p.worktrees || [])) {
      if (w.prunable) {
        actions.push({
          id: actionId('prune-worktree', p.key, w.repo, w.branch),
          kind: 'prune-worktree', processKey: p.key, repo: w.repo,
          cmd: `git -C ${repoPath(root, w.repo)} worktree prune`,
          reversibility: 'reversible-metadata',
          why: 'El worktree ya no existe en disco',
          evidence: `${w.repo}: directorio ausente`,
        });
        continue;
      }
      if (w.detached || !w.branch || !w.path) continue;

      if (w.onOrigin === false && !consumed(w.branch)) {
        actions.push({
          id: actionId('push', p.key, w.repo, w.branch),
          kind: 'push', processKey: p.key, repo: w.repo,
          cmd: `git -C ${w.path} push -u origin ${w.branch}`,
          reversibility: 'reversible-unconsumed',
          why: 'La rama no está en origin y ningún PR la referencia',
          evidence: `${w.repo}/${w.branch}: onOrigin=false, sin PR que la consuma`,
        });
        continue;
      }

      const clean = (w.dirty || 0) === 0;
      if (prs.length > 0 && prs.every(pr => pr.merged === true) && clean) {
        actions.push({
          id: actionId('remove-merged-worktree', p.key, w.repo, w.branch),
          kind: 'remove-merged-worktree', processKey: p.key, repo: w.repo,
          cmd: `git -C ${repoPath(root, w.repo)} worktree remove ${w.path}`,
          reversibility: 'reversible-local',
          why: 'Todos los PRs del proceso están mergeados; el worktree es estado local sobrante',
          evidence: `${w.repo}/${w.branch}: PRs mergeados, worktree limpio`,
        });
        continue;
      }

      // unpushed is commits-above-base (the naming trap): here it correctly means
      // "has its own commits". Requires the branch on origin, no PR yet, clean, and
      // a known base + github slug to form the command.
      if (w.onOrigin !== false && (w.unpushed || 0) > 0 && prs.length === 0 &&
          clean && w.baseBranch && w.githubRepo) {
        actions.push({
          id: actionId('open-draft-pr', p.key, w.repo, w.branch),
          kind: 'open-draft-pr', processKey: p.key, repo: w.repo,
          cmd: `gh pr create --draft --fill -R ${w.githubRepo} --head ${w.branch} --base ${w.baseBranch}`,
          reversibility: 'reversible-draft',
          why: 'Rama en origin con commits sobre base y sin PR',
          evidence: `${w.repo}/${w.branch}: ${w.unpushed} commit(s) sobre ${w.baseBranch}`,
        });
      }
    }
  }
  return actions;
}

// One AskUserQuestion call per pass holds at most 4 questions; that ceiling is
// the whole defence against approval fatigue, so over-budget questions are
// dropped (re-derived next pass), never queued to be drained.
const QUESTION_BUDGET = 4;

// At most one question per process. Dirty beats cold: uncommitted changes are a
// concrete "what do I do with this" the assistant genuinely cannot resolve
// (committing is a decision, removing is data loss), whereas cold is a nudge.
// The `review` type is intentionally not produced in v1 — its actions
// (ready-for-review, merge) are out of the blast radius, and drafts already show
// in the panel's chip.
function questionFor(proc, ledger) {
  const f = proc.flags || {};
  const wts = proc.worktrees || [];

  if (f.dirty) {
    const w = wts.find(x => (x.dirty || 0) > 0) || wts[0];
    return {
      type: 'question', key: `dirty:${proc.key}`, processKey: proc.key,
      question: `${w.branch} tiene ${w.dirty} archivo(s) sin commitear. ¿Qué hago?`,
      header: 'Sin commit',
      options: [
        { label: 'Commitear', description: `Genero un commit en ${w.repo}/${w.branch} con esos cambios y sigo.` },
        { label: 'Dejar', description: 'Lo dejo como está; no vuelvo a preguntar por 30 días.' },
      ],
    };
  }

  if (f.cold) {
    const w = wts[0];
    const commits = w ? (w.unpushed || 0) : 0;
    const onOrigin = w ? w.onOrigin !== false : false;
    const hasPr = (proc.prs || []).length > 0;
    const days = (ledger && ledger._coldDays) || 14;
    return {
      type: 'question', key: `cold:${proc.key}`, processKey: proc.key,
      question: `${proc.key} no se toca hace más de ${days} días. ¿Qué hago?`,
      header: 'Frío',
      options: [
        { label: 'Retomar', description: `${commits} commits sobre base${onOrigin ? ', rama en origin' : ''}${hasPr ? '' : ', sin PR'}. Lo retomo.` },
        { label: 'Dejar', description: 'Lo dejo dormido; no vuelvo a preguntar por 30 días.' },
        { label: 'Archivar', description: w ? 'git worktree remove — el branch queda en origin.' : 'Archivo el proceso.' },
      ],
    };
  }

  return null;
}

// Questions (budgeted, ordered) plus notify (pass-through). The `actions` array
// is only used to score how much each question unblocks — a question on a
// process with pending actions is worth surfacing before one on a dead-end.
function buildItems(ledger, actions, babysitNotifications) {
  const acts = actions || [];
  const scoreOf = (key) => acts.filter(a => a.processKey === key).length;

  const candidates = [];
  for (const p of ledger.processes) {
    const q = questionFor(p, ledger);
    if (q) candidates.push({ q, score: scoreOf(p.key), recency: p.lastLocalActivity || 0 });
  }
  candidates.sort((a, b) => (b.score - a.score) || (b.recency - a.recency));
  const questions = candidates.slice(0, QUESTION_BUDGET).map(c => c.q);

  return { questions, notify: (babysitNotifications || []).slice() };
}

// pr-babysit integration by aggregation: read only its STABLE surface — the
// filenames — never its internal line formats (those carry postmortems and are
// its own contract to change). Emit one notify per non-empty pending file and
// one per needs-human-<repo>-<pr>.txt. Never act on them, never claim they are
// handled. All file access is injected so this stays testable and the gate does
// no IO of its own.
function readBabysitNotifications(babysitDir, io) {
  if (!babysitDir || !io || !io.exists(babysitDir)) return [];
  const notify = [];

  const countLines = (file) => {
    try { return io.readText(file).split('\n').filter(l => l.trim()).length; }
    catch { return 0; }
  };
  const comments = countLines(`${babysitDir}/pending-comments.txt`);
  if (comments > 0) {
    notify.push({ type: 'notify', key: 'babysit:comments',
      message: `pr-babysit: ${comments} comentario(s) de review sin responder`, source: 'pr-babysit' });
  }
  const conflicts = countLines(`${babysitDir}/pending-conflicts.txt`);
  if (conflicts > 0) {
    notify.push({ type: 'notify', key: 'babysit:conflicts',
      message: `pr-babysit: ${conflicts} conflicto(s) sin resolver`, source: 'pr-babysit' });
  }

  let files = [];
  try { files = io.listFiles(babysitDir); } catch { files = []; }
  files.filter(f => /^needs-human-.+-\d+\.txt$/.test(f)).forEach(f => {
    const m = f.match(/^needs-human-(.+)-(\d+)\.txt$/);
    const repo = m ? m[1] : f;
    const pr = m ? m[2] : '';
    notify.push({ type: 'notify', key: `babysit:needs-human:${f}`,
      message: `pr-babysit: ${repo}#${pr} necesita intervención humana`, source: 'pr-babysit' });
  });

  return notify;
}

// The whole gate for one pass. `opts` carries the pr-babysit dir and the
// injected io; both optional (absent dir → no notify). Actions are computed once
// and passed to buildItems so a question's unblock score is real.
function buildGate(ledger, now, opts) {
  const o = opts || {};
  const babysit = readBabysitNotifications(o.babysitDir, o.io);
  const actions = buildActions(ledger);
  const { questions, notify } = buildItems(ledger, actions, babysit);
  return { version: 1, generatedAt: now, actions, questions, notify };
}

// The heartbeat's exit contract. A gh failure makes the whole PR half
// untrustworthy, so it degrades (4) regardless of what was found — a clean-
// looking 0 there would be the platform's founding bug. Otherwise 10 if
// anything surfaced, 0 if genuinely nothing. `3` (could not check) and `5`
// (lock) are the bin wrapper's / shell gate's concerns, not this pure function.
function gateExitCode(gate, ledgerWarnings) {
  const degraded = (ledgerWarnings || []).some(w => w.step && String(w.step).startsWith('gh'));
  if (degraded) return 4;
  const hasWork = gate.actions.length > 0 || gate.questions.length > 0 || gate.notify.length > 0;
  return hasWork ? 10 : 0;
}

module.exports = { buildActions, actionId, repoPath, questionFor, buildItems, QUESTION_BUDGET,
                   readBabysitNotifications, buildGate, gateExitCode };
