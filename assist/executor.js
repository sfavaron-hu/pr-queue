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

const { decline, markDone } = require('./queue.js');

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

module.exports = { runAction, drainActions, applyAnswer };
