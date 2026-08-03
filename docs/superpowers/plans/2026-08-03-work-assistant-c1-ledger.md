# Work assistant — Increment 1: the ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one joined view of local work state + own PR state, outside the browser, as a Node CLI — reusing the exact same join the browser panel uses.

**Architecture:** The local↔PR join (`prTicket`, `attachOwnPRs`, `synthesizeProcesses`) moves out of `local.js` into `classify.js` (already dual browser/Node), so it exists once with two consumers. A new `assist/prs.js` fetches own PR state via `gh` and normalizes it to the same `pr` shape the browser produces. A new `assist/ledger.js` calls the existing `collect()` for local data, joins it against those PRs with the moved functions, and runs the existing `classify()`. A thin `assist/bin/ledger.js` wires real IO and prints. Everything is pure-function-first with IO injected, so tests never shell out or touch disk.

**Tech Stack:** Node (no dependencies, `node --test`), `gh` CLI, the existing `collect.js` / `classify.js` modules.

## Global Constraints

- **No dependencies, no build step.** `node --test` only. (repo invariant)
- **No hardcoded home directory** in any committed file — `tests/shareability.test.js` fails the build otherwise. Paths come from `process.env` / `os.homedir()` / `path.resolve(__dirname, ...)`.
- **Pure functions do the logic; IO is injected.** Match `collect.js`'s pattern: `collect(opts)` takes `run`/`listDirs`/`readTail`/`now`; the pure core is tested directly, a `bin/` wrapper supplies real IO.
- **`classify.js` is loaded as a browser `<script>` and via `require()`** — use `var`/`function` declarations and the dual-export footer already there. No `const`/`let` at module top level, no ESM.
- **The assistant queries `--author=@me` with no `org:` qualifier** — this is deliberate (fixes the bug where pr-queue's own PR renders as "sin PR"; see `render.js:272`). Do not add an org filter.
- **The `pr` contract field set** (every field the join + `classify()` consume), copied verbatim from the spec:
  ```
  owner, repo, number, title, url, headRef, draft, merged,
  ci ('green'|'failed'|'pending'|'unknown'), approved, changesReq, conflicts,
  newComments, humanReviews, updatedAt
  ```
- **`gh` failing is a warning + degraded result, never an empty `prs`** that reads as "no PRs".
- **`unpushed` is commits-above-base, not "not pushed"** — irrelevant to this increment (no actions here) but do not treat it as a push signal anywhere.

---

## File Structure

- **Modify `classify.js`** — add `prTicket`, `attachOwnPRs`, `synthesizeProcesses`, and a `PR_CONTRACT_FIELDS` constant; extend the export footer. These are moved verbatim from `local.js` (identical behaviour — the existing panel tests must keep passing).
- **Modify `local.js`** — delete the three moved function definitions and their block comments. They become globals provided by `classify.js` (loaded first in `index.html`), exactly like `safeHttpUrl`/`extractTicket` already are.
- **Create `assist/prs.js`** — pure `ciFromRollup(rollup)`, pure `buildPR(searchItem, viewData)`, and async `fetchOwnPRs({ run, now })` that shells to `gh` through the injected `run`.
- **Create `assist/ledger.js`** — pure `buildLedger(localPayload, prs, now)` and async `ledger(opts)` that calls `collect()` + `fetchOwnPRs()` and joins.
- **Create `assist/bin/ledger.js`** — real-IO wrapper (reuses the `run`/`listDirs`/`listFiles`/`readTail` shape from `bin/collect.js`), prints the ledger to stdout.
- **Create `tests/classify-join.test.js`** — the moved functions, plus the contract-sufficiency test (the join works with a PR carrying only the contract fields).
- **Create `tests/assist-prs.test.js`** — `ciFromRollup`, `buildPR` emits exactly the contract fields, `fetchOwnPRs` with an injected fake `run` (success + `gh`-fails paths).
- **Create `tests/assist-ledger.test.js`** — `buildLedger` joins + classifies a synthetic local payload against synthetic PRs; degraded-when-gh-fails.

---

## Task 1: Move the join into `classify.js`

Move the three functions with zero behavioural change, so the browser panel keeps working and Node gains the join. This task is the pure code motion; the contract additions come in Task 2.

**Files:**
- Modify: `classify.js` (add functions before the export footer at `classify.js:194`; extend footer)
- Modify: `local.js` (delete definitions at `local.js:64-123` and the `prTicket` at `local.js:52-55`)
- Test: `tests/classify-join.test.js` (create)

**Interfaces:**
- Consumes: `extractTicket(branch)` (already exported by `classify.js`)
- Produces:
  - `prTicket(pr) -> string|null` — ticket from `pr.headRef`, else from `pr.title`
  - `attachOwnPRs(processes, ownPRs) -> { rows: [{proc, prs}], unmatched: [pr] }`
  - `synthesizeProcesses(unmatchedPRs) -> [{proc, prs}]` where each `proc` has `{ key, ticket, branches, worktrees:[], sessions:[], lastLocalActivity:null, synthetic:true }`

- [ ] **Step 1: Write the failing test**

Create `tests/classify-join.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { prTicket, attachOwnPRs, synthesizeProcesses } = require('../classify.js');

const proc = (key, ticket, branches) => ({
  key, ticket: ticket || null, branches: branches || [],
  worktrees: [], sessions: [], lastLocalActivity: null,
});

test('prTicket reads the ticket from headRef, else from title', () => {
  assert.equal(prTicket({ headRef: 'feat/SQSH-3954-web' }), 'SQSH-3954');
  assert.equal(prTicket({ title: 'SQSH-3851 | algo' }), 'SQSH-3851');
  assert.equal(prTicket({ headRef: 'chore/no-ticket' }), null);
  assert.equal(prTicket({}), null);
});

test('attachOwnPRs prefers an exact headRef match over a ticket match', () => {
  const processes = [proc('SQSH-3954', 'SQSH-3954', ['feat/SQSH-3954-web']),
                     proc('other', null, ['feat/other'])];
  const pr = { headRef: 'feat/SQSH-3954-web', title: 'x' };
  const { rows, unmatched } = attachOwnPRs(processes, [pr]);
  assert.equal(rows[0].prs.length, 1);
  assert.equal(unmatched.length, 0);
});

test('attachOwnPRs falls back to a ticket match when no branch matches', () => {
  const processes = [proc('SQSH-3954', 'SQSH-3954', ['feat/SQSH-3954-web'])];
  const pr = { headRef: 'feat/SQSH-3954-copy', title: 'x' };  // different branch, same ticket
  const { rows, unmatched } = attachOwnPRs(processes, [pr]);
  assert.equal(rows[0].prs.length, 1);
  assert.equal(unmatched.length, 0);
});

test('attachOwnPRs leaves a PR matching nothing in unmatched', () => {
  const processes = [proc('SQSH-1', 'SQSH-1', ['feat/SQSH-1'])];
  const pr = { headRef: 'feat/SQSH-9', title: 'x' };
  const { unmatched } = attachOwnPRs(processes, [pr]);
  assert.equal(unmatched.length, 1);
});

test('synthesizeProcesses makes one process per ticket, sharing PRs on the same key', () => {
  const prs = [
    { headRef: 'feat/SQSH-9-web', title: 'a', owner: 'o', repo: 'r', number: 1 },
    { headRef: 'feat/SQSH-9-copy', title: 'b', owner: 'o', repo: 'r', number: 2 },
    { headRef: 'chore/loose', title: 'c', owner: 'o', repo: 'r', number: 3 },
  ];
  const out = synthesizeProcesses(prs);
  const byKey = Object.fromEntries(out.map(r => [r.proc.key, r]));
  assert.equal(byKey['SQSH-9'].prs.length, 2);
  assert.equal(byKey['SQSH-9'].proc.synthetic, true);
  assert.equal(byKey['chore/loose'].prs.length, 1);
});

test('synthesizeProcesses keys a ticketless merged PR by owner/repo#number, not headRef', () => {
  const prs = [{ title: 'merged', owner: 'o', repo: 'r', number: 42, merged: true }];  // no headRef
  const out = synthesizeProcesses(prs);
  assert.equal(out.length, 1);
  assert.equal(out[0].proc.key, 'o/r#42');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/classify-join.test.js`
Expected: FAIL — `prTicket`, `attachOwnPRs`, `synthesizeProcesses` are not exported from `classify.js`.

- [ ] **Step 3: Move the three functions into `classify.js`**

Cut `prTicket` (`local.js:52-55`), `attachOwnPRs` (`local.js:68-87`), and `synthesizeProcesses` (`local.js:102-123`) — with their block comments — out of `local.js` and paste them into `classify.js` immediately before the export footer (`classify.js:194`). Rewrite them with `function` declarations (they already are) and change any `const`/`let` *inside* them to stay as-is (function-body `const` is fine; only module top-level must avoid it — these are function bodies, so no change needed). They call `extractTicket`, already in scope in `classify.js`.

- [ ] **Step 4: Extend the export footer**

In `classify.js`, add the three names to the `module.exports` object (the footer at `classify.js:194`):

```javascript
                     filterRowsByPR: filterRowsByPR,
                     filterRowsByPRStatus: filterRowsByPRStatus,
                     prTicket: prTicket, attachOwnPRs: attachOwnPRs,
                     synthesizeProcesses: synthesizeProcesses };
```

- [ ] **Step 5: Delete the now-duplicate definitions from `local.js`**

Remove the three function definitions and their block comments from `local.js`. They are now globals from `classify.js` (loaded first in `index.html`, same as `extractTicket`/`safeHttpUrl`). Do **not** change any call sites in `local.js` — the names are identical.

- [ ] **Step 6: Run the join tests**

Run: `node --test tests/classify-join.test.js`
Expected: PASS (6 tests).

- [ ] **Step 7: Run the full suite — the panel must be unchanged**

Run: `npm test`
Expected: PASS, count = 176 + 6 = **182**. The existing `classify-pr-filter` and panel tests must still pass, proving the move was behaviour-preserving.

- [ ] **Step 8: Commit**

```bash
git add classify.js local.js tests/classify-join.test.js
git commit -m "refactor: move the local↔PR join from local.js into classify.js"
```

---

## Task 2: The `pr` contract, enforced

Pin the field set the join depends on, and prove the join needs *only* those fields — so `assist/prs.js` (Task 3) has an exact, minimal target and can never accidentally depend on a browser-only field.

**Files:**
- Modify: `classify.js` (add `PR_CONTRACT_FIELDS`, export it)
- Test: `tests/classify-join.test.js` (append)

**Interfaces:**
- Produces: `PR_CONTRACT_FIELDS` — a frozen array of the 15 contract field names.

- [ ] **Step 1: Write the failing test**

Append to `tests/classify-join.test.js`:

```javascript
const { PR_CONTRACT_FIELDS } = require('../classify.js');

test('PR_CONTRACT_FIELDS is exactly the documented field set', () => {
  assert.deepEqual([...PR_CONTRACT_FIELDS].sort(), [
    'approved', 'changesReq', 'ci', 'conflicts', 'draft', 'headRef',
    'humanReviews', 'merged', 'newComments', 'number', 'owner', 'repo',
    'title', 'updatedAt', 'url',
  ]);
});

test('the join works with a PR carrying ONLY the contract fields', () => {
  // Proves attachOwnPRs/synthesizeProcesses never read a field outside the
  // contract — the real protection behind assist/prs.js emitting just those.
  const onlyContract = {};
  for (const f of PR_CONTRACT_FIELDS) onlyContract[f] = f === 'headRef' ? 'feat/SQSH-7' : null;
  onlyContract.headRef = 'feat/SQSH-7'; onlyContract.title = 'x';
  onlyContract.owner = 'o'; onlyContract.repo = 'r'; onlyContract.number = 1;
  const processes = [proc('SQSH-7', 'SQSH-7', ['feat/SQSH-7'])];
  const { rows, unmatched } = attachOwnPRs(processes, [onlyContract]);
  assert.equal(rows[0].prs.length, 1);
  assert.equal(unmatched.length, 0);
  // and a synthetic path over the same shape
  const syn = synthesizeProcesses([{ ...onlyContract, headRef: 'feat/SQSH-8' }]);
  assert.equal(syn.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/classify-join.test.js`
Expected: FAIL — `PR_CONTRACT_FIELDS` is undefined.

- [ ] **Step 3: Add the constant**

In `classify.js`, near the top (after `var COLD_DAYS = 14;`), add:

```javascript
// Every field the local↔PR join and classify() read off a PR. It is the
// contract assist/prs.js must emit and the browser's enrichOwnPR already
// emits (as a superset). Frozen so a typo'd push can't mutate it.
var PR_CONTRACT_FIELDS = Object.freeze([
  'owner', 'repo', 'number', 'title', 'url', 'headRef', 'draft', 'merged',
  'ci', 'approved', 'changesReq', 'conflicts', 'newComments',
  'humanReviews', 'updatedAt',
]);
```

Add `PR_CONTRACT_FIELDS: PR_CONTRACT_FIELDS,` to the export footer.

- [ ] **Step 4: Run the tests**

Run: `node --test tests/classify-join.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add classify.js tests/classify-join.test.js
git commit -m "feat: pin the pr contract field set the join depends on"
```

---

## Task 3: `assist/prs.js` — own PRs via `gh`, normalized

Fetch the owner's open + recently-merged PRs org-wide and map each to the contract `pr` shape. Pure mapping is tested directly; the shell-out is tested with an injected fake `run`.

**Files:**
- Create: `assist/prs.js`
- Test: `tests/assist-prs.test.js`

**Interfaces:**
- Consumes: `PR_CONTRACT_FIELDS`, `safeHttpUrl` from `classify.js`.
- Produces:
  - `ciFromRollup(statusCheckRollup) -> 'green'|'failed'|'pending'|'unknown'`
  - `buildPR(searchItem, viewData) -> pr` (exactly the contract fields)
  - `fetchOwnPRs({ run, now }) -> { prs: [pr], warnings: [{repo,step,message}] }` — `run(cmd, args, cwd)` returns a Promise of stdout (same signature as `bin/collect.js`'s `run`).

- [ ] **Step 1: Write the failing test**

Create `tests/assist-prs.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { ciFromRollup, buildPR, fetchOwnPRs } = require('../assist/prs.js');
const { PR_CONTRACT_FIELDS } = require('../classify.js');

test('ciFromRollup maps GitHub check conclusions', () => {
  assert.equal(ciFromRollup([]), 'unknown');
  assert.equal(ciFromRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }]), 'green');
  assert.equal(ciFromRollup([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'failed');
  assert.equal(ciFromRollup([{ conclusion: 'SUCCESS' }, { conclusion: null }]), 'pending');
  assert.equal(ciFromRollup([{ status: 'IN_PROGRESS', conclusion: null }]), 'pending');
});

test('buildPR emits exactly the contract fields', () => {
  const item = { number: 9914, title: 'fix x', url: 'https://github.com/HumandDev/humand-web/pull/9914',
    repository: { nameWithOwner: 'HumandDev/humand-web' }, state: 'OPEN' };
  const view = { headRefName: 'fix/no-ticket-x', isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    reviews: [{ author: { login: 'someone' } }], updatedAt: '2026-08-03T18:35:37Z' };
  const pr = buildPR(item, view);
  assert.deepEqual(Object.keys(pr).sort(), [...PR_CONTRACT_FIELDS].sort());
  assert.equal(pr.owner, 'HumandDev');
  assert.equal(pr.repo, 'humand-web');
  assert.equal(pr.headRef, 'fix/no-ticket-x');
  assert.equal(pr.draft, false);
  assert.equal(pr.merged, false);
  assert.equal(pr.ci, 'green');
  assert.equal(pr.conflicts, false);
  assert.equal(pr.approved, false);
  assert.equal(pr.changesReq, false);
  assert.equal(pr.humanReviews, 1);
});

test('buildPR reads review + conflict + merged state', () => {
  const item = { number: 1, title: 't', url: 'https://github.com/o/r/pull/1',
    repository: { nameWithOwner: 'o/r' }, state: 'MERGED' };
  const view = { headRefName: 'b', isDraft: true, reviewDecision: 'CHANGES_REQUESTED',
    mergeable: 'CONFLICTING', statusCheckRollup: [], reviews: [], updatedAt: '2026-08-03T00:00:00Z' };
  const pr = buildPR(item, view);
  assert.equal(pr.merged, true);
  assert.equal(pr.draft, true);
  assert.equal(pr.changesReq, true);
  assert.equal(pr.approved, false);
  assert.equal(pr.conflicts, true);
  assert.equal(pr.ci, 'unknown');
});

test('buildPR rejects a non-http url (defense in depth)', () => {
  const item = { number: 1, title: 't', url: 'javascript:alert(1)',
    repository: { nameWithOwner: 'o/r' }, state: 'OPEN' };
  const view = { headRefName: 'b', isDraft: false, reviewDecision: null,
    mergeable: 'MERGEABLE', statusCheckRollup: [], reviews: [], updatedAt: '2026-08-03T00:00:00Z' };
  assert.equal(buildPR(item, view).url, null);
});

test('fetchOwnPRs shells gh search then gh pr view, and normalizes', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'search') {
      return JSON.stringify([{ number: 1, title: 't', url: 'https://github.com/o/r/pull/1',
        repository: { nameWithOwner: 'o/r' }, state: 'OPEN' }]);
    }
    // gh pr view
    return JSON.stringify({ headRefName: 'feat/SQSH-1', isDraft: false, reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      reviews: [], updatedAt: '2026-08-03T00:00:00Z' });
  };
  const { prs, warnings } = await fetchOwnPRs({ run, now: () => 0 });
  assert.equal(warnings.length, 0);
  assert.equal(prs.length, 1);
  assert.equal(prs[0].headRef, 'feat/SQSH-1');
  assert.equal(prs[0].approved, true);
  assert.ok(calls.some(c => c[1] === 'search'));
  assert.ok(calls.some(c => c[1] === 'pr' && c[2] === 'view'));
});

test('fetchOwnPRs degrades to a warning when gh fails, never throws', async () => {
  const run = async () => { throw new Error('gh: not found'); };
  const { prs, warnings } = await fetchOwnPRs({ run, now: () => 0 });
  assert.deepEqual(prs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /gh/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-prs.test.js`
Expected: FAIL — cannot find `../assist/prs.js`.

- [ ] **Step 3: Implement `assist/prs.js`**

```javascript
// Own PR state via the `gh` CLI, normalized to the shared `pr` contract
// (classify.js PR_CONTRACT_FIELDS). This is the assistant's half of the one
// duplication the design accepts: the browser fetches with a PAT via
// github.js, this fetches with `gh` — but both emit the identical shape, and
// tests/classify-join.js proves the join needs nothing outside that shape.
//
// Deliberately `--author=@me` with no org qualifier (unlike render.js:272),
// so the owner's work in every org is seen — including this repo's own PRs,
// which the browser's org-scoped query drops.
const { PR_CONTRACT_FIELDS, safeHttpUrl } = require('../classify.js');

// GitHub check conclusions → the four CI states classify() understands. A
// failing conclusion anywhere loses; else any not-yet-concluded check is
// pending; else all concluded green; an empty rollup is unknown (no CI).
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
function ciFromRollup(rollup) {
  const checks = rollup || [];
  if (!checks.length) return 'unknown';
  if (checks.some(c => FAILED.has(c.conclusion))) return 'failed';
  if (checks.some(c => !c.conclusion)) return 'pending';
  return 'green';
}

// One search item (gh search prs) + its detail view (gh pr view) → a contract
// pr. `url` is re-validated through safeHttpUrl even though it comes from gh,
// matching local.js's rule of trusting no href.
function buildPR(item, view) {
  const [owner, repo] = item.repository.nameWithOwner.split('/');
  return {
    owner, repo,
    number: item.number,
    title: item.title,
    url: safeHttpUrl(item.url),
    headRef: view.headRefName || null,
    draft: view.isDraft === true,
    merged: item.state === 'MERGED',
    ci: ciFromRollup(view.statusCheckRollup),
    approved: view.reviewDecision === 'APPROVED',
    changesReq: view.reviewDecision === 'CHANGES_REQUESTED',
    conflicts: view.mergeable === 'CONFLICTING',
    // The assistant has no per-PR "seen" baseline (that lives in the browser's
    // localStorage), so it cannot compute "new since I last looked". 0 is
    // honest here; the assistant's turn signal comes from other flags.
    newComments: 0,
    humanReviews: (view.reviews || []).length,
    updatedAt: view.updatedAt,
  };
}

const SEARCH_FIELDS = 'number,title,url,repository,state';
const VIEW_FIELDS = 'headRefName,isDraft,reviewDecision,mergeable,statusCheckRollup,reviews,updatedAt';

// Open PRs plus PRs merged in the last 3 days (matching the browser's window),
// each enriched by a per-PR `gh pr view`. `run(cmd, args, cwd)` → stdout.
async function fetchOwnPRs({ run }) {
  const warnings = [];
  let items = [];
  try {
    const open = JSON.parse(await run('gh',
      ['search', 'prs', '--author', '@me', '--state', 'open', '--limit', '60', '--json', SEARCH_FIELDS]));
    const merged = JSON.parse(await run('gh',
      ['search', 'prs', '--author', '@me', '--merged', '--limit', '20', '--json', SEARCH_FIELDS]))
      .map(x => ({ ...x, state: 'MERGED' }));
    items = open.concat(merged);
  } catch (e) {
    warnings.push({ repo: null, step: 'gh-search', message: `gh search prs failed: ${e.message}` });
    return { prs: [], warnings };
  }

  const prs = [];
  for (const item of items) {
    try {
      const view = JSON.parse(await run('gh', ['pr', 'view', item.url, '--json', VIEW_FIELDS]));
      prs.push(buildPR(item, view));
    } catch (e) {
      warnings.push({ repo: item.repository && item.repository.nameWithOwner, step: 'gh-view',
        message: `gh pr view ${item.url} failed: ${e.message}` });
    }
  }
  return { prs, warnings };
}

module.exports = { ciFromRollup, buildPR, fetchOwnPRs };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/assist-prs.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add assist/prs.js tests/assist-prs.test.js
git commit -m "feat: assist/prs.js — own PRs via gh, normalized to the pr contract"
```

---

## Task 4: `assist/ledger.js` — the joined document

Join the local payload against the PRs with the moved functions, run `classify()`, and shape the output. Pure `buildLedger` is tested directly; the IO wrapper comes in Task 5.

**Files:**
- Create: `assist/ledger.js`
- Test: `tests/assist-ledger.test.js`

**Interfaces:**
- Consumes: `attachOwnPRs`, `synthesizeProcesses`, `classify` from `classify.js`; `fetchOwnPRs` from `assist/prs.js`; `collect` from `collect.js`.
- Produces:
  - `buildLedger(localPayload, prs, now) -> { version, generatedAt, workspaceRoot, processes: [{...proc, prs, state}], looseSessions, warnings }`
  - `ledger(opts) -> ledgerDoc` where `opts = { collect, fetchOwnPRs, ioForCollect, run, now }` (all injected).

- [ ] **Step 1: Write the failing test**

Create `tests/assist-ledger.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { buildLedger, ledger } = require('../assist/ledger.js');

const localPayload = () => ({
  generatedAt: 1000, workspaceRoot: '/w', warnings: [],
  processes: [
    { key: 'SQSH-1', ticket: 'SQSH-1', branches: ['feat/SQSH-1'],
      worktrees: [{ repo: 'r', branch: 'feat/SQSH-1' }], sessions: [], lastLocalActivity: 1000 },
    { key: 'chore/local-only', ticket: null, branches: ['chore/local-only'],
      worktrees: [{ repo: 'r', branch: 'chore/local-only' }], sessions: [], lastLocalActivity: 1000 },
  ],
  looseSessions: [],
});

const openPR = { owner: 'o', repo: 'r', number: 1, title: 't',
  url: 'https://x/1', headRef: 'feat/SQSH-1', draft: false, merged: false,
  ci: 'pending', approved: false, changesReq: false, conflicts: false,
  newComments: 0, humanReviews: 0, updatedAt: '2026-08-03T00:00:00Z' };

test('buildLedger joins a PR onto its process and classifies it', () => {
  const doc = buildLedger(localPayload(), [openPR], 2000);
  const p = doc.processes.find(x => x.key === 'SQSH-1');
  assert.equal(p.prs.length, 1);
  // pending CI + no human review yet → esperando
  assert.equal(p.state, 'esperando');
});

test('buildLedger leaves a PR-less local process with no prs and a local state', () => {
  const doc = buildLedger(localPayload(), [openPR], 2000);
  const p = doc.processes.find(x => x.key === 'chore/local-only');
  assert.equal(p.prs.length, 0);
  assert.ok(['pausa', 'frio', 'turno'].includes(p.state));
});

test('buildLedger synthesizes a process for a PR with no local worktree', () => {
  const orphan = { ...openPR, number: 2, headRef: 'feat/SQSH-99', url: 'https://x/2' };
  const doc = buildLedger(localPayload(), [openPR, orphan], 2000);
  const syn = doc.processes.find(x => x.key === 'SQSH-99');
  assert.ok(syn);
  assert.equal(syn.synthetic, true);
  assert.equal(syn.prs.length, 1);
});

test('buildLedger carries a version and merges warnings', () => {
  const local = localPayload(); local.warnings = [{ repo: null, step: 'x', message: 'm' }];
  const doc = buildLedger(local, [], 2000, [{ repo: null, step: 'gh', message: 'g' }]);
  assert.equal(typeof doc.version, 'number');
  assert.equal(doc.warnings.length, 2);
});

test('ledger() wires collect + fetchOwnPRs and stays degraded when gh fails', async () => {
  const fakeCollect = async () => localPayload();
  const fakeFetch = async () => ({ prs: [], warnings: [{ repo: null, step: 'gh-search', message: 'boom' }] });
  const doc = await ledger({ collect: fakeCollect, fetchOwnPRs: fakeFetch,
    ioForCollect: {}, run: async () => '', now: () => 2000 });
  assert.equal(doc.processes.length, 2);
  assert.ok(doc.warnings.some(w => w.step === 'gh-search'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-ledger.test.js`
Expected: FAIL — cannot find `../assist/ledger.js`.

- [ ] **Step 3: Implement `assist/ledger.js`**

```javascript
// The joined view: local work state (collect.js) + own PR state
// (assist/prs.js), joined by the same functions the browser panel uses
// (classify.js), classified by the same classify(). One document, no browser.
const { attachOwnPRs, synthesizeProcesses, classify } = require('../classify.js');

const LEDGER_VERSION = 1;

// Pure: fold PRs into processes, add synthetic processes for orphan PRs, and
// attach a `state` per process. `extraWarnings` are collector-external (e.g.
// gh failures) merged with the payload's own.
function buildLedger(localPayload, prs, now, extraWarnings) {
  const { rows, unmatched } = attachOwnPRs(localPayload.processes, prs || []);
  const synthetic = synthesizeProcesses(unmatched);
  const allRows = rows.concat(synthetic);

  const processes = allRows.map(({ proc, prs }) =>
    Object.assign({}, proc, { prs, state: classify(proc, prs, now) }));

  return {
    version: LEDGER_VERSION,
    generatedAt: now,
    workspaceRoot: localPayload.workspaceRoot,
    processes,
    looseSessions: localPayload.looseSessions || [],
    warnings: (localPayload.warnings || []).concat(extraWarnings || []),
  };
}

// IO wrapper: run the collector and the PR fetch, then join. Everything is
// injected so tests never touch disk or the network.
async function ledger(opts) {
  const { collect, fetchOwnPRs, ioForCollect, now } = opts;
  const local = await collect(ioForCollect);
  const { prs, warnings } = await fetchOwnPRs(opts);
  return buildLedger(local, prs, now(), warnings);
}

module.exports = { buildLedger, ledger, LEDGER_VERSION };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/assist-ledger.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add assist/ledger.js tests/assist-ledger.test.js
git commit -m "feat: assist/ledger.js — join local + PR state into one document"
```

---

## Task 5: `assist/bin/ledger.js` — the CLI

Wire real IO (the same `run`/`listDirs`/`listFiles`/`readTail` `bin/collect.js` already defines) and print the ledger. This is the deliverable a human or the gate (Increment 2) actually runs.

**Files:**
- Create: `assist/bin/ledger.js`
- Test: `tests/assist-ledger.test.js` (append a smoke test that the CLI module loads and exposes `main`)

**Interfaces:**
- Consumes: `ledger` from `assist/ledger.js`; `collect` from `collect.js`; the IO helpers from `bin/collect.js` (reused, not reimplemented).
- Produces: a `main()` that prints the ledger JSON to stdout; exit 1 on a thrown error.

- [ ] **Step 1: Write the failing test**

Append to `tests/assist-ledger.test.js`:

```javascript
test('the bin module exposes main and does not run on require', () => {
  const mod = require('../assist/bin/ledger.js');
  assert.equal(typeof mod.main, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/assist-ledger.test.js`
Expected: FAIL — cannot find `../assist/bin/ledger.js`.

- [ ] **Step 3: Implement `assist/bin/ledger.js`**

Reuse `bin/collect.js`'s IO helpers rather than duplicating them (DRY — that file already exports `run`, `listDirs`, `listFiles`, `readTail`).

```javascript
#!/usr/bin/env node
// Real-IO wrapper around ledger(). Prints the joined document to stdout.
// Reuses bin/collect.js's IO helpers — no path or process logic is duplicated.
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../../collect.js');
const { fetchOwnPRs } = require('../prs.js');
const { ledger } = require('../ledger.js');
const { run, listDirs, listFiles, readTail } = require('../../bin/collect.js');

async function main() {
  const doc = await ledger({
    collect,
    fetchOwnPRs,
    ioForCollect: {
      env: process.env,
      homeDir: os.homedir(),
      checkoutDir: path.resolve(__dirname, '..', '..'),
      run, listDirs, listFiles, readTail,
      now: () => Date.now(),
    },
    run,
    now: () => Date.now(),
  });
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { main };
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/assist-ledger.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Run it for real against the live machine**

Run: `node assist/bin/ledger.js | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log('version', d.version, '| procesos', d.processes.length, '| con PR', d.processes.filter(p=>p.prs.length).length, '| warnings', d.warnings.length); const own=d.processes.find(p=>p.key.includes('active-processes')||p.branches.some(b=>b.includes('active-processes'))); console.log('pr-queue own PR joined:', own ? own.prs.length : 'process not found')"`

Expected: prints a version, a process count near the collector's, a non-zero "con PR", and — the bug this increment fixes — **pr-queue's own PR joined (≥1)**, which the browser's org-scoped query drops. If "con PR" is 0, `gh auth status` and re-run; a genuine gh failure should have surfaced as a warning, not an empty join.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: PASS, count = **182 + 6 + 5 + 1 = 194** (Task 1: 6, Task 2: 2, Task 3: 6, Task 4: 5, Task 5: 1, on top of the prior 176).

- [ ] **Step 7: Commit**

```bash
git add assist/bin/ledger.js tests/assist-ledger.test.js
git commit -m "feat: assist/bin/ledger.js — print the joined ledger from the CLI"
```

---

## Self-Review notes

- **Spec coverage (§1 of the spec):** the three moved functions (Task 1), `PR_CONTRACT_FIELDS` + the "join needs only the contract" test (Task 2), `assist/prs.js` with the no-`org:` fix and the contract shape (Task 3), `assist/ledger.js` producing the documented output with `state` per process (Task 4), and the CLI (Task 5). The contract-agreement requirement is met by proving the join consumes only contract fields *and* that `buildPR` emits exactly them — jointly stronger than reflecting over two producers.
- **Deferred, correctly:** `flags` (needsPush/notOnOrigin/etc.) belong to the gate (Increment 2), not the ledger — the spec lists them under §1 but they are only *read* by §2. This increment stops at `state`; adding flags with no consumer would violate YAGNI. Flagged here so the Increment 2 plan picks them up.
- **`newComments: 0`** is a deliberate, documented contract value, not a placeholder — the assistant has no seen-baseline. Called out in `buildPR`.
- **Type consistency:** `run(cmd, args, cwd) -> Promise<stdout>` is identical across `bin/collect.js`, `assist/prs.js`, and the injected fakes. `buildLedger(localPayload, prs, now, extraWarnings)` and `ledger({collect, fetchOwnPRs, ioForCollect, run, now})` match their call sites.
