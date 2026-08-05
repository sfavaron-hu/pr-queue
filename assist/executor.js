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
  decline, markDone, syncItems, writeAnswer, readItem, readAnswer, writeAtomic,
  listOpenItems, pruneDeclined, pruneDone,
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
const DECLINE_LABEL = 'Dejar';
const DECLINE_TTL_DAYS = 30;

// Resolve one open queue entry (the shape listOpenItems returns). Returns the
// disposition; only "Dejar" is acted on here (decline + markDone). Everything
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

// True when the ledger's PR half is untrustworthy — a gh step failed, so any
// action that keys off "has no PR" (open-draft-pr) could fire against a branch
// that actually has one. On a degraded pass the drain touches no worktree.
function isDegraded(warnings) {
  return (warnings || []).some(w => w.step && String(w.step).startsWith('gh'));
}

// Parse the tiny flag set the CLI needs. --value/--other/--resolution take a
// value; --dry-run is boolean. Positionals are the subcommand and its id.
function parseArgs(argv) {
  const out = { _: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
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

  if (cmd === 'action') {
    const action = (gate.actions || []).find(a => a.id === id);
    if (!action) return { exit: 3, output: { ok: false, reason: 'no-such-action', id } };
    const r = runAction(exec, action);
    return { exit: r.ok ? 0 : 1, output: r };
  }

  // Default: DRAIN (unattended).
  const degraded = isDegraded(warnings);
  if (args.dryRun) {
    return { exit: 0, output: { dryRun: true, wouldRun: (gate.actions || []).map(a => a.argv), degraded } };
  }
  if (degraded) {
    const declinedPruned = pruneDeclined(io, paths);
    const donePruned = pruneDone(io, paths, 30);
    return { exit: 4, output: { degraded: true, actions: { ran: 0 }, questions: { synced: 0 }, prune: { declinedPruned, donePruned } } };
  }

  const drained = drainActions(exec, gate.actions || []);
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
      actions: { ran: drained.ran, failed: drained.failed, results: drained.results.map(r => ({ id: r.id, kind: r.kind, ok: r.ok, code: r.code })) },
      questions: {
        synced: synced.written.length, skipped: synced.skipped.length, removed: synced.removed.length, declined,
        open: openUnanswered.length, new: newIds.length,
        // Generic surface for the escalation to list — headers/keys only, no evidence.
        waiting: openUnanswered.map(o => ({ header: o.item.header, key: o.item.key, question: o.item.question })),
      },
      prune: { declinedPruned, donePruned },
      notify,
    },
  };
}

module.exports = { runAction, drainActions, applyAnswer, runCli, DECLINE_LABEL };
