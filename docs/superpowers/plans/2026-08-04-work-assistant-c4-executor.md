# Work Assistant — Increment 4 (Executor + Skill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build C4 of the work assistant — the executor that *runs* the gate's mechanical actions and *resolves* answered queue items, plus the `/work-assistant` skill (the only model component) and the two opt-in installers.

**Architecture:** A pure `assist/executor.js` (exec + io injected, same discipline as `queue.js`/`gate.js`) holds all logic: `runAction` (one action via its `argv[]`), `drainActions`, `applyAnswer` (decline path only; everything else is left for the model), and `runCli` (the subcommand dispatcher). `assist/bin/run.js` is the thin real-IO/real-exec wrapper — `spawnSync` with no shell, and the ledger→gate builder reused from the existing bins. The skill (`.claude/skills/work-assistant/SKILL.md`) is prose that drives `run.js` and one `AskUserQuestion` call. Two installers mirror `scripts/install-launchd.sh`: symlink the skill, and drop a gated heartbeat check that shells to `run.js`.

**Tech Stack:** Node ≥ built-in `node:test`, `node:child_process` (`spawnSync`), `node:crypto` (already used). No dependencies, no build step. Bash for installers.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied from the spec (`docs/superpowers/specs/2026-08-03-work-assistant-design.md`) and the handoff.

- **The executor MUST execute `action.argv` (a `string[]`), never `action.cmd`.** No `sh -c`, no shell interpolation, no `exec()`. Real execution goes through `spawnSync(argv[0], argv.slice(1))` (or an injected `exec(argv)` in tests). A branch name can carry shell metacharacters; `cmd` is display-only. **This is the one non-negotiable.**
- **All IO and process execution is injected.** Logic lives in `assist/executor.js` and is tested with an in-memory `io` fake and a recording `exec` fake — tests never push, PR, or touch the real filesystem outside a temp dir. Real `fs`/`spawnSync` live only in `assist/bin/run.js`.
- **No new dependencies. No build step.** `npm test` is `node --test`.
- **No hardcoded home directory** in any committed file (`shareability.test.js` enforces `/Users/…` and `/home/…` are absent). Installers derive paths via `BASH_SOURCE` and `$HOME`/`${CLAUDE_CONFIG_DIR}`, and print their own uninstall — exactly like `scripts/install-launchd.sh`.
- **`state/` is gitignored** (already). The queue lives under `state/assist/`.
- **User-facing copy is Spanish**, matching the gate's existing questions/actions.
- **The queue contract is fixed (C3, done).** `assist/queue.js` exports `queuePaths, itemId, writeAtomic, decline, isDeclined, pruneDeclined, readItem, syncItems, writeAnswer, readAnswer, markDone, listOpenItems, pruneDone`. The `io` shape is the 8 methods `{ read, write, rename, remove, exists, list, mkdirp, now }`. Reuse `assist/bin/queue.js`'s `fsIo` and `stateRoot` — do not reimplement them.
- **The gate contract is fixed (C2, done).** `assist/gate.js` `buildGate(ledger, now, opts)` returns `{ version, generatedAt, actions, questions, notify }`. Each action is `{ id, kind, processKey, repo, cmd, argv, reversibility, why, evidence }` with `argv` a non-empty `string[]`. Each question is `{ type:'question', key, processKey, question, header, options:[{label,description}] }`. `gateExitCode(gate, warnings)` returns `0|10|4`.
- **Blast radius is unchanged from the spec:** local disk, the owner's own branches on origin, draft PRs only. The executor never runs a `ready-for-review`, a `merge`, or a review-comment reply. The heartbeat check **never answers its own questions** — questions wait for the owner's on-demand `/work-assistant` pass.

---

## File Structure

| File | New? | Responsibility |
|---|---|---|
| `assist/executor.js` | create | Pure logic: `runAction`, `drainActions`, `applyAnswer`, `runCli`. exec + io injected. |
| `assist/bin/run.js` | create | Real-IO/real-exec entry: `spawnSync` wrapper, ledger→gate builder, calls `runCli`. The `assist/bin/run.js <action-id>` CLI. |
| `assist/gate.js` | modify | One-line copy fix: pluralize `commit(s)` in `questionFor` (carry-note #5). |
| `.claude/skills/work-assistant/SKILL.md` | create | The `/work-assistant` on-demand entry point (prose; the only model component). |
| `.claude/skills/work-assistant/heartbeat/escalate.md` | create | The heartbeat escalation prompt (rendered by the platform on a degraded pass). |
| `scripts/install-skill.sh` | create | Opt-in: symlink the skill into `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/`. |
| `scripts/install-heartbeat-check.sh` | create | Opt-in: create `…/heartbeat/checks/work/` with a derived-path `check.json` + `gate.sh`, and copy `escalate.md`. |
| `tests/assist-executor-actions.test.js` | create | `runAction` argv-safety + `drainActions`. |
| `tests/assist-executor-answers.test.js` | create | `applyAnswer` decline vs needs-model. |
| `tests/assist-executor-cli.test.js` | create | `runCli` subcommand dispatch with injected deps. |
| `tests/assist-gate-items.test.js` | modify | Add the pluralization assertion. |
| `tests/shareability.test.js` | modify | Add the new files to the `CODE` list + assert both installers derive paths. |
| `README.md` | modify | Document the two opt-in installers, the heartbeat check, and its uninstall. |

**The executor CLI surface (`runCli`) — locked here so every task agrees:**

```
node assist/bin/run.js                       # DRAIN (default, unattended): run reversible actions,
                                             #   sync questions, apply "Dejar" declines, prune. Prints a
                                             #   digest JSON. Exit 0 clean · 4 gh-degraded · 3 ledger-failed.
node assist/bin/run.js list                  # print open items as JSON: [{id, item, answered}]
node assist/bin/run.js action <id>           # run ONE mechanical action by its gate id (fresh gate)
node assist/bin/run.js answer <id> --value "<label>"   # writeAnswer({value}), allowOther on
node assist/bin/run.js answer <id> --other "<text>"    # writeAnswer({other}), allowOther on
node assist/bin/run.js done <id> [--resolution "<text>"]  # markDone (skill calls this after a model action)
node assist/bin/run.js --dry-run …           # global: exec records argv and returns code 0 (no side effects)
```

---

## Task 1: `assist/executor.js` — `runAction` + `drainActions` (the argv-safe core)

**Model hint:** sonnet (this is the non-negotiable safety logic).

**Files:**
- Create: `assist/executor.js`
- Test: `tests/assist-executor-actions.test.js`

**Interfaces:**
- Consumes: nothing (leaf logic). The `exec` contract it defines: `exec(argv: string[]) => { code:number, stdout:string, stderr:string }`, never throwing on a non-zero exit.
- Produces:
  - `runAction(exec, action) => { id, kind, ok, code, stdout, stderr } | { id, kind, ok:false, error }`
  - `drainActions(exec, actions) => { results: [...], ran:number, failed:number }`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/assist-executor-actions.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { runAction, drainActions } = require('../assist/executor.js');

// A recording exec: captures every argv array it is handed, returns a scripted result.
function fakeExec(script) {
  const calls = [];
  const exec = (argv) => { calls.push(argv); return (script && script(argv)) || { code: 0, stdout: '', stderr: '' }; };
  exec.calls = calls;
  return exec;
}
// Action fixture: cmd carries a shell-injection payload that argv does NOT.
const action = (over) => Object.assign({
  id: 'push:p1:r:b', kind: 'push', processKey: 'p1', repo: 'r',
  cmd: 'git -C /w/r push -u origin b; rm -rf $HOME',
  argv: ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b'],
}, over);

test('runAction executes action.argv verbatim and never touches action.cmd', () => {
  const exec = fakeExec();
  runAction(exec, action());
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(exec.calls[0], ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b']);
  // The injection payload from cmd never reaches exec, in any argument, in any form.
  const flat = exec.calls[0].join('\u0000');
  assert.ok(!flat.includes('rm -rf'), 'cmd payload must not reach exec');
});

test('runAction reports ok:true on exit 0, ok:false on non-zero', () => {
  assert.equal(runAction(fakeExec(() => ({ code: 0, stdout: 'ok', stderr: '' })), action()).ok, true);
  const bad = runAction(fakeExec(() => ({ code: 1, stdout: '', stderr: 'boom' })), action());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, 'boom');
});

test('runAction refuses an action with no argv (never falls back to cmd)', () => {
  const exec = fakeExec();
  const r = runAction(exec, action({ argv: undefined }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-argv');
  assert.equal(exec.calls.length, 0);   // nothing executed
});

test('runAction refuses a non-string-array argv', () => {
  const exec = fakeExec();
  assert.equal(runAction(exec, action({ argv: [] })).error, 'no-argv');
  assert.equal(runAction(exec, action({ argv: ['git', 42] })).error, 'no-argv');
  assert.equal(exec.calls.length, 0);
});

test('drainActions runs every action and continues past a failure', () => {
  const exec = fakeExec((argv) => ({ code: argv.includes('bad') ? 1 : 0, stdout: '', stderr: '' }));
  const res = drainActions(exec, [
    action({ id: 'a', argv: ['git', 'ok'] }),
    action({ id: 'b', argv: ['git', 'bad'] }),
    action({ id: 'c', argv: ['git', 'ok'] }),
  ]);
  assert.equal(res.ran, 3);
  assert.equal(res.failed, 1);
  assert.equal(res.results.length, 3);
  assert.equal(res.results.find(r => r.id === 'b').ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-executor-actions.test.js`
Expected: FAIL — `Cannot find module '../assist/executor.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/assist-executor-actions.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add assist/executor.js tests/assist-executor-actions.test.js
git commit -m "feat(assist): executor runAction/drainActions (argv-only, no shell)"
```

---

## Task 2: `applyAnswer` — the decline path (everything else defers to the model)

**Model hint:** sonnet.

**Files:**
- Modify: `assist/executor.js`
- Test: `tests/assist-executor-answers.test.js`

**Interfaces:**
- Consumes: `runAction`/`drainActions` (Task 1); the queue's `decline`, `markDone` from `assist/queue.js`.
- Produces: `applyAnswer(io, paths, entry) => { id, done, status }` where `entry = { id, item, answer }` (the shape `listOpenItems` returns) and `status ∈ 'unanswered' | 'declined' | 'needs-model'`.

**Design note (carry-notes #2 and the "unattended costs no tokens" invariant):** Only the **"Dejar"** answer is resolved mechanically — it records a 30-day `decline` and `markDone`. `markDone` already removes the item and answer; and even if it did not, the next `syncItems` sweeps a declined item (C3 invariant, `assist-queue-sync.test.js`). Every other value (`Retomar`, `Commitear`, `Archivar`) and any `{ other }` free text needs judgment or a worktree mutation on possibly-dirty state, so it is returned as `needs-model` and left in the queue for the on-demand skill. This is also why cold cleanup is never autonomous (spec Non-goals). The literal `"Dejar"` is the gate's own decline label (`assist/gate.js` `questionFor`) — the coupling is intentional and asserted by a test so a gate copy change can't silently break the decline path.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/assist-executor-answers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { applyAnswer } = require('../assist/executor.js');
const { queuePaths, itemId, syncItems, writeAnswer } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, _setNow: (t) => { clock = t; }, now: () => clock,
    read: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    write: (p, s) => { files.set(p, s); },
    rename: (a, b) => { if (!files.has(a)) throw new Error('ENOENT ' + a); files.set(b, files.get(a)); files.delete(a); },
    remove: (p) => { files.delete(p); }, exists: (p) => files.has(p),
    list: (dir) => { const pre = dir.endsWith('/') ? dir : dir + '/'; const n = new Set(); for (const k of files.keys()) if (k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: () => {} };
}
// A cold question, shaped exactly like the gate emits it.
const coldItem = (over) => Object.assign({
  type: 'question', key: 'cold:p1', processKey: 'p1',
  question: 'p1 no se toca hace más de 14 días. ¿Qué hago?', header: 'Frío',
  options: [{ label: 'Retomar', description: '…' }, { label: 'Dejar', description: '…' }, { label: 'Archivar', description: '…' }],
}, over);

function seed(io, item, answerValue) {
  const paths = queuePaths('/s');
  syncItems(io, paths, [item]);
  const id = itemId(item);
  if (answerValue) writeAnswer(io, paths, id, { value: answerValue }, { allowOther: true });
  return { paths, id };
}

test('applyAnswer: an unanswered item is left alone', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), null);
  const r = applyAnswer(io, paths, { id, item: coldItem(), answer: null });
  assert.equal(r.status, 'unanswered');
  assert.equal(r.done, false);
  assert.equal(io.exists(`${paths.items}/${id}.json`), true);   // still open
});

test('applyAnswer: "Dejar" declines for 30 days and marks the item done', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), 'Dejar');
  const r = applyAnswer(io, paths, { id, item: coldItem(), answer: { value: 'Dejar' } });
  assert.equal(r.status, 'declined');
  assert.equal(r.done, true);
  assert.equal(io.exists(`${paths.declined}/${id}.json`), true);      // decline recorded
  assert.equal(io.exists(`${paths.done}/${id}.json`), true);          // moved to done
  assert.equal(io.exists(`${paths.items}/${id}.json`), false);        // cleared from items
  const decl = JSON.parse(io.read(`${paths.declined}/${id}.json`));
  assert.equal(decl.until, 1000 + 30 * 86400000);
});

test('applyAnswer: a declined item stays suppressed on the next syncItems', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), 'Dejar');
  applyAnswer(io, paths, { id, item: coldItem(), answer: { value: 'Dejar' } });
  const res = syncItems(io, paths, [coldItem()]);   // gate still emits it next pass
  assert.deepEqual(res.skipped, [id]);              // suppressed by the decline
  assert.equal(io.exists(`${paths.items}/${id}.json`), false);
});

test('applyAnswer: non-Dejar values are left for the model, not resolved', () => {
  for (const value of ['Retomar', 'Archivar', 'Commitear']) {
    const io = memIo(1000); const { paths, id } = seed(io, coldItem(), value);
    const r = applyAnswer(io, paths, { id, item: coldItem(), answer: { value } });
    assert.equal(r.status, 'needs-model', value);
    assert.equal(r.done, false, value);
    assert.equal(io.exists(`${paths.items}/${id}.json`), true, value);   // still open for the skill
  }
});

test('applyAnswer: an { other } free-text answer is needs-model', () => {
  const io = memIo(1000); const { paths, id } = seed(io, coldItem(), null);
  writeAnswer(io, paths, id, { other: 'dale pero primero rebasealo' }, { allowOther: true });
  const r = applyAnswer(io, paths, { id, item: coldItem(), answer: { other: 'dale pero primero rebasealo' } });
  assert.equal(r.status, 'needs-model');
  assert.equal(r.done, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-executor-answers.test.js`
Expected: FAIL — `applyAnswer is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `assist/executor.js` (require the queue helpers at the top, export `applyAnswer`):

```javascript
const { decline, markDone } = require('./queue.js');

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
```

Update the `module.exports` line to include `applyAnswer`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/assist-executor-answers.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add assist/executor.js tests/assist-executor-answers.test.js
git commit -m "feat(assist): executor applyAnswer (decline path; rest defers to model)"
```

---

## Task 3: `runCli` dispatcher + `assist/bin/run.js` real wiring

**Model hint:** sonnet (includes a live, side-effect-free run).

**Files:**
- Modify: `assist/executor.js` (add `runCli`)
- Create: `assist/bin/run.js`
- Test: `tests/assist-executor-cli.test.js`

**Interfaces:**
- Consumes: `runAction`, `drainActions`, `applyAnswer` (Tasks 1–2); the queue's `queuePaths, syncItems, writeAnswer, markDone, listOpenItems, pruneDeclined, pruneDone`; `assist/bin/queue.js`'s `fsIo` and `stateRoot`; `assist/bin/gate.js`'s `babysitStateDir`; `assist/ledger.js` `ledger` and `assist/gate.js` `buildGate` + `gateExitCode`.
- Produces (from `assist/executor.js`): `runCli(argv, deps) => { exit:number, output:object }` where
  ```
  deps = {
    io,                                  // 8-method queue io (fsIo in prod)
    exec,                                // exec(argv) => {code,stdout,stderr}
    paths,                               // queuePaths(stateRoot)
    loadGate: async () => ({ gate, warnings }),   // fresh gate for drain/action/list
    now: () => ms,
  }
  ```

**Design notes:**
- **`runCli` is async** (it awaits `loadGate`). It returns `{ exit, output }`; the bin prints `output` as JSON and `process.exit(exit)`.
- **Degraded (gh-failed) drains are dangerous and must not run actions.** `open-draft-pr` keys off `prs.length === 0`; a failed `gh` fetch makes `prs` empty, so a branch that *does* have a PR would falsely qualify for a new draft. So: when `warnings` contains a `gh…` step, the drain **skips `drainActions` and `syncItems` entirely**, prunes only, and exits `4`. A test covers this.
- **`--dry-run`** swaps `exec` for a recorder that returns `{code:0}` without spawning — the safety valve for the live sanity check and for the owner to preview.
- `bin/run.js` builds `exec` from `spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })` → `{ code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }`. **`spawnSync`, not `exec`/`execSync`** — no shell is ever spawned.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/assist-executor-cli.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { runCli } = require('../assist/executor.js');
const { queuePaths, itemId, syncItems, readAnswer } = require('../assist/queue.js');

function memIo(nowMs) {
  const files = new Map(); let clock = nowMs || 0;
  return { _files: files, now: () => clock,
    read: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    write: (p, s) => { files.set(p, s); },
    rename: (a, b) => { if (!files.has(a)) throw new Error('ENOENT ' + a); files.set(b, files.get(a)); files.delete(a); },
    remove: (p) => { files.delete(p); }, exists: (p) => files.has(p),
    list: (dir) => { const pre = dir.endsWith('/') ? dir : dir + '/'; const n = new Set(); for (const k of files.keys()) if (k.startsWith(pre)) n.add(k.slice(pre.length).split('/')[0]); return [...n]; },
    mkdirp: () => {} };
}
function fakeExec(script) {
  const calls = [];
  const exec = (argv) => { calls.push(argv); return (script && script(argv)) || { code: 0, stdout: '', stderr: '' }; };
  exec.calls = calls; return exec;
}
const pushAction = { id: 'push:p1:r:b', kind: 'push', processKey: 'p1', repo: 'r',
  cmd: 'git -C /w/r push -u origin b', argv: ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b'] };
const coldItem = { type: 'question', key: 'cold:p1', processKey: 'p1',
  question: 'p1 no se toca hace más de 14 días. ¿Qué hago?', header: 'Frío',
  options: [{ label: 'Retomar', description: '…' }, { label: 'Dejar', description: '…' }] };
const gate = (over) => Object.assign({ version: 1, generatedAt: 0, actions: [pushAction], questions: [coldItem], notify: [] }, over);
const deps = (io, exec, over) => Object.assign({
  io, exec, paths: queuePaths('/s'), now: () => 1000,
  loadGate: async () => ({ gate: gate(), warnings: [] }),
}, over);

test('drain runs reversible actions, syncs questions, and prunes; exit 0', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec));
  assert.equal(res.exit, 0);
  assert.deepEqual(exec.calls[0], ['git', '-C', '/w/r', 'push', '-u', 'origin', 'b']);   // action ran via argv
  assert.equal(io.exists(`${queuePaths('/s').items}/${itemId(coldItem)}.json`), true);   // question queued
  assert.equal(res.output.actions.ran, 1);
  assert.equal(res.output.questions.synced, 1);
});

test('drain applies a "Dejar" answer already sitting in the queue', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  io.write(`${paths.answers}/${itemId(coldItem)}.json`, JSON.stringify({ value: 'Dejar' }));
  const res = await runCli([], deps(io, fakeExec()));
  assert.equal(io.exists(`${paths.done}/${itemId(coldItem)}.json`), true);   // resolved
  assert.equal(res.output.questions.declined, 1);
});

test('a gh-degraded drain skips actions and syncing, prunes only, exits 4', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli([], deps(io, exec, {
    loadGate: async () => ({ gate: gate(), warnings: [{ step: 'gh:fetchOwnPRs', error: 'boom' }] }),
  }));
  assert.equal(res.exit, 4);
  assert.equal(exec.calls.length, 0);   // NOTHING executed while PR half is untrustworthy
  assert.equal(io.exists(`${queuePaths('/s').items}/${itemId(coldItem)}.json`), false);
});

test('action <id> runs exactly the matching action, by argv', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['action', 'push:p1:r:b'], deps(io, exec));
  assert.equal(res.exit, 0);
  assert.deepEqual(exec.calls, [['git', '-C', '/w/r', 'push', '-u', 'origin', 'b']]);
});

test('action <unknown-id> executes nothing and exits non-zero', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['action', 'nope'], deps(io, exec));
  assert.notEqual(res.exit, 0);
  assert.equal(exec.calls.length, 0);
});

test('answer <id> --value writes a valid answer and rejects a bad one', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const ok = await runCli(['answer', itemId(coldItem), '--value', 'Dejar'], deps(io, fakeExec()));
  assert.equal(ok.output.ok, true);
  assert.deepEqual(readAnswer(io, paths, itemId(coldItem)), { value: 'Dejar' });
  const bad = await runCli(['answer', itemId(coldItem), '--value', 'Nope'], deps(io, fakeExec()));
  assert.equal(bad.output.ok, false);
  assert.equal(bad.output.reason, 'bad-value');
});

test('answer <id> --other is accepted (allowOther on from the skill path)', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const r = await runCli(['answer', itemId(coldItem), '--other', 'rebasealo primero'], deps(io, fakeExec()));
  assert.equal(r.output.ok, true);
  assert.deepEqual(readAnswer(io, paths, itemId(coldItem)), { other: 'rebasealo primero' });
});

test('done <id> marks the item done', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const r = await runCli(['done', itemId(coldItem), '--resolution', 'retomado en subagente'], deps(io, fakeExec()));
  assert.equal(r.exit, 0);
  assert.equal(io.exists(`${paths.done}/${itemId(coldItem)}.json`), true);
  assert.equal(io.exists(`${paths.items}/${itemId(coldItem)}.json`), false);
});

test('list prints open items with their answered flag', async () => {
  const io = memIo(1000); const paths = queuePaths('/s');
  syncItems(io, paths, [coldItem]);
  const r = await runCli(['list'], deps(io, fakeExec()));
  assert.equal(r.output.length, 1);
  assert.equal(r.output[0].id, itemId(coldItem));
  assert.equal(r.output[0].answered, false);
});

test('--dry-run never calls exec even in drain', async () => {
  const io = memIo(1000); const exec = fakeExec();
  const res = await runCli(['--dry-run'], deps(io, exec));
  assert.equal(exec.calls.length, 0);
  assert.equal(res.output.dryRun, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-executor-cli.test.js`
Expected: FAIL — `runCli is not a function`.

- [ ] **Step 3a: Implement `runCli` in `assist/executor.js`**

```javascript
const {
  queuePaths, syncItems, writeAnswer, markDone, listOpenItems, pruneDeclined, pruneDone,
} = require('./queue.js');

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

// The executor CLI. Async because a fresh gate requires the (network) ledger.
// deps: { io, exec, paths, loadGate: async () => ({gate,warnings}), now }.
async function runCli(argv, deps) {
  const { io, paths, loadGate } = deps;
  // On a dry run, no argv ever reaches the real world.
  const exec = deps.dryRun || (argv.includes('--dry-run'))
    ? (a) => { (exec.calls = exec.calls || []).push(a); return { code: 0, stdout: '', stderr: '' }; }
    : deps.exec;
  const args = parseArgs(argv);
  const [cmd, id] = args._;

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
    markDone(io, paths, id, { resolution: args.resolution || 'done-by-skill' });
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
  return {
    exit: 0,
    output: {
      actions: { ran: drained.ran, failed: drained.failed, results: drained.results.map(r => ({ id: r.id, kind: r.kind, ok: r.ok, code: r.code })) },
      questions: { synced: synced.written.length, skipped: synced.skipped.length, removed: synced.removed.length, declined },
      prune: { declinedPruned, donePruned },
    },
  };
}
```

Update `module.exports` to `{ runAction, drainActions, applyAnswer, runCli }`.

> Note for the implementer: the `--dry-run` exec shim above references `exec` inside its own initializer — hoist it to a named `function dryExec(a){…}` if the `const exec = … ? (a)=>{…exec.calls…}` self-reference trips strict mode. The behavioural contract (no real exec on `--dry-run`, `output.dryRun === true` for a dry drain) is what the tests bind; implement it however reads cleanly.

- [ ] **Step 3b: Implement `assist/bin/run.js` (the real wiring)**

```javascript
#!/usr/bin/env node
// Real-IO/real-exec entry for the executor. Builds a fresh ledger→gate (reusing
// the same wiring as assist/bin/queue.js and assist/bin/gate.js) and runs the
// executor CLI. Process execution goes through spawnSync — NEVER a shell — so a
// branch name carrying shell metacharacters cannot inject. state/ is gitignored.
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { buildGate } = require('../gate.js');
const { babysitStateDir } = require('./gate.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');
const { queuePaths } = require('../queue.js');
const { fsIo, stateRoot } = require('./queue.js');
const { runCli } = require('../executor.js');

// The one place a child process is spawned. execFile-style: argv[0] is the
// program, the rest are literal args — no shell, no interpolation. Never throws
// on a non-zero exit; the code is a value the caller inspects.
function exec(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  return { code: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  const checkoutDir = path.resolve(__dirname, '..', '..');
  const loadGate = async () => {
    const doc = await ledger({
      collect, fetchOwnPRs,
      ioForCollect: { env: process.env, homeDir: os.homedir(), checkoutDir, run, listDirs, listFiles, readTail, now: () => Date.now() },
      run, now: () => Date.now(),
    });
    const gate = buildGate(doc, Date.now(), {
      babysitDir: babysitStateDir(process.env, os.homedir()),
      io: { exists: fsIo.exists, readText: fsIo.read, listFiles: (d) => fsIo.list(d) },
    });
    return { gate, warnings: doc.warnings || [] };
  };

  const paths = queuePaths(stateRoot(checkoutDir));
  [paths.items, paths.answers, paths.done, paths.declined, paths.tmp].forEach(fsIo.mkdirp);

  const res = await runCli(process.argv.slice(2), { io: fsIo, exec, paths, loadGate, now: () => Date.now() });
  process.stdout.write(JSON.stringify(res.output, null, 2) + '\n');
  return res.exit;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(3); });
}

module.exports = { main, exec };
```

- [ ] **Step 4a: Run the unit tests**

Run: `node --test tests/assist-executor-cli.test.js`
Expected: PASS (all cases above).

- [ ] **Step 4b: Live sanity — no side effects**

The only safe live checks are ones that never spawn a mutating command:

```bash
node assist/bin/run.js list                       # prints [] or open items, exit 0
node assist/bin/run.js action definitely-not-an-id ; echo "exit=$?"   # exit=3, nothing spawned
node assist/bin/run.js --dry-run                  # prints wouldRun:[…argv…], no push/PR happens
```

Expected: `list` prints valid JSON; the unknown `action` exits `3` with `no-such-action`; `--dry-run` prints the argv it *would* run and exits `0`. **Do not run a bare `node assist/bin/run.js` drain here — it would really push and open draft PRs.** Confirm `git status` in a couple of the workspace repos is unchanged afterward.

- [ ] **Step 5: Commit**

```bash
git add assist/executor.js assist/bin/run.js tests/assist-executor-cli.test.js
git commit -m "feat(assist): run.js executor CLI (drain/action/answer/done/list, spawnSync no shell)"
```

---

## Task 4: The `/work-assistant` skill + the gate copy fix

**Model hint:** sonnet (prose + one-line code fix).

**Files:**
- Create: `.claude/skills/work-assistant/SKILL.md`
- Modify: `assist/gate.js` (pluralize `commit(s)` — carry-note #5)
- Modify: `tests/assist-gate-items.test.js` (assert the pluralization)
- Modify: `tests/shareability.test.js` (add `assist/executor.js`, `assist/bin/run.js` to `CODE`)

**Interfaces:**
- Consumes: `assist/bin/run.js` CLI (Task 3) and `AskUserQuestion` (the harness tool).
- Produces: the `/work-assistant` skill — no code exports.

**Design notes (load-bearing, from the spec §4 and carry-notes):**
- **One `AskUserQuestion` call per pass, ≤4 questions.** The gate already emits renderable questions (2–4 options, `header ≤12`, trailing `?`); the skill passes them through unchanged — it does **not** re-shape them (carry-note #3).
- **`allowOther: true`** — `AskUserQuestion` always offers "Other"; a typed sentence is a legitimate answer for a model to interpret (spec §3). Answers are written via `run.js answer … --other`.
- **Idle-session work goes to a subagent** (`Task`), never `claude --resume` of the owner's interactive session (spec §4). The session's `aiTitle`/`resumeCmd` stay as context and as the human's escape hatch.
- **`review` items don't exist in v1** (carry-note #4) — don't invent a ready/merge/approve flow.
- Resolve the checkout from the skill's real path (the skill is a symlink into the checkout): `ROOT="$(cd "$(dirname "$(readlink … )")/../.." && pwd)"` — never a hardcoded path.

- [ ] **Step 1: Write the failing test** (structure guard on the skill + the copy fix)

```javascript
// Add to tests/assist-gate-items.test.js
const fs = require('node:fs');
const path = require('node:path');

test('cold question pluralizes commits correctly (1 commit, 2 commits)', () => {
  const { questionFor } = require('../assist/gate.js');
  const proc = (unpushed) => ({ key: 'p1', flags: { cold: true },
    worktrees: [{ repo: 'r', branch: 'b', unpushed, onOrigin: true }], prs: [] });
  const q1 = questionFor(proc(1), { _coldDays: 14 });
  const q2 = questionFor(proc(2), { _coldDays: 14 });
  assert.match(q1.options[0].description, /\b1 commit\b/);   // singular, no trailing s
  assert.match(q2.options[0].description, /\b2 commits\b/);
});

test('the work-assistant skill states its load-bearing invariants', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'work-assistant', 'SKILL.md'), 'utf8');
  assert.match(md, /AskUserQuestion/);           // uses the one-call tool
  assert.match(md, /assist\/bin\/run\.js/);      // acts via the executor CLI, not ad-hoc shell
  assert.match(md, /subagent|Task tool/i);       // idle work → subagent
  assert.match(md, /--resume/);                  // explicitly names what NOT to do
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-gate-items.test.js`
Expected: FAIL — pluralization assertion fails ("1 commits"), and the SKILL.md read throws ENOENT.

- [ ] **Step 3a: Fix the pluralization in `assist/gate.js` `questionFor`**

Change the cold-question `Retomar` description line from:

```javascript
{ label: 'Retomar', description: `${commits} commits sobre base${onOrigin ? ', rama en origin' : ''}${hasPr ? '' : ', sin PR'}. Lo retomo.` },
```

to:

```javascript
{ label: 'Retomar', description: `${commits} commit${commits === 1 ? '' : 's'} sobre base${onOrigin ? ', rama en origin' : ''}${hasPr ? '' : ', sin PR'}. Lo retomo.` },
```

- [ ] **Step 3b: Write `.claude/skills/work-assistant/SKILL.md`**

```markdown
---
name: work-assistant
description: Use when the owner runs /work-assistant — review what the unattended assistant did on my own branches/PRs, answer the queued decisions in one pass, and execute what that unblocks. Local disk + my own origin branches + draft PRs only.
---

# Work assistant (on demand)

The deterministic half already ran (see `assist/gate.js`, `assist/queue.js`): reversible actions on my own branches are drained mechanically by the heartbeat, and the decisions that need me are sitting as files in the queue. Your job is the *interactive* pass: show what happened, ask me the open questions **once**, write my answers, and run what that unblocks.

**Blast radius — do not exceed it:** local disk, my own branches on origin, and **draft** PRs. Never ready-for-review, never merge, never reply to review comments (that is `pr-babysit`). Never `git commit --force`, never `git worktree remove --force`.

## 0. Locate the checkout

The skill is symlinked into the config dir; the pr-queue checkout is where its real path lives.

```bash
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SKILL_REAL="$(readlink -f "$CFG/skills/work-assistant" 2>/dev/null || echo "$CFG/skills/work-assistant")"
ROOT="$(cd "$SKILL_REAL/../../.." && pwd)"   # <checkout>/.claude/skills/work-assistant → <checkout>
```

Run every `run.js` command below as `node "$ROOT/assist/bin/run.js" …`.

## 1. Show the digest

Read the recent record of unattended work and the current open queue:

```bash
ls -t "$ROOT/state/assist/done" 2>/dev/null | head -20   # what got resolved while I was away
node "$ROOT/assist/bin/run.js" list                       # open items, JSON: [{id, item, answered}]
```

Summarize in two or three lines: what the drain pushed / pruned / drafted (from `done/`), and how many questions are open. Keep it readable while tired.

## 2. Ask the open questions — ONE call

Take the **unanswered** items from `list` (`answered === false`). Cap at 4 (the queue never emits more per pass). They already validate as `AskUserQuestion` input — 2–4 `options`, each with a `label` and an evidence-carrying `description`, `header ≤ 12`, trailing `?`. **Pass them through unchanged.** Make exactly **one** `AskUserQuestion` call with all of them (this single-call ceiling is the whole defence against approval fatigue; do not loop).

If there are zero unanswered questions, skip to step 4.

## 3. Write each answer, then act on it

For each answered question, write the answer through the executor (validated against the item's own options; free text is allowed here because I typed it):

```bash
node "$ROOT/assist/bin/run.js" answer <id> --value "<the label I chose>"
# or, if I picked "Other" and typed a sentence:
node "$ROOT/assist/bin/run.js" answer <id> --other "<what I typed>"
```

Then resolve by the value:

- **Dejar** → nothing to do by hand; the next drain records the 30-day decline. (You may run the drain now, step 4.)
- **Retomar** (or an "Other" that means "continue this"): the process may have an idle Claude session. Read its transcript to see where it stopped (the item's `processKey` maps to the ledger; `resumeCmd`/`aiTitle` are context). **Start the work in a subagent** via the Task tool — describe the task and the branch. **Never** `claude --resume` my interactive session: it can't be audited or parallelised. When the subagent is done, `node "$ROOT/assist/bin/run.js" done <id> --resolution "retomado en subagente: <1-line>"`.
- **Archivar**: confirm the worktree is clean first (`git -C <path> status --porcelain` empty). Then `git -C <repo> worktree remove <path>` — the branch stays on origin. If it is dirty, do **not** remove; tell me and leave the item open. Then `run.js done <id> --resolution "archivado"`.
- **Commitear**: generate a sensible commit for the uncommitted changes in that worktree and commit it; then let the next drain push/draft it. `run.js done <id> --resolution "commiteado"`.

## 4. Run the mechanical drain

Pick up any reversible actions the gate now emits (a freshly-committed branch to push, a draft to open) and apply any `Dejar` declines:

```bash
node "$ROOT/assist/bin/run.js"        # drain: push/prune/draft via argv, sync questions, apply declines, prune
```

Report the digest it prints. If it exits **4**, `gh` was degraded this pass — say so and do not treat a clean-looking result as trustworthy.

## 5. Close out

One short summary: what I answered, what got pushed/drafted/archived, what a subagent picked up (with its handle), and anything left open. End there — no menu.
```

- [ ] **Step 3c: Add the new source files to `tests/shareability.test.js`**

In the `CODE` array, append `'assist/executor.js'` and `'assist/bin/run.js'`.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/assist-gate-items.test.js tests/shareability.test.js`
Expected: PASS (pluralization + SKILL.md invariants + no hardcoded home in the new files).

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/work-assistant/SKILL.md assist/gate.js tests/assist-gate-items.test.js tests/shareability.test.js
git commit -m "feat(work-assistant): /work-assistant skill + gate commit(s) copy fix"
```

---

## Task 5: The two installers + heartbeat escalation + README

**Model hint:** sonnet.

**Files:**
- Create: `scripts/install-skill.sh`
- Create: `scripts/install-heartbeat-check.sh`
- Create: `.claude/skills/work-assistant/heartbeat/escalate.md`
- Modify: `tests/shareability.test.js` (assert both installers derive paths)
- Modify: `README.md`

**Interfaces:**
- Consumes: `assist/bin/run.js` (the heartbeat `gate.sh` execs it); the skill from Task 4.
- Produces: two opt-in installers and the escalation prompt. No code exports.

**Design notes:**
- **Both installers mirror `scripts/install-launchd.sh`:** `set -euo pipefail`, `REPO_DIR` via `BASH_SOURCE`, config dir via `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`, and a final printed **uninstall** line. No behaviour changes for a user who never runs them.
- **The heartbeat `work` check is gated by `run.js` itself.** `gate.sh` execs `node "$REPO_DIR/assist/bin/run.js"` (the drain), whose exit code *is* the heartbeat contract: `0` drained clean · `4` gh-degraded (escalate to tell me the pass is incomplete) · `3` ledger failed. The check **never answers a question** — questions wait for `/work-assistant`. `enabled:false` by default (opt-in, like the `prs` check). `interval_minutes: 20`.
- The gate's exit `10` is reserved for future model-needing residue (an idle-session diagnosis the gate does not yet emit); in v1 the drain returns `0/4/3`, so escalation fires only on a degraded pass. Say this plainly in `check.json`'s `gate` field so the design is legible.

- [ ] **Step 1: Write the failing test**

```javascript
// Add to tests/shareability.test.js — extend CODE and add installer assertions.
// 1) Append to the CODE array: 'scripts/install-skill.sh', 'scripts/install-heartbeat-check.sh'
// 2) Add:

test('the skill installer derives its paths and prints an uninstall', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/install-skill.sh'), 'utf8');
  assert.match(src, /BASH_SOURCE/);
  assert.match(src, /CLAUDE_CONFIG_DIR/);
  assert.match(src, /[Uu]ninstall/);
});

test('the heartbeat-check installer derives its paths and prints an uninstall', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/install-heartbeat-check.sh'), 'utf8');
  assert.match(src, /BASH_SOURCE/);
  assert.match(src, /CLAUDE_CONFIG_DIR/);
  assert.match(src, /run\.js/);            // the gate execs the executor
  assert.match(src, /[Uu]ninstall/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/shareability.test.js`
Expected: FAIL — the two installer files don't exist yet.

- [ ] **Step 3a: Write `scripts/install-skill.sh`**

```bash
#!/usr/bin/env bash
# Opt-in: make /work-assistant available from any workspace by symlinking the
# skill into the Claude config dir. Not required to use the panel. Paths are
# derived, never baked in. Re-runnable (idempotent).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SRC="$REPO_DIR/.claude/skills/work-assistant"
DEST="$CFG/skills/work-assistant"

if [ ! -d "$SRC" ]; then
  echo "skill source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$CFG/skills"
ln -sfn "$SRC" "$DEST"

echo "Installed /work-assistant → $DEST -> $SRC"
echo "Uninstall: rm \"$DEST\""
```

- [ ] **Step 3b: Write `.claude/skills/work-assistant/heartbeat/escalate.md`**

```markdown
This is a headless, single-turn session: no later turn and nothing watching for one. Run every command in the foreground and block until it finishes.

The deterministic drain already ran. It pushes/prunes/drafts my own branches through argv (no shell) and queues the decisions that need me — it does NOT answer questions. Its full output is on disk:

  file:   {{OUTPUT}}
  size:   {{BYTES}} bytes
  status: {{STATUS}}   (4 = gh failed mid-pass, so the PR half is untrustworthy and the drain skipped every worktree action; 10 = reserved for model-needing residue)

Read that entire file first (page with offset until you have covered all {{BYTES}} bytes). Then:

- If status is **4**: gh was degraded. Do NOT run the drain yourself and do NOT push or open PRs — the PR half is unknown, so a draft could be opened for a branch that already has a PR. Just note in your summary that this pass was incomplete and the next healthy tick (or an on-demand /work-assistant) will finish it.
- Do NOT answer any queued question. Questions are the owner's decision and wait for /work-assistant. Answering here is the failure mode this check is designed to avoid.
- Do NOT reply to review comments or touch anyone else's branch — that is pr-babysit's job, not this one.

End with a one- or two-line summary: what the drain did (from the file), and whether this pass was degraded.
```

- [ ] **Step 3c: Write `scripts/install-heartbeat-check.sh`**

```bash
#!/usr/bin/env bash
# Opt-in: register the work-assistant as a gated heartbeat check, exactly as the
# `prs` check registers pr-babysit. The gate is the mechanical drain (run.js):
# it costs no model session on a clean pass, and only escalates when gh degraded
# mid-pass. Paths are derived, never baked in. Re-runnable (idempotent).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HB="${HB_HOME:-$CFG/heartbeat}"
CHECK_DIR="$HB/checks/work"
NODE_BIN="$(command -v node)"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi
if [ ! -d "$HB/checks" ]; then
  echo "heartbeat is not installed at $HB (expected $HB/checks). Install the heartbeat platform first." >&2
  exit 1
fi

mkdir -p "$CHECK_DIR"

cat > "$CHECK_DIR/check.json" <<JSON
{
  "description": "Drains reversible local git actions (push, prune, draft PRs via --fill) on my own branches and queues the decisions that need me. Never answers its own questions.",
  "enabled": false,
  "interval_minutes": 20,
  "model": "claude-sonnet-5",
  "session_timeout_secs": 1800,
  "allowed_tools": ["Bash", "Read"],
  "implementation": "$REPO_DIR",
  "gate": "gate.sh runs assist/bin/run.js (the mechanical drain). Its exit IS the contract: 0 drained clean · 4 gh failed mid-pass so the PR half is untrustworthy and no worktree was touched · 3 the ledger could not be built. Escalation exists only to tell me a pass was incomplete — it NEVER answers a queued question; those wait for /work-assistant. Exit 10 is reserved for future model-needing residue the gate does not yet emit."
}
JSON

cat > "$CHECK_DIR/gate.sh" <<SH
#!/bin/bash
# Deterministic drain over my own branches/PRs. Exit is the heartbeat contract:
# 0 clean · 4 gh degraded · 3 ledger failed. No model — the executor runs every
# action through argv (spawnSync, no shell). Implementation lives in the repo.
exec "$NODE_BIN" "$REPO_DIR/assist/bin/run.js"
SH
chmod +x "$CHECK_DIR/gate.sh"

cp "$REPO_DIR/.claude/skills/work-assistant/heartbeat/escalate.md" "$CHECK_DIR/escalate.md"

echo "Installed heartbeat check 'work' → $CHECK_DIR (disabled by default)"
echo "Enable:    heartbeat enable work    (then: heartbeat run work)"
echo "Uninstall: rm -rf \"$CHECK_DIR\""
```

- [ ] **Step 3d: Update `README.md`**

Add a short "Work assistant (opt-in)" section documenting: the two installers, that neither is required to use the panel, that the heartbeat check is disabled by default and drains reversible actions only (questions wait for `/work-assistant`), and each installer's uninstall line. Keep the existing `PRQ_PORT`/`PRQ_WORKSPACE`/`localStorage` content intact (the existing README test still asserts it).

- [ ] **Step 4a: Run the tests**

Run: `node --test tests/shareability.test.js`
Expected: PASS.

- [ ] **Step 4b: Live sanity for the installers (no destructive side effects; use a throwaway config dir)**

```bash
TMP="$(mktemp -d)"; mkdir -p "$TMP/heartbeat/checks"
CLAUDE_CONFIG_DIR="$TMP" bash scripts/install-skill.sh
CLAUDE_CONFIG_DIR="$TMP" bash scripts/install-heartbeat-check.sh
test -L "$TMP/skills/work-assistant" && echo "skill symlink ok"
test -x "$TMP/heartbeat/checks/work/gate.sh" && echo "gate.sh ok"
grep -q "$(pwd)" "$TMP/heartbeat/checks/work/check.json" && echo "implementation path derived ok"
rm -rf "$TMP"
```

Expected: all three "ok" lines print; nothing under the real `~/.claude` is touched.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-skill.sh scripts/install-heartbeat-check.sh \
        .claude/skills/work-assistant/heartbeat/escalate.md \
        tests/shareability.test.js README.md
git commit -m "feat(work-assistant): opt-in skill + heartbeat installers, escalation prompt, README"
```

---

## Final verification (after all tasks)

- [ ] **Full suite green:** `npm test` — every test passes (baseline was 252; this increment adds ~24: 5 + 5 + 10 in the executor suites, 2 in gate-items, 2 in shareability). The binding check is a green run, not the arithmetic.
- [ ] **The argv invariant holds end-to-end:** `grep -n "action.cmd\|\.cmd\b\|sh -c\|execSync\|exec(" assist/executor.js assist/bin/run.js` shows no shell execution and no read of `.cmd` for running. Only `spawnSync` in `bin/run.js`.
- [ ] **No hardcoded home:** `npm test tests/shareability.test.js` green, and `grep -rn "/Users/\|/home/" assist/executor.js assist/bin/run.js scripts/install-*.sh .claude/skills/work-assistant` is empty.
- [ ] **No accidental mutation during verification:** `git -C <a couple of workspace repos> status` unchanged (the live checks only used `list`, an unknown `action`, `--dry-run`, and a throwaway `CLAUDE_CONFIG_DIR`).

---

## Self-Review (run against the spec §4 + the handoff carry-notes)

**Spec §4 coverage:**
- Unattended entry (drain reversible actions, sync questions, no model on a clean pass) → Task 3 (`runCli` drain) + Task 5 (heartbeat `gate.sh` + `check.json`). ✓
- On-demand entry (`/work-assistant`: digest → one `AskUserQuestion` → write answers → execute) → Task 4 (SKILL.md). ✓
- Idle sessions → subagent, never `claude --resume` → Task 4 SKILL.md step 3, asserted by the SKILL invariants test. ✓
- Mechanical actions via `assist/bin/run.js <action-id>`, no model → Task 3 (`action` subcommand). ✓
- Two installers mirroring `install-launchd.sh` → Task 5. ✓

**Carry-notes:**
1. argv never `cmd`/shell → Task 1 core + the injection test + final grep. ✓
2. `declined` writes let `syncItems` sweep → Task 2 test "stays suppressed on the next syncItems". ✓
3. `AskUserQuestion` renderability is the gate's contract; skill passes through → Task 4 SKILL.md step 2. ✓
4. No `review` items in v1 → Task 4 SKILL.md ("review items don't exist"). ✓
5. `commit(s)` pluralization → Task 4 gate fix + test. ✓
6. `open-draft-pr` uses `--fill`, model body optional → not required; drain runs the gate's existing `--fill` argv verbatim. ✓

**Hazard caught:** a gh-degraded pass fakes `prs:[]`, which would let `open-draft-pr` fire against a branch that already has a PR → Task 3 drain skips all actions and exits 4 when degraded (test: "a gh-degraded drain skips actions … exits 4"). ✓

**Type consistency:** `runAction(exec, action)`, `drainActions(exec, actions)`, `applyAnswer(io, paths, entry)`, `runCli(argv, deps)` with `deps={io,exec,paths,loadGate,now}` — used identically across Tasks 1–3 and the bin. The `exec` contract `(argv)=>{code,stdout,stderr}` and the queue `io` 8-method shape are the two fixed interfaces. ✓
