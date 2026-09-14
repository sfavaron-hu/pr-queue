// The deterministic half of the work assistant: a pure function of the ledger
// that splits mechanical actions from human decisions. No model, no execution,
// no IO except the injected pr-babysit reads. The gate only *identifies* work;
// running it is a later increment.
const { prIsOpen } = require('../classify.js');

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

// Every action names the `branch` it acts on. A worktree's branch is not always
// its process key — the key names the process, and one process can span repos —
// so a caller that holds leases and wants to keep the drain off live work needs
// the branch stated on the action itself, not inferred from the id string.
//
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
          kind: 'prune-worktree', processKey: p.key, repo: w.repo, branch: w.branch || null,
          cmd: `git -C ${repoPath(root, w.repo)} worktree prune`,
          argv: ['git', '-C', repoPath(root, w.repo), 'worktree', 'prune'],
          reversibility: 'reversible-metadata',
          why: 'The worktree no longer exists on disk',
          evidence: `${w.repo}: directory absent`,
        });
        continue;
      }
      if (w.detached || !w.branch || !w.path) continue;

      if (w.onOrigin === false && !consumed(w.branch)) {
        actions.push({
          id: actionId('push', p.key, w.repo, w.branch),
          kind: 'push', processKey: p.key, repo: w.repo, branch: w.branch,
          cmd: `git -C ${w.path} push -u origin ${w.branch}`,
          argv: ['git', '-C', w.path, 'push', '-u', 'origin', w.branch],
          reversibility: 'reversible-unconsumed',
          why: 'The branch is not on origin and no PR references it',
          evidence: `${w.repo}/${w.branch}: onOrigin=false, no PR consuming it`,
        });
        continue;
      }

      const clean = (w.dirty || 0) === 0;
      // "Consumed" is `merged and nothing still open` — not `every PR merged`.
      // A branch can carry a closed attempt alongside the PR that actually
      // landed; the closed one is not a reason to keep local state around, but
      // an open one always is.
      const consumedWork = prs.some(pr => pr.merged === true) && !prs.some(prIsOpen);

      if (consumedWork && clean && w.isPrimary === true && w.baseBranch) {
        // The repo's MAIN working tree cannot be removed — `git worktree remove`
        // on it exits 128, every pass, forever (observed on hu-translations and
        // material-hu). The equivalent cleanup is to park it back on its base
        // branch: same intent (stop holding consumed work), and reversible with
        // `git switch -`. The local branch is deliberately left alone; it is
        // still on origin and deleting it is not this action's business.
        actions.push({
          id: actionId('switch-primary-to-base', p.key, w.repo, w.branch),
          kind: 'switch-primary-to-base', processKey: p.key, repo: w.repo, branch: w.branch,
          cmd: `git -C ${w.path} switch ${w.baseBranch}`,
          argv: ['git', '-C', w.path, 'switch', w.baseBranch],
          reversibility: 'reversible-local',
          why: 'The main checkout is parked on work that already merged; it cannot be removed, so it goes back to base',
          evidence: `${w.repo}/${w.branch}: main checkout, PR merged, clean → ${w.baseBranch}`,
        });
        continue;
      }

      // Only auto-remove when the worktree holds NOTHING that would be lost:
      // clean (no uncommitted) AND no commits that exist only locally. If there
      // is unpushed local work, removal would silently destroy it — so we skip
      // the action and let questionFor surface it as an "Orphan" question with
      // its content, where the owner can keep it (new PR) or discard it.
      const noLocalOnlyWork = (w.unpushedLocal || 0) === 0;
      if (consumedWork && clean && noLocalOnlyWork && w.isPrimary !== true) {
        actions.push({
          id: actionId('remove-merged-worktree', p.key, w.repo, w.branch),
          kind: 'remove-merged-worktree', processKey: p.key, repo: w.repo, branch: w.branch,
          cmd: `git -C ${repoPath(root, w.repo)} worktree remove ${w.path}`,
          argv: ['git', '-C', repoPath(root, w.repo), 'worktree', 'remove', w.path],
          reversibility: 'reversible-local',
          why: 'Every PR on the process merged; the worktree is leftover local state',
          evidence: `${w.repo}/${w.branch}: PRs merged, worktree clean, no unpushed local work`,
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
          kind: 'open-draft-pr', processKey: p.key, repo: w.repo, branch: w.branch,
          // Semantic fields so a consumer can open a well-formatted PR without
          // re-parsing argv. The --fill argv stays as a mechanical fallback, but
          // the drain no longer runs this kind — a model writes the body in
          // /work-assistant (see assist/bin/run.js `drafts`).
          githubRepo: w.githubRepo, head: w.branch, base: w.baseBranch,
          cmd: `gh pr create --draft --fill -R ${w.githubRepo} --head ${w.branch} --base ${w.baseBranch}`,
          argv: ['gh', 'pr', 'create', '--draft', '--fill', '-R', w.githubRepo, '--head', w.branch, '--base', w.baseBranch],
          reversibility: 'reversible-draft',
          why: 'Branch on origin with commits above base and no PR',
          evidence: `${w.repo}/${w.branch}: ${w.unpushed} commit(s) sobre ${w.baseBranch}`,
        });
      }
    }
  }
  return actions;
}

// One AskUserQuestion call per pass holds at most 4 questions; that ceiling is
// the whole defence against approval fatigue.
//
// It is a PRESENTATION limit, not a persistence one. Truncating the emitted list
// was a real bug: the queue reconciles items/ against what the gate emits and
// deletes anything absent, so a question that merely fell out of the top 4 on a
// later pass had its file removed — and an answer written against its id came
// back `no-item`, silently losing a decision the owner had already made. (Hit
// exactly that on `dirty:fix/no-ticket-groups-notifications-config`.)
//
// So `questions` is now every question the situation warrants, and `ask` is the
// budgeted slice to put in front of the owner. The queue persists the former; the
// skill asks the latter.
const QUESTION_BUDGET = 4;

// A process key is a branch name, and a branch name does not say which repo it
// is in, where on disk, or how stale. Asked "<branch> hasn't been touched in 14
// days, what do I do?" the honest answer is "that name tells me nothing" — so every
// question below carries the evidence needed to decide without going to look.
function repoAndPath(w) {
  if (!w) return '';
  return w.isPrimary === true ? `${w.repo} (main working tree)` : `${w.repo}`;
}

// Days since the branch's own last commit. `lastCommit` is ms (parseLastCommitLog
// multiplies %ct by 1000); `null` for a prunable worktree, so the caller omits it.
function daysSince(ts, now) {
  if (!ts || !now) return null;
  return Math.floor((now - ts) / 86400000);
}

// The single most decision-changing fact about a stale branch: does it already
// have a PR, and in what state. A merged or closed PR usually means the answer is
// "nothing to resume" — which is invisible from the branch name alone.
function prSummary(prs) {
  const list = prs || [];
  if (list.length === 0) return 'no PR';
  return list.map(p => {
    const state = p.merged === true ? 'merged' : p.closed === true ? 'closed without merging' : 'open';
    return `#${p.number} ${state}`;
  }).join(', ');
}

// `M src/x.ts, ?? scratch.md` — the codes matter as much as the paths (modified
// vs untracked vs deleted is most of what decides "commit it?").
function dirtySummary(w) {
  const files = (w && w.dirtyFiles) || [];
  if (files.length === 0) return '';
  const shown = files.map(f => `${f.code} ${f.path}`).join(', ');
  const rest = (w.dirty || 0) - files.length;
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

// At most one question per process. Dirty beats cold: uncommitted changes are a
// concrete "what do I do with this" the assistant genuinely cannot resolve
// (committing is a decision, removing is data loss), whereas cold is a nudge.
// The `review` type is intentionally not produced in v1 — its actions
// (ready-for-review, merge) are out of the blast radius, and drafts already show
// in the panel's chip.
function questionFor(proc, ledger) {
  const f = proc.flags || {};
  const wts = proc.worktrees || [];
  const now = ledger && ledger.generatedAt;

  // Orphan: the PR already landed or was closed, yet the worktree still holds
  // work that exists only locally (unpushed commits and/or uncommitted changes)
  // — so it cannot be auto-removed without losing it (buildActions skips the
  // remove for exactly this case). Surface it WITH its content and offer to keep
  // it (a fresh PR) or discard it. Non-primary only: a primary checkout is parked
  // on its base by switch-primary-to-base, which loses nothing. This precedes the
  // dirty/cold cases: "the PR is done but there's stray local work" is a more
  // specific question than either.
  const oprs = proc.prs || [];
  const consumed = oprs.some(pr => pr.merged === true || pr.closed === true) && !oprs.some(prIsOpen);
  const orphanWt = consumed
    ? wts.find(x => x.isPrimary !== true && ((x.unpushedLocal || 0) > 0 || (x.dirty || 0) > 0))
    : null;
  if (orphanWt) {
    const w = orphanWt;
    const commits = w.unpushedLocal || 0;
    const bits = [];
    if (commits > 0) bits.push(`${commits} local-only commit${commits === 1 ? '' : 's'}`);
    if ((w.dirty || 0) > 0) bits.push(`${w.dirty} uncommitted file(s)`);
    return {
      type: 'question', key: `orphan:${proc.key}`, processKey: proc.key,
      question: `${w.repo}/${w.branch}: the PR ended up ${prSummary(oprs)} but there is unpushed work (${bits.join(', ')}). What do I do?`,
      header: 'Orphan',
      options: [
        { label: 'New PR',
          description: 'I open a new PR with that work. You see the commits (git log) and the files they touch (diff --stat) before anything is opened.' },
        { label: 'Discard',
          description: `I abandon the local work: git worktree remove --force ${w.path} and delete the branch. You see exactly what is lost and confirm before anything is deleted.` },
        { label: 'Leave it', description: `I leave it as it is in ${w.path}; no question about it for 30 days.` },
      ],
    };
  }

  if (f.dirty) {
    const w = wts.find(x => (x.dirty || 0) > 0) || wts[0];
    const what = dirtySummary(w);
    return {
      type: 'question', key: `dirty:${proc.key}`, processKey: proc.key,
      question: `${w.repo}/${w.branch} has ${w.dirty} uncommitted file(s)${what ? `: ${what}` : ''}. What do I do?`,
      header: 'Uncommitted',
      options: [
        { label: 'Commit',
          description: `I write a commit in ${repoAndPath(w)} with those changes and move on. PR state: ${prSummary(proc.prs)}.` },
        { label: 'Leave it', description: `I leave it as it is in ${w.path}; no question about it for 30 days.` },
      ],
    };
  }

  if (f.cold) {
    const w = wts[0];
    const commits = w ? (w.unpushed || 0) : 0;
    const onOrigin = w ? w.onOrigin !== false : false;
    const days = (ledger && ledger._coldDays) || 14;
    const stale = w ? daysSince(w.lastCommit, now) : null;
    const subject = (w && w.lastCommitSubject) ? ` Its own last commit: "${w.lastCommitSubject}".` : '';
    const age = stale === null ? '' : ` Last commit ${stale} day(s) ago.`;

    // `Archive` means `git worktree remove`, which the main working tree refuses
    // with exit 128 — offering it there would hand back an option that cannot
    // work. The equivalent for a primary checkout is to park it on its base.
    // A non-primary worktree that still holds only-local work needs `--force` +
    // a branch delete to truly abandon it (a plain `worktree remove` leaves the
    // commits on the branch ref) → that's Discard. A clean, fully-pushed one
    // just needs a plain remove → Archive. A primary checkout can't be removed
    // at all (exit 128) → park it on base.
    const hasLocalOnly = w && ((w.unpushedLocal || 0) > 0 || (w.dirty || 0) > 0);
    const archive = !w
      ? { label: 'Archive', description: 'I archive the process.' }
      : w.isPrimary === true
        ? { label: 'Park on base',
            description: `This is ${w.repo}'s main working tree: there is no worktree to remove (git worktree remove exits 128). I switch it to ${w.baseBranch || 'its base'}; the branch stays on origin.` }
        : hasLocalOnly
          ? { label: 'Discard',
              description: `I abandon the local work: git worktree remove --force ${w.path} and delete the branch. You see what is lost and confirm first.` }
          : { label: 'Archive',
              description: `git worktree remove ${w.path} — the branch stays on origin.` };

    return {
      type: 'question', key: `cold:${proc.key}`, processKey: proc.key,
      question: `${w ? `${w.repo}/${w.branch}` : proc.key} has not been touched in more than ${days} days. What do I do?`,
      header: 'Cold',
      options: [
        { label: 'Resume',
          description: `${commits} commit${commits === 1 ? '' : 's'} over ${w && w.baseBranch ? w.baseBranch : 'base'}${onOrigin ? ', branch on origin' : ', branch local only'}. PR: ${prSummary(proc.prs)}.${age}${subject}` },
        { label: 'Leave it', description: 'I leave it asleep; no question about it for 30 days.' },
        archive,
      ],
    };
  }

  return null;
}

// `questions` is every question the situation warrants, ordered most-unblocking
// first; `ask` is the budgeted slice to actually put in front of the owner. Both
// come back so persistence (which needs all of them — see QUESTION_BUDGET) and
// presentation (which needs at most 4) stop being the same list.
//
// The `actions` array is only used to score how much each question unblocks — a
// question on a process with pending actions is worth surfacing before one on a
// dead-end.
function buildItems(ledger, actions, babysitNotifications) {
  const acts = actions || [];
  const scoreOf = (key) => acts.filter(a => a.processKey === key).length;

  const candidates = [];
  for (const p of ledger.processes) {
    const q = questionFor(p, ledger);
    if (q) candidates.push({ q, score: scoreOf(p.key), recency: p.lastLocalActivity || 0 });
  }
  candidates.sort((a, b) => (b.score - a.score) || (b.recency - a.recency));
  const questions = candidates.map(c => c.q);

  return { questions, ask: questions.slice(0, QUESTION_BUDGET),
           notify: (babysitNotifications || []).slice() };
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
      message: `pr-babysit: ${conflicts} unresolved conflict(s)`, source: 'pr-babysit' });
  }

  let files = [];
  try { files = io.listFiles(babysitDir); } catch { files = []; }
  files.filter(f => /^needs-human-.+-\d+\.txt$/.test(f)).forEach(f => {
    const m = f.match(/^needs-human-(.+)-(\d+)\.txt$/);
    const repo = m ? m[1] : f;
    const pr = m ? m[2] : '';
    notify.push({ type: 'notify', key: `babysit:needs-human:${f}`,
      message: `pr-babysit: ${repo}#${pr} needs human intervention`, source: 'pr-babysit' });
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
  const { questions, ask, notify } = buildItems(ledger, actions, babysit);
  // `questions` is the full set (what the queue must persist); `ask` is the
  // budgeted slice (what the owner is shown). See QUESTION_BUDGET for why
  // collapsing the two silently destroyed answered decisions.
  return { version: 1, generatedAt: now, actions, questions, ask, notify };
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
