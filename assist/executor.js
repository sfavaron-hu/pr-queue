// assist/executor.js
// The work assistant's executor: the only component that RUNS the gate's
// mechanical actions and resolves answered queue items. Pure logic — process
// execution and filesystem access are injected, so tests never push, PR, or
// write outside a temp dir. Real fs/spawnSync live only in assist/bin/run.js.
//
// THE NON-NEGOTIABLE: every action is run through its `argv` (a string[]),
// passed straight to exec(argv) → spawnSync(argv[0], argv.slice(1)). `cmd` is
// human-readable display only. A branch name can carry shell metacharacters,
// so `cmd` must never be interpolated into a shell — there is no sh -c path.

const {
  decline, isDeclined, markDone, syncItems, writeAnswer, readItem, readAnswer, writeAtomic,
  listOpenItems, pruneDeclined, pruneDone, itemId,
} = require('./queue.js');

// The exec contract: exec(argv: string[]) => { code, stdout, stderr }.
// Never throws on a non-zero exit; a non-zero code is a value, not an exception.
function runAction(exec, action) {
  const argv = action && action.argv;
  const valid = Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === 'string');
  if (!valid) {
    return { id: action && action.id, kind: action && action.kind, ok: false, error: 'no-argv' };
  }
  const r = exec(argv) || { code: 1, stdout: '', stderr: 'no result' };
  return { id: action.id, kind: action.kind, ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr };
}

// Run a list of independent actions. Each is isolated: a failure is recorded
// and the next still runs (a failed push must not block an unrelated prune).
function drainActions(exec, actions) {
  const results = (actions || []).map(a => runAction(exec, a));
  return { results, ran: results.length, failed: results.filter(r => !r.ok).length };
}

// The value the gate uses for "leave it" in every question it emits
// (assist/gate.js questionFor). The only answer the executor resolves without a
// model — a declined item must stop being re-asked, and that is pure bookkeeping.
const DECLINE_LABEL = 'Leave it';
const DECLINE_TTL_DAYS = 30;

// The exact batch to put in front of the owner: the gate's budgeted slice
// (`gate.ask`), already ordered most-unblocking first, paired with the queue id
// each answer must be written against, and with anything already answered
// dropped. The caller must NOT re-derive this — it used to cap `list` itself,
// but `list` is a directory read with no order, so "the top 4" was arbitrary.
// Keeping the budget in one place is also what stops it drifting from
// QUESTION_BUDGET, which is the whole defence against approval fatigue.
//
// Declined items are filtered HERE, not only in the drain. The gate rebuilds
// its questions from the live situation every pass, so a declined question
// comes back the moment the situation persists — and "Leave it" is usually chosen
// precisely because the situation is going to persist. The two halves then
// disagree: `ask` serves questions declined until September and `writeAnswer`
// refuses all of them with `already-done`, because the drain moved them to
// `done/`. Asked forever, answerable never — which spends the question budget
// that exists to prevent fatigue.
function askBatch(io, paths, gate) {
  return (gate.ask || [])
    .map(q => ({ id: itemId(q), item: q }))
    .filter(e => readAnswer(io, paths, e.id) === null)
    .filter(e => !isDeclined(io, paths, e.id));
}

// Resolve one open queue entry (the shape listOpenItems returns). Returns the
// disposition; only "Leave it" is acted on here (decline + markDone). Everything
// else — a value that needs judgment or a worktree mutation, or free text —
// is reported needs-model and left in the queue for the on-demand skill.
function applyAnswer(io, paths, entry) {
  const answer = entry && entry.answer;
  if (!answer) return { id: entry && entry.id, done: false, status: 'unanswered' };

  if (answer.value === DECLINE_LABEL) {
    decline(io, paths, entry.id, DECLINE_TTL_DAYS);
    markDone(io, paths, entry.id, { resolution: 'declined', item: entry.item, answer });
    return { id: entry.id, done: true, status: 'declined' };
  }

  return { id: entry.id, done: false, status: 'needs-model' };
}

// The branches an agent is working in right now, passed down by whoever holds
// the leases (`mc drain`, the heartbeat's `work` gate). The queue never reads
// mission-control's lease store: a live lease is that tool's state, and reaching
// into its on-disk layout from here would make two repos share one file format.
//
// It filters ACTIONS, which is the half that mutates. A push rewrites the ref an
// agent is committing onto, and `worktree remove` deletes the tree it is
// editing; both look reversible from here and are not, because the work being
// destroyed was never on origin. The questions are filtered by the caller, which
// can show a leased one as "in progress" instead of dropping it.
//
// Matched on the branch AND on the process key: the key names the process and a
// worktree's branch is its own, so a lease that names either one covers the
// action.
function skipLeased(actions, skipBranch) {
  const leased = new Set(skipBranch || []);
  if (!leased.size) return { run: actions || [], skipped: [] };
  const run = [], skipped = [];
  for (const a of (actions || [])) {
    (leased.has(a.branch) || leased.has(a.processKey) ? skipped : run).push(a);
  }
  return { run, skipped };
}

// What a skipped action has to say for itself. A count alone turns "everything
// was leased" into "nothing to do", which is the reading this guard exists to
// prevent: the drain reports zero actions on a pass where every one of them was
// held by a live agent.
function skipReport(skipped) {
  return { count: skipped.length, branches: [...new Set(skipped.map(a => a.branch || a.processKey))] };
}

// True when the ledger's PR half is untrustworthy — a gh step failed, so any
// action that keys off "has no PR" (open-draft-pr) could fire against a branch
// that actually has one. On a degraded pass the drain touches no worktree.
//
// The gate's `unverified` list counts too: it names the branches gh went silent
// on, and a caller can build a gate without carrying the warnings that produced
// it. Either one on its own is enough to hold the drain back.
function isDegraded(warnings, gate) {
  return (warnings || []).some(w => w.step && String(w.step).startsWith('gh'))
    || ((gate && gate.unverified) || []).length > 0;
}

// Parse the tiny flag set the CLI needs. --value/--other/--resolution take a
// value; --dry-run is boolean; --skip-branch takes a value and repeats, one
// flag per branch, because a branch name can contain anything a shell would
// split on and a comma-separated list would have to invent an escape.
function parseArgs(argv) {
  const out = { _: [], dryRun: false, skipBranch: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-branch') { const v = argv[++i]; if (v) out.skipBranch.push(v); }
    else if (a === '--value' || a === '--other' || a === '--resolution') out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

// A recorder exec that never spawns anything — the --dry-run safety valve.
// Named (not a self-referencing const initializer) so it never trips strict
// mode; its own .calls list is inert bookkeeping the caller doesn't inspect.
function dryExec(a) {
  dryExec.calls = dryExec.calls || [];
  dryExec.calls.push(a);
  return { code: 0, stdout: '', stderr: '' };
}

// The executor CLI. Async because a fresh gate requires the (network) ledger.
// deps: { io, exec, paths, loadGate: async () => ({gate,warnings}), now }.
async function runCli(argv, deps) {
  const { io, paths, loadGate } = deps;
  const args = parseArgs(argv);
  const [cmd, id] = args._;
  // On a dry run, no argv ever reaches the real world.
  const exec = args.dryRun ? dryExec : deps.exec;

  if (cmd === 'list') {
    const open = listOpenItems(io, paths).map(o => ({ id: o.id, item: o.item, answered: o.answer !== null }));
    return { exit: 0, output: open };
  }

  if (cmd === 'answer') {
    const answer = args.value !== undefined ? { value: args.value }
                 : args.other !== undefined ? { other: args.other } : null;
    const res = writeAnswer(io, paths, id, answer, { allowOther: true });   // only the skill reaches this path
    return { exit: res.ok ? 0 : 1, output: res };
  }

  if (cmd === 'done') {
    // Capture the question and the owner's answer BEFORE markDone clears them,
    // so done/ (the only surviving trace, and the digest of unattended work)
    // reads as "asked X, answered Y, did Z" — not just the resolution string.
    const item = readItem(io, paths, id);
    const answer = readAnswer(io, paths, id);
    markDone(io, paths, id, { resolution: args.resolution || 'done-by-skill', item, answer });
    return { exit: 0, output: { ok: true, id } };
  }

  // The remaining commands need a fresh gate.
  const { gate, warnings } = await loadGate();
  const leased = skipLeased(gate.actions, args.skipBranch);
  const actions = leased.run;
  const leasedSkipped = skipReport(leased.skipped);

  // A draft PR is NOT a mechanical drain action: --fill would use commit messages
  // as the body. The drain pushes the branch (so it is ready) but leaves draft
  // creation to /work-assistant, where a model writes a well-formatted body. The
  // drain runs everything EXCEPT this kind; `drafts` lists them for the skill.
  const isDraft = (a) => a.kind === 'open-draft-pr';
  const draftPending = (a) => ({ id: a.id, githubRepo: a.githubRepo, head: a.head, base: a.base, repo: a.repo, why: a.why, evidence: a.evidence });

  if (cmd === 'action') {
    // A leased action reports WHY it is not being run. Folding it into
    // `no-such-action` would send the caller looking for a stale id.
    if (leased.skipped.some(a => a.id === id)) {
      return { exit: 3, output: { ok: false, reason: 'leased', id, branches: leasedSkipped.branches } };
    }
    const action = actions.find(a => a.id === id);
    if (!action) return { exit: 3, output: { ok: false, reason: 'no-such-action', id } };
    const r = runAction(exec, action);
    return { exit: r.ok ? 0 : 1, output: r };
  }

  if (cmd === 'ask') {
    return { exit: 0, output: askBatch(io, paths, gate) };
  }

  if (cmd === 'drafts') {
    // The branches the drain deliberately did NOT open a PR for — /work-assistant
    // opens each with a model-authored body.
    const drafts = actions.filter(isDraft).map(draftPending);
    return { exit: 0, output: drafts };
  }

  // Default: DRAIN (unattended).
  const mechanical = actions.filter(a => !isDraft(a));
  const draftsPending = actions.filter(isDraft).map(draftPending);
  // Named, not counted. `degraded` says the pass as a whole is not to be
  // trusted; `unverified` says which branches the untrustworthy part is about,
  // which is what lets a caller show them read-only instead of dropping them.
  const unverified = gate.unverified || [];
  const degraded = isDegraded(warnings, gate);
  // The dry run carries the questions too. A caller that wants the whole
  // picture — mission-control does — otherwise runs `ask` and `--dry-run` back
  // to back, and each one builds its own gate and pays its own `gh` round trip
  // for the same minute of state. `ask` stays, because answering does not need
  // the action list.
  if (args.dryRun) {
    return { exit: 0, output: { dryRun: true, questions: askBatch(io, paths, gate), wouldRun: mechanical.map(a => a.argv), leasedSkipped, draftsPending, degraded, unverified } };
  }
  if (degraded) {
    const declinedPruned = pruneDeclined(io, paths);
    const donePruned = pruneDone(io, paths, 30);
    return { exit: 4, output: { degraded: true, unverified, actions: { ran: 0, leasedSkipped }, questions: { synced: 0 }, prune: { declinedPruned, donePruned } } };
  }

  const drained = drainActions(exec, mechanical);
  // `gate.questions` (ALL of them), never `gate.ask` — syncItems reads absence
  // from this list as "the situation is gone" and deletes the file. See its
  // contract note: handing it the budgeted slice silently destroyed items the
  // owner had already answered.
  const synced = syncItems(io, paths, gate.questions || []);
  let declined = 0;
  for (const entry of listOpenItems(io, paths)) {
    if (applyAnswer(io, paths, entry).status === 'declined') declined++;
  }
  const declinedPruned = pruneDeclined(io, paths);
  const donePruned = pruneDone(io, paths, 30);

  // Notify throttle. The heartbeat can never ANSWER a question (no human), so
  // the most it does is ping the owner that decisions are waiting — but only
  // when a NEW one appeared, never every tick while questions sit unanswered
  // (that recurring ping is the exact fatigue the queue exists to prevent).
  // The already-notified ids live in notified.json, reconciled each pass to
  // whatever is still open, so a resolved-then-recurring question pings again.
  // The marker is written here (in the drain), BEFORE the escalation actually
  // sends the ping — so a rare failed send (Slack/MCP down) is not retried until
  // the next genuinely new question. Acceptable for v1: the panel still shows
  // the queue, and the miss self-heals; the alternative (mark only after a
  // confirmed send) buys little and couples the marker to the model session.
  const openUnanswered = listOpenItems(io, paths).filter(o => o.answer === null);
  const openIds = openUnanswered.map(o => o.id);
  const notifiedPath = `${paths.root}/notified.json`;
  let prevNotified = [];
  try { prevNotified = JSON.parse(io.read(notifiedPath)).ids || []; } catch { prevNotified = []; }
  const openSet = new Set(openIds);
  const alreadyNotified = new Set(prevNotified.filter(id => openSet.has(id)));
  const newIds = openIds.filter(id => !alreadyNotified.has(id));
  writeAtomic(io, paths, notifiedPath, { ids: openIds });
  const notify = newIds.length > 0;

  return {
    exit: notify ? 10 : 0,   // 10 escalates a model session that only sends the heads-up
    output: {
      // A bare exit code is not diagnosable: `git worktree remove` returns 128 both
      // for the main working tree and for a worktree holding untracked files, and
      // those need opposite handling. Carry stderr on failures so the reader does
      // not have to re-run the command by hand to find out which one it was.
      actions: {
        ran: drained.ran, failed: drained.failed, leasedSkipped,
        results: drained.results.map(r => ({
          id: r.id, kind: r.kind, ok: r.ok, code: r.code,
          ...(r.ok ? {} : { stderr: String(r.stderr || '').trim().slice(0, 500) }),
        })),
      },
      draftsPending: draftsPending.length,   // left for /work-assistant (model-authored body)
      questions: {
        synced: synced.written.length, skipped: synced.skipped.length,
        removed: synced.removed.length, kept: synced.kept.length, declined,
        open: openUnanswered.length, new: newIds.length,
        // Budget is a presentation limit: everything above it is persisted and
        // will be asked on a later pass. Reported so a deferred question is
        // visibly deferred rather than looking dropped.
        deferred: Math.max(0, openUnanswered.length - (gate.ask || []).length),
        // Generic surface for the escalation to list — headers/keys only, no evidence.
        waiting: openUnanswered.map(o => ({ header: o.item.header, key: o.item.key, question: o.item.question })),
      },
      prune: { declinedPruned, donePruned },
      notify,
    },
  };
}

module.exports = { runAction, drainActions, applyAnswer, skipLeased, runCli, DECLINE_LABEL };
