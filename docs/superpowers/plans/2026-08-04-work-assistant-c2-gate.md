# Work assistant — Increment 2: the gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the joined ledger into a deterministic split of *mechanical actions the assistant may take now* and *decisions only the owner can make* — with no model, budgeted questions, and heartbeat-compatible exit codes.

**Architecture:** A pure `deriveFlags` attaches derived booleans to each process in the ledger (extending Increment 1's `buildLedger`). A pure `assist/gate.js` reads those flags: `buildActions` emits reversible-now actions (push, open-draft-pr, prune, remove-merged-worktree), `buildItems` emits typed items (`question` budgeted to 4, `notify` from `pr-babysit` aggregation) with `AskUserQuestion`-renderable shape, `buildGate` assembles them, and `gateExitCode` maps the result to the heartbeat's exit contract. A thin `assist/bin/gate.js` runs the ledger, builds the gate, prints JSON, and exits with that code. Everything pure with IO injected; no model, no execution — the gate only *identifies* work.

**Tech Stack:** Node (no dependencies, `node --test`), the Increment 1 modules (`classify.js`, `assist/ledger.js`, `assist/prs.js`, `collect.js`, `bin/collect.js`), the `gh` CLI (only via the ledger, already built), and read-only access to `~/.claude/skills/pr-babysit/state/`.

## Global Constraints

- **No dependencies, no build step.** `node --test` only.
- **No hardcoded home directory** in any committed file — `tests/shareability.test.js` scans a `CODE` list (extended in Increment 1 to include `assist/*`); add the two new `assist/` files to it. Paths come from `process.env` / `os.homedir()` / `path.resolve(__dirname, ...)`.
- **The gate contains no model and does no execution.** It is a pure function of the ledger that *emits* actions and items as data. Running an action, dispatching a subagent, and calling `AskUserQuestion` are Increment 3/4 — do not build them here.
- **The gate does no IO of its own except the `pr-babysit` file reads, and those are injected.** `buildActions`/`buildItems`/`buildGate`/`deriveFlags` are pure. Only `readBabysitNotifications` touches files, through an injected `io` object — never `require('fs')` inside a pure function.
- **`assist/*` are Node CommonJS** (`require`/`module.exports`); `const`/`let` are fine. `classify.js` stays dual browser/Node — if you touch it, keep module top level `var`/`function`.
- **The naming trap** (copied verbatim from the spec): the collector's `unpushed` field is *commits above base* (`origin/<base>..HEAD`), NOT "commits not pushed". `push` keys off `w.onOrigin === false`, **never** off `unpushed > 0`. `open-draft-pr` uses `unpushed > 0` to mean "has commits above base", which is its correct meaning.
- **Reversibility is a property of the environment.** `consumedByOthers(branch)` = any PR on the process whose `headRef === branch` (open PR references it; merged PR consumed it — a squash-merge deletes the branch from origin, flipping `onOrigin` back to false while the work is already integrated). A consumed branch never produces a `push`.
- **A dirty worktree is never auto-resolved** — it suppresses `open-draft-pr` and `remove-merged-worktree` for that worktree and produces a `question` instead.
- **Question budget = 4 per pass**, because the skill (Increment 4) renders them with `AskUserQuestion`, which takes 1–4 questions per call. Over-budget questions are dropped, not hidden — re-derived next pass. Ordering: unblock score (count of actions on the same process) desc, then process recency desc.
- **`AskUserQuestion`-renderable** (a test enforces): every `question` has 2–4 `options` each with a `label` and an evidence-bearing `description`; `header` ≤ 12 characters; `question` text ends with `?`; no cross-item dependencies.
- **Exit codes are the heartbeat contract verbatim:** `0` looked/nothing, `10` actions and/or items found, `4` degraded (`gh` failed — the PR half is untrustworthy), `3` could not check at all (the ledger itself threw), `5` lock held (the shell gate's concern, not this JS). `0` never means "did not look".
- **`review` type is reserved, not built.** v1's blast radius (local disk, own branches on origin, draft PRs) excludes ready-for-review and merge, so a `review` item would have no action to trigger. Draft PRs are already surfaced by the panel's `draft` chip. The gate emits only `question` and `notify` in v1.

---

## File Structure

- **Create `assist/flags.js`** — pure `deriveFlags(proc, prs, state)` → the derived-boolean block the gate reads. Reuses `rowHasOpenPR`/`rowHasDraftPR` from `classify.js`.
- **Modify `assist/ledger.js`** — `buildLedger` attaches `flags: deriveFlags(proc, prs, state)` to each process. One added line plus the require. Increment 1's ledger tests stay green (adding a key is additive).
- **Create `assist/gate.js`** — `buildActions`, `questionFor`, `buildItems`, `readBabysitNotifications`, `buildGate`, `gateExitCode`, and the small helpers `actionId`/`repoPath`.
- **Create `assist/bin/gate.js`** — real-IO CLI: run the ledger (reusing `bin/collect.js`'s IO helpers + `assist/ledger.js`), build the gate, print JSON, exit with `gateExitCode` (or `3` on a thrown ledger).
- **Create `tests/assist-flags.test.js`** — `deriveFlags` over synthetic processes.
- **Create `tests/assist-gate-actions.test.js`** — `buildActions` table-driven, incl. the consumed-branch-never-pushes and dirty-suppresses cases.
- **Create `tests/assist-gate-items.test.js`** — `questionFor`/`buildItems`: budget cap, ordering, `AskUserQuestion`-renderability, `pr-babysit` notify.
- **Create `tests/assist-gate.test.js`** — `buildGate` assembly, `gateExitCode` over each state, `readBabysitNotifications` with an injected fake `io`, plus the bin smoke test.
- **Modify `tests/shareability.test.js`** — add `assist/gate.js` and `assist/bin/gate.js` to `CODE`.

---

## Task 1: `assist/flags.js` — the derived-boolean block, wired into the ledger

Give each process the booleans the gate keys off, computed once in the ledger so a future UI can read them too (the spec puts flags in the ledger's output).

**Files:**
- Create: `assist/flags.js`
- Modify: `assist/ledger.js` (require `deriveFlags`; attach `flags` in `buildLedger`'s process map)
- Test: `tests/assist-flags.test.js` (create)

**Interfaces:**
- Consumes: `rowHasOpenPR`, `rowHasDraftPR` from `classify.js`.
- Produces: `deriveFlags(proc, prs, state) -> { notOnOrigin, dirty, prunable, cold, noTicket, sessionIdle, hasOpenPR, hasDraftPR, hasMergedPR, mergedWithLiveWorktree }`. `buildLedger` now attaches `flags` to every process object alongside `prs` and `state`.

- [ ] **Step 1: Write the failing test**

Create `tests/assist-flags.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { deriveFlags } = require('../assist/flags.js');

const wt = (over) => Object.assign(
  { repo: 'r', path: '/w/r', branch: 'feat/x', detached: false, prunable: false,
    dirty: 0, unpushed: 0, onOrigin: true }, over);

test('notOnOrigin is true only for a real branch worktree confirmed absent from origin', () => {
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false })], sessions: [] }, [], 'pausa').notOnOrigin, true);
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: true })], sessions: [] }, [], 'pausa').notOnOrigin, false);
  // detached / prunable carry onOrigin:false for other reasons — never notOnOrigin
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false, detached: true })], sessions: [] }, [], 'pausa').notOnOrigin, false);
  assert.equal(deriveFlags({ worktrees: [wt({ onOrigin: false, prunable: true })], sessions: [] }, [], 'pausa').notOnOrigin, false);
});

test('dirty, prunable, sessionIdle, noTicket', () => {
  const f = deriveFlags(
    { ticket: null, worktrees: [wt({ dirty: 3 }), wt({ prunable: true })],
      sessions: [{ status: 'idle' }, { status: 'busy' }] }, [], 'pausa');
  assert.equal(f.dirty, true);
  assert.equal(f.prunable, true);
  assert.equal(f.sessionIdle, true);
  assert.equal(f.noTicket, true);
});

test('cold mirrors the frio state', () => {
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [], 'frio').cold, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [], 'pausa').cold, false);
});

test('PR flags come from the joined prs', () => {
  const open = { merged: false, draft: false };
  const draft = { merged: false, draft: true };
  const merged = { merged: true };
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [open]).hasOpenPR, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [draft]).hasDraftPR, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [merged]).hasMergedPR, true);
  assert.equal(deriveFlags({ worktrees: [], sessions: [] }, [merged]).hasOpenPR, false);
});

test('mergedWithLiveWorktree needs the mergeado state AND a present worktree', () => {
  const wts = [wt({ prunable: false, path: '/w/r' })];
  assert.equal(deriveFlags({ worktrees: wts, sessions: [] }, [{ merged: true }], 'mergeado').mergedWithLiveWorktree, true);
  // prunable directory is gone → not "live"
  assert.equal(deriveFlags({ worktrees: [wt({ prunable: true })], sessions: [] }, [{ merged: true }], 'mergeado').mergedWithLiveWorktree, false);
  // not mergeado → false regardless
  assert.equal(deriveFlags({ worktrees: wts, sessions: [] }, [], 'pausa').mergedWithLiveWorktree, false);
});

test('deriveFlags tolerates a synthetic process (no worktrees, no sessions)', () => {
  const f = deriveFlags({ ticket: 'SQSH-1', worktrees: [], sessions: [] }, [{ merged: false, draft: false }], 'esperando');
  assert.equal(f.notOnOrigin, false);
  assert.equal(f.dirty, false);
  assert.equal(f.hasOpenPR, true);
  assert.equal(f.noTicket, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-flags.test.js`
Expected: FAIL — cannot find `../assist/flags.js`.

- [ ] **Step 3: Implement `assist/flags.js`**

```javascript
// The derived-boolean block the gate keys off. Pure: a function of a process,
// its joined PRs, and its classified state — no IO. Lives in the ledger's
// output (see assist/ledger.js) so the gate and a future UI read the same
// flags rather than each recomputing them.
const { rowHasOpenPR, rowHasDraftPR } = require('../classify.js');

function deriveFlags(proc, prs, state) {
  const wts = proc.worktrees || [];
  const list = prs || [];
  return {
    // A real branch worktree the collector confirmed is absent from origin.
    // detached/prunable carry onOrigin:false for unrelated reasons (no branch /
    // no directory) and must never count — see the panel's own noOriginWorktrees.
    notOnOrigin: wts.some(w => w.onOrigin === false && !w.detached && !w.prunable),
    dirty:       wts.some(w => (w.dirty || 0) > 0),
    prunable:    wts.some(w => w.prunable),
    cold:        state === 'frio',
    noTicket:    !proc.ticket,
    sessionIdle: (proc.sessions || []).some(s => s.status === 'idle'),
    hasOpenPR:   rowHasOpenPR({ prs: list }),
    hasDraftPR:  rowHasDraftPR({ prs: list }),
    hasMergedPR: list.some(p => p.merged === true),
    // mergeado work whose worktree is still on disk — the remove-merged-worktree
    // candidate. A prunable worktree's directory is already gone, so it isn't "live".
    mergedWithLiveWorktree: state === 'mergeado' && wts.some(w => w.path && !w.prunable),
  };
}

module.exports = { deriveFlags };
```

- [ ] **Step 4: Wire `flags` into the ledger**

In `assist/ledger.js`, add near the other requires:

```javascript
const { deriveFlags } = require('./flags.js');
```

Then in `buildLedger`, change the process map so each process carries `flags`. The current line is:

```javascript
  const processes = allRows.map(({ proc, prs }) =>
    Object.assign({}, proc, { prs, state: classify(proc, prs, now) }));
```

Replace it with:

```javascript
  const processes = allRows.map(({ proc, prs }) => {
    const state = classify(proc, prs, now);
    return Object.assign({}, proc, { prs, state, flags: deriveFlags(proc, prs, state) });
  });
```

- [ ] **Step 5: Run the flags tests and the ledger tests**

Run: `node --test tests/assist-flags.test.js tests/assist-ledger.test.js`
Expected: PASS — the 6 new flags tests, and Increment 1's ledger tests unchanged (adding a `flags` key is additive; they assert specific keys, not exhaustive shape).

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS, total = 196 + 6 = **202**.

- [ ] **Step 7: Commit**

```bash
git add assist/flags.js assist/ledger.js tests/assist-flags.test.js
git commit -m "feat: derive per-process flags into the ledger"
```

---

## Task 2: `assist/gate.js` — `buildActions`

Emit the reversible-now actions, each keyed to a worktree, with the consumed-branch and dirty-worktree suppressions baked in.

**Files:**
- Create: `assist/gate.js`
- Test: `tests/assist-gate-actions.test.js` (create)

**Interfaces:**
- Consumes: a ledger (from `assist/ledger.js`), whose processes carry `worktrees`, `prs`, `flags`, `key`.
- Produces:
  - `buildActions(ledger) -> [ { id, kind, processKey, repo, cmd, reversibility, why, evidence } ]`
  - helpers `actionId(kind, processKey, repo, branch)` and `repoPath(workspaceRoot, repo)` (used again in later tasks).

- [ ] **Step 1: Write the failing test**

Create `tests/assist-gate-actions.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { buildActions } = require('../assist/gate.js');

const wt = (over) => Object.assign(
  { repo: 'humand-web', path: '/w/humand-web', branch: 'feat/SQSH-1', detached: false,
    prunable: false, dirty: 0, unpushed: 0, onOrigin: true,
    githubRepo: 'HumandDev/humand-web', baseBranch: 'develop' }, over);

const ledger = (processes) => ({ workspaceRoot: '/w', processes });
const proc = (over) => Object.assign({ key: 'SQSH-1', worktrees: [], prs: [] }, over);

const kinds = (acts) => acts.map(a => a.kind).sort();

test('push fires for a branch absent from origin and not consumed', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ onOrigin: false })], prs: [] })]));
  assert.deepEqual(kinds(acts), ['push']);
  assert.match(acts[0].cmd, /git -C \/w\/humand-web push -u origin feat\/SQSH-1/);
  assert.equal(acts[0].reversibility, 'reversible-unconsumed');
});

test('push does NOT fire when a PR references the branch (consumed)', () => {
  // A merged PR on the same headRef means the branch was consumed (squash-merge
  // deletes it from origin, flipping onOrigin back to false) — never re-push it.
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ onOrigin: false })],
    prs: [{ headRef: 'feat/SQSH-1', merged: true }] })]));
  assert.equal(acts.filter(a => a.kind === 'push').length, 0);
});

test('open-draft-pr fires for an on-origin branch with commits above base, no PR, clean', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ unpushed: 3 })], prs: [] })]));
  assert.deepEqual(kinds(acts), ['open-draft-pr']);
  assert.match(acts[0].cmd, /gh pr create --draft --fill -R HumandDev\/humand-web --head feat\/SQSH-1 --base develop/);
});

test('a dirty worktree suppresses open-draft-pr (no autonomous resolution)', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ unpushed: 3, dirty: 2 })], prs: [] })]));
  assert.equal(acts.filter(a => a.kind === 'open-draft-pr').length, 0);
});

test('open-draft-pr does NOT fire when the process already has a PR', () => {
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ unpushed: 3 })], prs: [{ headRef: 'feat/SQSH-1', merged: false }] })]));
  assert.equal(acts.filter(a => a.kind === 'open-draft-pr').length, 0);
});

test('open-draft-pr never fires off unpushed>0 alone when the branch is not on origin (it pushes instead)', () => {
  // The naming trap: unpushed is commits-above-base. A not-on-origin branch with
  // commits pushes; it must not try to open a PR for a branch that isn't pushed.
  const acts = buildActions(ledger([proc({ worktrees: [wt({ onOrigin: false, unpushed: 3 })], prs: [] })]));
  assert.deepEqual(kinds(acts), ['push']);
});

test('remove-merged-worktree fires when every PR is merged, the dir is present and clean', () => {
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ dirty: 0 })], prs: [{ headRef: 'feat/SQSH-1', merged: true }] })]));
  assert.equal(acts.filter(a => a.kind === 'remove-merged-worktree').length, 1);
  assert.match(acts.find(a => a.kind === 'remove-merged-worktree').cmd,
    /git -C \/w\/humand-web worktree remove \/w\/humand-web/);
});

test('remove-merged-worktree is suppressed by a dirty worktree', () => {
  const acts = buildActions(ledger([proc({
    worktrees: [wt({ dirty: 2 })], prs: [{ headRef: 'feat/SQSH-1', merged: true }] })]));
  assert.equal(acts.filter(a => a.kind === 'remove-merged-worktree').length, 0);
});

test('prune-worktree fires for a worktree whose directory is gone', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ prunable: true })] })]));
  assert.deepEqual(kinds(acts), ['prune-worktree']);
  assert.match(acts[0].cmd, /git -C \/w\/humand-web worktree prune/);
});

test('a detached worktree produces no action', () => {
  const acts = buildActions(ledger([proc({ worktrees: [wt({ detached: true, branch: null, onOrigin: false })] })]));
  assert.deepEqual(acts, []);
});

test('action ids are stable and unique per (kind, process, repo, branch)', () => {
  const l = ledger([proc({ worktrees: [wt({ onOrigin: false })] })]);
  const a1 = buildActions(l), a2 = buildActions(l);
  assert.equal(a1[0].id, a2[0].id);
  assert.equal(a1[0].id, 'push:SQSH-1:humand-web:feat/SQSH-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-gate-actions.test.js`
Expected: FAIL — cannot find `../assist/gate.js`.

- [ ] **Step 3: Implement `buildActions` in `assist/gate.js`**

```javascript
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

module.exports = { buildActions, actionId, repoPath };
```

- [ ] **Step 4: Run the actions tests**

Run: `node --test tests/assist-gate-actions.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 202 + 11 = **213**.

- [ ] **Step 6: Commit**

```bash
git add assist/gate.js tests/assist-gate-actions.test.js
git commit -m "feat: gate buildActions — reversible-now actions with consumed/dirty guards"
```

---

## Task 3: `assist/gate.js` — `buildItems` (questions, budget, renderability)

Emit the decisions only the owner can make, as `AskUserQuestion`-renderable questions, capped at the tool's 4-per-call ceiling and ordered by how much each unblocks.

**Files:**
- Modify: `assist/gate.js` (add `QUESTION_BUDGET`, `questionFor`, `buildItems`)
- Test: `tests/assist-gate-items.test.js` (create)

**Interfaces:**
- Consumes: a ledger whose processes carry `flags`, `worktrees`, `prs`, `key`, `ticket`, `lastLocalActivity`; the `actions` array from `buildActions` (passed in, for scoring); an optional `babysitNotifications` array (from Task 4).
- Produces:
  - `questionFor(proc, ledger) -> question | null` — one question per process (dirty takes priority over cold), or null.
  - `buildItems(ledger, actions, babysitNotifications) -> { questions: [question], notify: [notify] }` — questions budgeted to 4 and ordered; notify passed through.
  - A `question` is `{ type:'question', key, processKey, question, header, options: [{label, description}] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/assist-gate-items.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { buildItems, questionFor } = require('../assist/gate.js');

const flags = (over) => Object.assign(
  { notOnOrigin: false, dirty: false, prunable: false, cold: false, noTicket: false,
    sessionIdle: false, hasOpenPR: false, hasDraftPR: false, hasMergedPR: false,
    mergedWithLiveWorktree: false }, over);
const wt = (over) => Object.assign({ repo: 'r', branch: 'feat/x', unpushed: 0, onOrigin: true, dirty: 0 }, over);
const proc = (over) => Object.assign(
  { key: 'SQSH-1', ticket: 'SQSH-1', worktrees: [], prs: [], lastLocalActivity: 0, flags: flags() }, over);
const ledger = (processes) => ({ processes, workspaceRoot: '/w' });

const renderable = (q) => {
  assert.ok(q.options.length >= 2 && q.options.length <= 4, 'options 2..4');
  q.options.forEach(o => { assert.ok(o.label && o.description, 'label+description'); });
  assert.ok(q.header.length <= 12, `header <=12: "${q.header}"`);
  assert.ok(/\?$/.test(q.question), 'ends with ?');
};

test('a dirty worktree produces a renderable question, not an action', () => {
  const q = questionFor(proc({ worktrees: [wt({ dirty: 3 })], flags: flags({ dirty: true }) }), ledger([]));
  assert.equal(q.type, 'question');
  renderable(q);
  assert.match(q.question, /sin commitear/);
});

test('a cold process produces the worked-example question', () => {
  const q = questionFor(proc({
    key: 'fix/no-ticket-tiptap-v3', ticket: null,
    worktrees: [wt({ branch: 'fix/no-ticket-tiptap-v3', unpushed: 9 })],
    flags: flags({ cold: true }) }), ledger([]));
  renderable(q);
  assert.equal(q.header, 'Frío');
  assert.match(q.options.map(o => o.label).join(','), /Retomar/);
  assert.match(q.options.find(o => o.label === 'Retomar').description, /9 commits/);
});

test('dirty takes priority over cold', () => {
  const q = questionFor(proc({ worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true, cold: true }) }), ledger([]));
  assert.match(q.question, /sin commitear/);
});

test('a process needing no decision yields no question', () => {
  assert.equal(questionFor(proc({ flags: flags() }), ledger([])), null);
});

test('the question budget caps at 4, dropping the lowest-unblock questions', () => {
  const procs = [];
  for (let i = 0; i < 6; i++) {
    procs.push(proc({ key: 'p' + i, worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: i }));
  }
  const { questions } = buildItems(ledger(procs), [], []);
  assert.equal(questions.length, 4);
});

test('questions order by unblock score, then recency', () => {
  const procs = [
    proc({ key: 'low',  worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: 100 }),
    proc({ key: 'high', worktrees: [wt({ dirty: 1 })], flags: flags({ dirty: true }), lastLocalActivity: 1 }),
  ];
  // 'high' has 2 actions on it, 'low' has 0 → 'high' first despite older recency
  const actions = [{ processKey: 'high' }, { processKey: 'high' }];
  const { questions } = buildItems(ledger(procs), actions, []);
  assert.equal(questions[0].processKey, 'high');
});

test('every emitted question is AskUserQuestion-renderable', () => {
  const procs = [
    proc({ key: 'd', worktrees: [wt({ dirty: 2 })], flags: flags({ dirty: true }) }),
    proc({ key: 'c', ticket: null, worktrees: [wt({ unpushed: 4 })], flags: flags({ cold: true }) }),
  ];
  const { questions } = buildItems(ledger(procs), [], []);
  assert.equal(questions.length, 2);
  questions.forEach(renderable);
});

test('notify items pass through untouched and unbudgeted', () => {
  const notify = [{ type: 'notify', key: 'babysit:comments', message: 'x', source: 'pr-babysit' }];
  const { notify: out } = buildItems(ledger([]), [], notify);
  assert.deepEqual(out, notify);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-gate-items.test.js`
Expected: FAIL — `buildItems`/`questionFor` are not exported from `assist/gate.js`.

- [ ] **Step 3: Add `buildItems`/`questionFor` to `assist/gate.js`**

Insert before the `module.exports` line, and extend the export:

```javascript
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
        { label: 'Retomar', description: `${commits} commit(s) sobre base${onOrigin ? ', rama en origin' : ''}${hasPr ? '' : ', sin PR'}. Lo retomo.` },
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
```

Update the export line to include the new names:

```javascript
module.exports = { buildActions, actionId, repoPath, questionFor, buildItems, QUESTION_BUDGET };
```

- [ ] **Step 4: Run the items tests**

Run: `node --test tests/assist-gate-items.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 213 + 8 = **221**.

- [ ] **Step 6: Commit**

```bash
git add assist/gate.js tests/assist-gate-items.test.js
git commit -m "feat: gate buildItems — budgeted, renderable questions plus notify passthrough"
```

---

## Task 4: `assist/gate.js` — assembly, exit code, pr-babysit aggregation

Assemble actions + items into one gate result, map it to the heartbeat's exit contract, and fold in `pr-babysit`'s pending work as `notify` — reading only its stable filenames, never its internal line formats.

**Files:**
- Modify: `assist/gate.js` (add `readBabysitNotifications`, `buildGate`, `gateExitCode`)
- Test: `tests/assist-gate.test.js` (create)

**Interfaces:**
- Consumes: a ledger with `warnings`; an `opts` of `{ babysitDir, io }` where `io = { exists(path), readText(path), listFiles(dir) }` (all injected).
- Produces:
  - `readBabysitNotifications(babysitDir, io) -> [ { type:'notify', key, message, source:'pr-babysit' } ]`
  - `buildGate(ledger, now, opts) -> { version:1, generatedAt, actions, questions, notify }`
  - `gateExitCode(gate, ledgerWarnings) -> 0 | 4 | 10`

- [ ] **Step 1: Write the failing test**

Create `tests/assist-gate.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { buildGate, gateExitCode, readBabysitNotifications } = require('../assist/gate.js');

const flags = (over) => Object.assign(
  { notOnOrigin: false, dirty: false, prunable: false, cold: false, noTicket: false,
    sessionIdle: false, hasOpenPR: false, hasDraftPR: false, hasMergedPR: false,
    mergedWithLiveWorktree: false }, over);
const proc = (over) => Object.assign(
  { key: 'SQSH-1', ticket: 'SQSH-1', worktrees: [], prs: [], lastLocalActivity: 0, flags: flags() }, over);
const ledger = (processes, warnings) => ({ processes, workspaceRoot: '/w', warnings: warnings || [] });

// A fake io whose files are a { path: contents } map and dirs a { dir: [names] } map.
const fakeIo = (files, dirs) => ({
  exists: (p) => (files && p in files) || (dirs && p in dirs),
  readText: (p) => { if (!files || !(p in files)) throw new Error('ENOENT'); return files[p]; },
  listFiles: (d) => (dirs && dirs[d]) || [],
});

test('buildGate assembles actions, questions and notify', () => {
  const g = buildGate(ledger([
    proc({ key: 'a', worktrees: [{ repo: 'r', path: '/w/r', branch: 'feat/a', onOrigin: false, dirty: 0 }], prs: [], flags: flags({ notOnOrigin: true }) }),
    proc({ key: 'b', worktrees: [{ repo: 'r', path: '/w/r2', branch: 'feat/b', dirty: 2, onOrigin: true }], prs: [], flags: flags({ dirty: true }) }),
  ]), 1000, {});
  assert.equal(g.version, 1);
  assert.equal(g.actions.filter(x => x.kind === 'push').length, 1);
  assert.equal(g.questions.length, 1);
  assert.equal(g.generatedAt, 1000);
});

test('gateExitCode: 10 when there is work, 0 when there is none', () => {
  const withWork = buildGate(ledger([proc({ worktrees: [{ repo: 'r', path: '/w/r', branch: 'feat/a', onOrigin: false, dirty: 0 }], flags: flags({ notOnOrigin: true }) })]), 0, {});
  assert.equal(gateExitCode(withWork, []), 10);
  const idle = buildGate(ledger([proc({})]), 0, {});
  assert.equal(gateExitCode(idle, []), 0);
});

test('gateExitCode: 4 when a gh warning made the PR half untrustworthy', () => {
  const g = buildGate(ledger([proc({})]), 0, {});
  assert.equal(gateExitCode(g, [{ step: 'gh-search', message: 'boom' }]), 4);
  // a non-gh warning does not degrade
  assert.equal(gateExitCode(g, [{ step: 'workspace', message: 'x' }]), 0);
});

test('readBabysitNotifications: absent dir yields nothing', () => {
  assert.deepEqual(readBabysitNotifications('/no/such', fakeIo({}, {})), []);
  assert.deepEqual(readBabysitNotifications(null, fakeIo({}, {})), []);
});

test('readBabysitNotifications: counts comments/conflicts and names each needs-human file', () => {
  const dir = '/babysit';
  const io = fakeIo({
    [`${dir}/pending-comments.txt`]: 'line1\nline2\n\nline3\n',
    [`${dir}/pending-conflicts.txt`]: '',
  }, {
    [dir]: ['pending-comments.txt', 'pending-conflicts.txt',
            'needs-human-hu-ai-agent-plugin-57.txt', 'log.txt'],
  });
  const out = readBabysitNotifications(dir, io);
  const byKey = Object.fromEntries(out.map(n => [n.key, n]));
  assert.match(byKey['babysit:comments'].message, /3 comentario/);
  assert.ok(!('babysit:conflicts' in byKey)); // empty file → no notify
  const nh = out.find(n => n.key.startsWith('babysit:needs-human'));
  assert.match(nh.message, /hu-ai-agent-plugin#57/);
  out.forEach(n => assert.equal(n.source, 'pr-babysit'));
});

test('buildGate folds pr-babysit notifications in through the injected io', () => {
  const dir = '/babysit';
  const io = fakeIo({ [`${dir}/pending-comments.txt`]: 'a\nb\n' },
                    { [dir]: ['pending-comments.txt'] });
  const g = buildGate(ledger([proc({})]), 0, { babysitDir: dir, io });
  assert.equal(g.notify.length, 1);
  assert.match(g.notify[0].message, /2 comentario/);
  // and now there IS work (a notify), so the exit code is 10
  assert.equal(gateExitCode(g, []), 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-gate.test.js`
Expected: FAIL — `buildGate`/`gateExitCode`/`readBabysitNotifications` are not exported.

- [ ] **Step 3: Add the assembly to `assist/gate.js`**

Insert before `module.exports`:

```javascript
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
```

Update the export line:

```javascript
module.exports = { buildActions, actionId, repoPath, questionFor, buildItems, QUESTION_BUDGET,
                   readBabysitNotifications, buildGate, gateExitCode };
```

- [ ] **Step 4: Run the gate tests**

Run: `node --test tests/assist-gate.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS, total = 221 + 6 = **227**.

- [ ] **Step 6: Commit**

```bash
git add assist/gate.js tests/assist-gate.test.js
git commit -m "feat: gate assembly, heartbeat exit codes, pr-babysit aggregation"
```

---

## Task 5: `assist/bin/gate.js` — the CLI, with exit codes and a live run

Wire real IO, print the gate as JSON, exit with the heartbeat code, and verify against the live machine that the split is sane.

**Files:**
- Create: `assist/bin/gate.js`
- Modify: `tests/shareability.test.js` (add the two new `assist/` files to `CODE`)
- Test: `tests/assist-gate.test.js` (append the bin smoke test)

**Interfaces:**
- Consumes: `ledger` from `assist/ledger.js`, `buildGate`/`gateExitCode` from `assist/gate.js`, `collect` from `collect.js`, `fetchOwnPRs` from `assist/prs.js`, the IO helpers from `bin/collect.js`.
- Produces: a `main()` that prints the gate JSON and returns the exit code; `module.exports = { main, babysitStateDir }`.

- [ ] **Step 1: Write the failing smoke test**

Append to `tests/assist-gate.test.js`:

```javascript
test('the bin module exposes main and babysitStateDir, and does not run on require', () => {
  const mod = require('../assist/bin/gate.js');
  assert.equal(typeof mod.main, 'function');
  assert.equal(typeof mod.babysitStateDir, 'function');
  // babysitStateDir derives from an injected env/home, never a hardcoded path
  assert.match(mod.babysitStateDir({ }, '/home/x'), /\/home\/x\/\.claude\/skills\/pr-babysit\/state$/);
  assert.match(mod.babysitStateDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/x'), /^\/cfg\/skills\/pr-babysit\/state$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-gate.test.js`
Expected: FAIL — cannot find `../assist/bin/gate.js`.

- [ ] **Step 3: Implement `assist/bin/gate.js`**

```javascript
#!/usr/bin/env node
// Real-IO wrapper around buildGate(). Runs the ledger, builds the gate, prints
// it as JSON, and exits with the heartbeat's code. Reuses bin/collect.js's IO
// helpers and assist/ledger.js — no path or fetch logic is duplicated. The
// pr-babysit state dir is read read-only through node:fs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { buildGate, gateExitCode } = require('../gate.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');

// pr-babysit keeps its state under the Claude config dir, same convention the
// collector uses for CLAUDE_CONFIG_DIR. Derived, never hardcoded.
function babysitStateDir(env, homeDir) {
  const base = (env && env.CLAUDE_CONFIG_DIR) || path.join(homeDir, '.claude');
  return path.join(base, 'skills', 'pr-babysit', 'state');
}

const fsIo = {
  exists: (p) => fs.existsSync(p),
  readText: (p) => fs.readFileSync(p, 'utf8'),
  listFiles: (d) => fs.readdirSync(d),
};

async function main() {
  let doc;
  try {
    doc = await ledger({
      collect,
      fetchOwnPRs,
      ioForCollect: {
        env: process.env, homeDir: os.homedir(),
        checkoutDir: path.resolve(__dirname, '..', '..'),
        run, listDirs, listFiles, readTail, now: () => Date.now(),
      },
      run,
      now: () => Date.now(),
    });
  } catch (err) {
    // Could not build the ledger at all — exit 3 (not 0), so a caller never
    // reads "nothing to do" from a pass that checked nothing.
    console.error(err);
    return 3;
  }

  const gate = buildGate(doc, Date.now(), {
    babysitDir: babysitStateDir(process.env, os.homedir()),
    io: fsIo,
  });
  process.stdout.write(JSON.stringify(gate, null, 2) + '\n');
  return gateExitCode(gate, doc.warnings || []);
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main, babysitStateDir };
```

- [ ] **Step 4: Add the new files to the shareability guard**

In `tests/shareability.test.js`, the `CODE` array already lists `assist/prs.js`, `assist/ledger.js`, `assist/bin/ledger.js` (added in Increment 1). Append the two new files:

```javascript
              'assist/gate.js', 'assist/bin/gate.js',
```

- [ ] **Step 5: Run the unit tests**

Run: `node --test tests/assist-gate.test.js tests/shareability.test.js`
Expected: PASS — 7 gate tests (6 + smoke) and the shareability scan (the new files use `os.homedir()`/`path`, no hardcoded paths).

- [ ] **Step 6: Live verification against the real machine**

Run:
```bash
node assist/bin/gate.js > /tmp/gate.json; echo "exit: $?"
node -e "const g=JSON.parse(require('fs').readFileSync('/tmp/gate.json')); console.log('actions', g.actions.length, '| questions', g.questions.length, '(<=4:', g.questions.length<=4, ') | notify', g.notify.length); const k={}; g.actions.forEach(a=>k[a.kind]=(k[a.kind]||0)+1); console.log('by kind:', JSON.stringify(k)); console.log('sample question:', g.questions[0] ? g.questions[0].question : '(none)'); const bad=g.questions.filter(q=>q.options.length<2||q.options.length>4||q.header.length>12||!/\\?$/.test(q.question)); console.log('non-renderable questions:', bad.length)"
```

Expected: the command prints action counts by kind, `questions <= 4: true`, and `non-renderable questions: 0`. The exit code is `10` (there is work on this machine) or `4` if `gh` degraded — **not** `0` while the ledger shows work, and never a crash. Record the verbatim output in your report. If exit is `0`, confirm the ledger genuinely had nothing actionable; if it's `4`, confirm a gh warning is present in the ledger (run `node assist/bin/ledger.js | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d.warnings)"`).

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: PASS, total = 227 + 1 = **228**.

- [ ] **Step 8: Commit**

```bash
git add assist/bin/gate.js tests/assist-gate.test.js tests/shareability.test.js
git commit -m "feat: assist/bin/gate.js — CLI with heartbeat exit codes and live-verified split"
```

---

## Self-Review notes

- **Spec coverage (§2):** actions table → Task 2 (`buildActions`, all four kinds, consumed + dirty guards, the `unpushed` naming trap); items table → Task 3 (`question`/`notify`; `review` deliberately deferred with a documented reason — v1's blast radius has no action for it); question budget = 4 = AskUserQuestion's ceiling, ordering by unblock+recency, renderability enforced by test → Task 3; `pr-babysit` aggregation by stable filename → Task 4; exit-code contract → Task 4 (`gateExitCode`) + Task 5 (`3` on ledger throw); flags the gate reads → Task 1 (in the ledger, per §1).
- **YAGNI/deferred, correctly:** `review` items (no consumer in v1); content-addressed hash ids (Increment 3's queue owns persistence; a stable string already dedups across passes — noted in `actionId`); executing any action or calling `AskUserQuestion` (Increment 4); the `5` lock exit (the shell `gate.sh` wrapper, Increment 4's heartbeat install).
- **Environment-as-reversibility** is concrete and tested: `consumedByOthers` = a PR on the process whose `headRef` matches the branch; the "merged PR ⇒ no re-push" case is a named test. Grounded on the real-machine finding that `gh pr view` returns `headRefName` even for merged PRs.
- **pr-babysit coupling** is limited to filenames (`pending-comments.txt`, `pending-conflicts.txt`, `needs-human-<repo>-<pr>.txt`) and a line count — never the internal `repo|pr|id|user|...` line format, which is pr-babysit's own contract to change.
- **Type consistency:** `deriveFlags(proc, prs, state)`; `buildActions(ledger)`; `buildItems(ledger, actions, babysitNotifications)`; `buildGate(ledger, now, {babysitDir, io})`; `gateExitCode(gate, ledgerWarnings)`; `readBabysitNotifications(babysitDir, io)` with `io = {exists, readText, listFiles}`. The `run(cmd,args,cwd)->Promise<stdout>` and ledger-injection signatures match Increment 1 exactly. A process object's shape (`key, ticket, worktrees, sessions, prs, state, flags, lastLocalActivity`) is consistent across flags, actions, and items.
- **Test-count arithmetic** (202/213/221/227/228) is a guide; Increment 1 showed the prior-total can drift. The binding check is a green `npm test` at each task, not the exact number.
