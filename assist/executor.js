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

module.exports = { runAction, drainActions };
