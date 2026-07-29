# Active Processes Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only panel to pr-queue that groups worktrees, Claude Code sessions and PRs into "processes" and classifies each as *tu turno* / *esperando a otro* / *en pausa* / *frío*.

**Architecture:** A dependency-free Node collector (`collect.js`) reads local git + `claude agents --json` and emits JSON. A dependency-free Node sidecar (`serve.js`) serves the existing static site plus `GET /api/local`. A new browser script (`local.js`) fetches that endpoint and, **only if it succeeds**, mounts a panel — so the GitHub Pages deploy used by other people is unchanged. Classification logic lives in `classify.js`, loaded by both Node and the browser via a one-line dual export.

**Tech Stack:** Vanilla JS, no dependencies, no build step. Node ≥18 (`node:test` built-in), local Node is v22.21.0. Plain `<script src>` globals in the browser, CommonJS in Node.

**Spec:** `docs/superpowers/specs/2026-07-28-active-processes-panel-design.md`

## Global Constraints

- **No dependencies, no build step.** Nothing in `package.json` beyond metadata and a `test` script. Matches the rest of the repo.
- **No hardcoded paths.** No `/Users/sebas` anywhere in committed code. Workspace root: `PRQ_WORKSPACE` else the parent directory of the checkout. Claude config dir: `CLAUDE_CONFIG_DIR` else `~/.claude`.
- **No `"type": "module"`** in `package.json` — every `.js` here must stay CommonJS so `classify.js` can be both a `<script src>` and a `require()`.
- **Frío threshold: 14 days.** Exported as a named constant `COLD_DAYS = 14`, never inlined.
- **Port 7777**, overridable via `PRQ_PORT`. If taken, fail loudly — never auto-increment.
- **The panel self-hides.** Any failure fetching `/api/local` means mount nothing. No origin sniffing, no build flag.
- **The collector never fails closed.** Per-source and per-repo errors append to `warnings[]` and the run exits 0 with partial data.
- **Base branch is derived per repo**, never assumed. Repos here disagree (`develop` vs `main`).

## Collector output contract

Every task depends on this shape. Timestamps are **epoch milliseconds**.

```js
{
  generatedAt: 1785000000000,
  workspaceRoot: '/path/to/workspace',
  warnings: [ { repo: 'humand-web', step: 'status', message: '...' } ],
  processes: [
    {
      key: 'SQSH-3851',          // ticket ?? branch
      ticket: 'SQSH-3851',       // or null
      branches: ['feat/SQSH-3851-web-feed-mejorar-publicaciones-con-ai'],
      worktrees: [ {
        repo: 'humand-web',
        path: '/path/to/humand-web--SQSH-3851',
        branch: 'feat/SQSH-3851-...',  // null when detached
        detached: false,
        prunable: false,
        dirty: 3,                 // null when unknown
        unpushed: 2,              // null when unknown (e.g. no base branch found)
        lastCommit: 1784900000000 // null when unknown
      } ],
      sessions: [ {
        sessionId: '6a7870d8-a0b0-4d12-ac42-961514ba17ec',
        name: 'humand-09',
        kind: 'interactive',      // or 'background'
        status: 'idle',           // status ?? state ?? null
        cwd: '/path/to/worktree', // last cwd seen in the transcript, else the agent's cwd
        lastActivity: 1784838463700,   // max transcript timestamp, NEVER file mtime
        prLink: { number: 9294, repo: 'HumandDev/humand-web',
                  url: 'https://github.com/HumandDev/humand-web/pull/9294' },  // or null
        resumeCmd: 'claude --resume 6a7870d8-a0b0-4d12-ac42-961514ba17ec'
      } ],
      lastLocalActivity: 1784900000000  // max over worktree lastCommit + session lastActivity
    }
  ],
  // Sessions that resolved to no worktree (cwd is the workspace root, or a
  // directory no worktree owns). Never keyed by cwd — that would collapse all
  // root-cwd sessions into one meaningless process. local.js merges any of
  // these whose prLink matches a known PR into that PR's process.
  looseSessions: [ /* same session shape as above */ ]
}
```

## File structure

| File | Responsibility |
|---|---|
| `classify.js` | **Create.** Pure logic shared by Node and browser: `extractTicket`, `groupProcesses`, `lastActivity`, `classify`, `COLD_DAYS`. |
| `collect-parse.js` | **Create.** Pure parsers for `git worktree list --porcelain`, `git status --short`, `claude agents --json`. |
| `collect-paths.js` | **Create.** Pure path/config resolution: workspace root, Claude dir, base-branch pick. |
| `collect.js` | **Create.** IO orchestration: runs git per repo concurrently, reads session indexes, assembles the contract above. |
| `bin/collect.js` | **Create.** Thin CLI: `collect()` → `JSON.stringify` → stdout. |
| `serve.js` | **Create.** Static file server + `GET /api/local`. |
| `local.js` | **Create.** Browser: fetch, join with `state.ownPRs`, render panel, self-hide. |
| `github.js` | **Modify** (`enrichOwnPR` return, ~line 114): add `headRef` and `updatedAt`. |
| `index.html` | **Modify**: `#proc-section` markup above `.main-layout` (~line 731), panel CSS, `<script src="classify.js">` + `<script src="local.js">` (~line 789-793). |
| `package.json` | **Create.** Metadata + `test` script only. No dependencies. |
| `scripts/install-launchd.sh` | **Create.** Opt-in always-on agent. |
| `README.md` | **Create.** Setup, env vars, the localStorage gotcha. |
| `tests/*.test.js` | **Create.** `node --test` suites. |

---

### Task 1: Pure parsers + test harness

**Files:**
- Create: `package.json`, `collect-parse.js`
- Test: `tests/collect-parse.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseWorktrees(stdout: string) => Array<{ path, branch: string|null, head: string|null, detached: boolean, prunable: boolean }>`
  - `parseStatusShort(stdout: string) => number`
  - `parseAgents(stdout: string) => Array<{ sessionId, name, kind, status: string|null, cwd, startedAt }>`
  - `parseTranscriptTail(text: string) => { lastTs: number|null, lastCwd: string|null, prLink: {number, repo, url}|null }`

- [ ] **Step 1: Create `package.json`**

No dependencies, and deliberately no `"type"` field so files stay CommonJS.

```json
{
  "name": "pr-queue",
  "version": "1.0.0",
  "private": true,
  "description": "PR review queue dashboard + local active-processes panel",
  "scripts": {
    "test": "node --test",
    "serve": "node serve.js",
    "collect": "node bin/collect.js"
  }
}
```

- [ ] **Step 2: Write the failing test**

Fixtures are real captured output from this workspace, including the `prunable` and `detached` cases.

Create `tests/collect-parse.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseWorktrees, parseStatusShort, parseAgents,
        parseTranscriptTail } = require('../collect-parse.js');

const WORKTREE_FIXTURE = `worktree /w/humand-web
HEAD 5552c1c23d5ab2a22bfd9c5cd9da130e8b86adfb
branch refs/heads/chore/no-ticket-e2e-coverage-instrumentation

worktree /w/humand-web--SQSH-3705-crashes-feed
HEAD efaf154a65d5f885516645af71b80488916e073c
branch refs/heads/fix/SQSH-3705-web-feed-seen-by-of-a-group-post-crashes-feed
prunable gitdir file points to non-existent location

worktree /w/humand-web--detached
HEAD 93f62bd5a7f27da51d6980c1c5a61a876cdd283a
detached
`;

test('parseWorktrees reads path and strips refs/heads/ from branch', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out.length, 3);
  assert.equal(out[0].path, '/w/humand-web');
  assert.equal(out[0].branch, 'chore/no-ticket-e2e-coverage-instrumentation');
  assert.equal(out[0].prunable, false);
  assert.equal(out[0].detached, false);
});

test('parseWorktrees flags prunable worktrees', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out[1].prunable, true);
  assert.equal(out[1].branch, 'fix/SQSH-3705-web-feed-seen-by-of-a-group-post-crashes-feed');
});

test('parseWorktrees flags detached worktrees with a null branch', () => {
  const out = parseWorktrees(WORKTREE_FIXTURE);
  assert.equal(out[2].detached, true);
  assert.equal(out[2].branch, null);
});

test('parseWorktrees returns empty array for empty input', () => {
  assert.deepEqual(parseWorktrees(''), []);
});

test('parseStatusShort counts changed files', () => {
  assert.equal(parseStatusShort('?? AGENTS.md\n M src/a.ts\n M src/b.ts\n'), 3);
});

test('parseStatusShort returns 0 for a clean tree', () => {
  assert.equal(parseStatusShort(''), 0);
  assert.equal(parseStatusShort('\n'), 0);
});

test('parseAgents normalizes status from status or state', () => {
  const fixture = JSON.stringify([
    { id: '50f65449', cwd: '/w', kind: 'background', startedAt: 1782329044156,
      sessionId: '50f65449-e6e7-4a91-a95a-959179f758d0',
      name: 'Migrar modulos', state: 'blocked' },
    { pid: 75713, cwd: '/w', kind: 'interactive', startedAt: 1783966404484,
      sessionId: '49218af4-029d-4668-9ad2-3c3ee5bbc03d',
      name: 'humand-33', status: 'idle' },
  ]);
  const out = parseAgents(fixture);
  assert.equal(out.length, 2);
  assert.equal(out[0].status, 'blocked');
  assert.equal(out[1].status, 'idle');
  assert.equal(out[1].name, 'humand-33');
});

test('parseAgents returns empty array on unparseable input', () => {
  assert.deepEqual(parseAgents('not json'), []);
  assert.deepEqual(parseAgents(''), []);
});

// Real transcript tail. The trailing ai-title/mode/permission-mode records
// carry NO timestamp and are what makes file mtime unusable — they are
// appended by bookkeeping hours after the last real message.
const TAIL_FIXTURE = [
  JSON.stringify({ type: 'user', cwd: '/w/humand-web--SQSH-3239', timestamp: '2026-07-28T13:40:00.000Z' }),
  JSON.stringify({ type: 'pr-link', sessionId: 's1', prNumber: 9294,
    prUrl: 'https://github.com/HumandDev/humand-web/pull/9294',
    prRepository: 'HumandDev/humand-web', timestamp: '2026-07-28T13:49:04.352Z' }),
  JSON.stringify({ type: 'system', timestamp: '2026-07-28T13:52:17.647Z' }),
  JSON.stringify({ type: 'ai-title' }),
  JSON.stringify({ type: 'mode' }),
  JSON.stringify({ type: 'permission-mode' }),
].join('\n') + '\n';

test('parseTranscriptTail uses the last real timestamp, not the trailing records', () => {
  const out = parseTranscriptTail(TAIL_FIXTURE);
  assert.equal(out.lastTs, new Date('2026-07-28T13:52:17.647Z').getTime());
});

test('parseTranscriptTail finds the last cwd', () => {
  assert.equal(parseTranscriptTail(TAIL_FIXTURE).lastCwd, '/w/humand-web--SQSH-3239');
});

test('parseTranscriptTail extracts the pr-link', () => {
  const { prLink } = parseTranscriptTail(TAIL_FIXTURE);
  assert.equal(prLink.number, 9294);
  assert.equal(prLink.repo, 'HumandDev/humand-web');
  assert.equal(prLink.url, 'https://github.com/HumandDev/humand-web/pull/9294');
});

test('parseTranscriptTail returns the newest pr-link when there are several', () => {
  const text = [
    JSON.stringify({ type: 'pr-link', prNumber: 1, prUrl: 'u1', prRepository: 'o/r',
      timestamp: '2026-07-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'pr-link', prNumber: 2, prUrl: 'u2', prRepository: 'o/r',
      timestamp: '2026-07-20T00:00:00.000Z' }),
  ].join('\n');
  assert.equal(parseTranscriptTail(text).prLink.number, 2);
});

test('parseTranscriptTail survives a truncated first line', () => {
  // Tail-reading 64KB almost always cuts the first line mid-JSON.
  const text = '{"type":"user","timest' + '\n' + TAIL_FIXTURE;
  assert.equal(parseTranscriptTail(text).lastTs, new Date('2026-07-28T13:52:17.647Z').getTime());
});

test('parseTranscriptTail returns nulls for empty input', () => {
  assert.deepEqual(parseTranscriptTail(''), { lastTs: null, lastCwd: null, prLink: null });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../collect-parse.js'`

- [ ] **Step 4: Write the implementation**

Create `collect-parse.js`:

```js
// Pure parsers for local command output. No IO, no dependencies.

function parseWorktrees(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, head: null,
              detached: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseStatusShort(stdout) {
  return String(stdout).split('\n').filter(l => l.trim() !== '').length;
}

function parseAgents(stdout) {
  let raw;
  try { raw = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.map(a => ({
    sessionId: a.sessionId || null,
    name: a.name || null,
    kind: a.kind || null,
    status: a.status || a.state || null,
    cwd: a.cwd || null,
    startedAt: a.startedAt || null,
  }));
}

// Scans a transcript tail backwards. Records are one JSON object per line;
// the first line is usually truncated by the 64KB read and must be tolerated.
// Trailing ai-title/mode/permission-mode records have no timestamp — skipping
// them is the whole reason we do not use the file's mtime.
function parseTranscriptTail(text) {
  const out = { lastTs: null, lastCwd: null, prLink: null };
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }  // truncated line
    if (out.lastTs === null && o.timestamp) {
      const t = new Date(o.timestamp).getTime();
      if (!isNaN(t)) out.lastTs = t;
    }
    if (out.lastCwd === null && o.cwd) out.lastCwd = o.cwd;
    if (out.prLink === null && o.type === 'pr-link' && o.prNumber) {
      out.prLink = { number: o.prNumber, repo: o.prRepository || null, url: o.prUrl || null };
    }
    if (out.lastTs !== null && out.lastCwd !== null && out.prLink !== null) break;
  }
  return out;
}

module.exports = { parseWorktrees, parseStatusShort, parseAgents, parseTranscriptTail };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json collect-parse.js tests/collect-parse.test.js
git commit -m "feat: pure parsers for worktree, status, agents and transcript tail"
```

---

### Task 2: Ticket extraction and process grouping

**Files:**
- Create: `classify.js`
- Test: `tests/classify-group.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractTicket(branch: string|null) => string|null`
  - `attachSessions(sessions, worktrees) => { attached: Array<session & {branch}>, loose: Array<session> }` — resolves each session's `cwd` against the worktree paths. **`cwd` is never used as a grouping key**; a session that matches nothing goes to `loose`.
  - `groupProcesses({ worktrees, sessions }) => Array<process>` where each process has `{ key, ticket, branches, worktrees, sessions, lastLocalActivity }`. Input `worktrees` is `Array<{ repo, path, branch, detached, prunable, dirty, unpushed, lastCommit }>`, input `sessions` must already carry a non-null `branch` (i.e. the `attached` half above).
  - `COLD_DAYS = 14`

- [ ] **Step 1: Write the failing test**

Create `tests/classify-group.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { extractTicket, groupProcesses, COLD_DAYS } = require('../classify.js');

test('COLD_DAYS is 14', () => {
  assert.equal(COLD_DAYS, 14);
});

test('extractTicket pulls the ticket out of a branch name', () => {
  assert.equal(extractTicket('feat/SQSH-3851-web-feed-mejorar-con-ai'), 'SQSH-3851');
  assert.equal(extractTicket('fix/CSBM-5716-heic-images-fail-silently'), 'CSBM-5716');
  assert.equal(extractTicket('chore/SQXS-1920-migrate-module-feed'), 'SQXS-1920');
});

test('extractTicket returns null when there is no ticket', () => {
  assert.equal(extractTicket('chore/no-ticket-e2e-coverage-instrumentation'), null);
  assert.equal(extractTicket('develop'), null);
  assert.equal(extractTicket(null), null);
});

test('extractTicket ignores lowercase and too-short prefixes', () => {
  assert.equal(extractTicket('feat/ab-12-something'), null);
  assert.equal(extractTicket('feat/sqsh-3851-lowercase'), null);
});

test('groupProcesses collapses two repos on the same ticket into one process', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'feat/SQSH-3851-web', detached: false,
        prunable: false, dirty: 0, unpushed: 1, lastCommit: 2000 },
      { repo: 'hu-translations', path: '/w/b', branch: 'feat/SQSH-3851-copy', detached: false,
        prunable: false, dirty: 0, unpushed: 0, lastCommit: 3000 },
    ],
    sessions: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'SQSH-3851');
  assert.equal(out[0].ticket, 'SQSH-3851');
  assert.equal(out[0].worktrees.length, 2);
  assert.equal(out[0].branches.length, 2);
});

test('groupProcesses keys a ticketless branch by branch and marks it', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'chore/no-ticket-e2e', detached: false,
        prunable: false, dirty: 2, unpushed: 0, lastCommit: 1000 },
    ],
    sessions: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'chore/no-ticket-e2e');
  assert.equal(out[0].ticket, null);
});

test('groupProcesses attaches sessions by branch', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'feat/SQSH-3851-web', detached: false,
        prunable: false, dirty: 0, unpushed: 0, lastCommit: 1000 },
    ],
    sessions: [
      { sessionId: 's1', name: 'humand-09', kind: 'interactive', status: 'idle',
        cwd: '/w/a', lastActivity: 5000, branch: 'feat/SQSH-3851-web' },
    ],
  });
  assert.equal(out[0].sessions.length, 1);
  assert.equal(out[0].sessions[0].sessionId, 's1');
});

const WT = [
  { repo: 'humand-web', path: '/w/humand-web', branch: 'develop', detached: false,
    prunable: false, dirty: 0, unpushed: 0, lastCommit: 1000 },
  { repo: 'humand-web', path: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize',
    branch: 'chore/SQSH-3239-virtualize', detached: false, prunable: false,
    dirty: 0, unpushed: 0, lastCommit: 2000 },
];

function sess(over) {
  return Object.assign({ sessionId: 's1', name: 'n', kind: 'interactive', status: 'idle',
                         cwd: '/w', lastActivity: 5000, prLink: null }, over);
}

test('attachSessions resolves a session whose cwd is a worktree', () => {
  const { attached, loose } = attachSessions(
    [sess({ cwd: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize' })], WT);
  assert.equal(loose.length, 0);
  assert.equal(attached[0].branch, 'chore/SQSH-3239-virtualize');
});

test('attachSessions resolves a nested cwd to its owning worktree', () => {
  // Sessions often sit in a subdirectory of the worktree.
  const { attached } = attachSessions(
    [sess({ cwd: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize/src/feed' })], WT);
  assert.equal(attached[0].branch, 'chore/SQSH-3239-virtualize');
});

test('attachSessions prefers the longest matching worktree path', () => {
  // /w/humand-web is a prefix of the nested worktree; the deeper one must win.
  const { attached } = attachSessions(
    [sess({ cwd: '/w/humand-web/.worktrees/chore/SQSH-3239-virtualize' })], WT);
  assert.equal(attached[0].branch, 'chore/SQSH-3239-virtualize');
});

test('attachSessions puts a workspace-root session in loose, never keyed by cwd', () => {
  const { attached, loose } = attachSessions([sess({ cwd: '/w' })], WT);
  assert.equal(attached.length, 0);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].sessionId, 's1');
});

test('attachSessions puts a session with no cwd in loose', () => {
  const { attached, loose } = attachSessions([sess({ cwd: null })], WT);
  assert.equal(attached.length, 0);
  assert.equal(loose.length, 1);
});

test('attachSessions does not let a prefix match steal a sibling directory', () => {
  const wt = [{ repo: 'r', path: '/w/humand-web', branch: 'develop', detached: false,
                prunable: false, dirty: 0, unpushed: 0, lastCommit: 1 }];
  const { attached, loose } = attachSessions([sess({ cwd: '/w/humand-web-other' })], wt);
  assert.equal(attached.length, 0, 'humand-web-other must not match humand-web');
  assert.equal(loose.length, 1);
});

test('groupProcesses keeps detached worktrees as their own branchless process', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/det', branch: null, detached: true,
        prunable: false, dirty: 0, unpushed: null, lastCommit: 1000 },
    ],
    sessions: [],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].ticket, null);
  assert.equal(out[0].key, '/w/det');
  assert.equal(out[0].worktrees[0].detached, true);
});

test('groupProcesses sets lastLocalActivity to the max across worktrees and sessions', () => {
  const out = groupProcesses({
    worktrees: [
      { repo: 'humand-web', path: '/w/a', branch: 'feat/SQSH-1-x', detached: false,
        prunable: false, dirty: 0, unpushed: 0, lastCommit: 2000 },
    ],
    sessions: [
      { sessionId: 's1', name: 'n', kind: 'interactive', status: 'idle', cwd: '/w/a',
        summary: null, lastActivity: 9000, branch: 'feat/SQSH-1-x' },
    ],
  });
  assert.equal(out[0].lastLocalActivity, 9000);
});

test('groupProcesses ignores a session with no branch instead of keying it by cwd', () => {
  // The regression this guards: keying by cwd collapses every root-cwd session
  // into one meaningless process. Unattached sessions belong in looseSessions.
  const out = groupProcesses({
    worktrees: [],
    sessions: [
      { sessionId: 's1', name: 'n', kind: 'interactive', status: 'idle', cwd: '/w',
        lastActivity: 9000, branch: null },
    ],
  });
  assert.deepEqual(out, []);
});
```

Add `attachSessions` to the requires at the top of this test file:

```js
const { extractTicket, groupProcesses, attachSessions, COLD_DAYS } = require('../classify.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../classify.js'`

- [ ] **Step 3: Write the implementation**

Create `classify.js`. Note the dual-export footer — this file is also loaded in the browser as a plain `<script src>`, so it must not use `require` at the top level and must guard the `module.exports`.

```js
// Shared pure logic. Loaded both as a browser <script src> (globals) and
// via require() in Node (see the dual-export footer). No dependencies, no IO.

var COLD_DAYS = 14;

var TICKET_RE = /\b([A-Z]{3,5}-\d+)\b/;

function extractTicket(branch) {
  if (!branch) return null;
  var m = String(branch).match(TICKET_RE);
  return m ? m[1] : null;
}

function processKey(item) {
  // item: { branch, path }
  var ticket = extractTicket(item.branch);
  if (ticket) return ticket;
  if (item.branch) return item.branch;
  return item.path || 'unknown';
}

// Resolves each session to the worktree that owns its cwd. A session's cwd is
// frequently the workspace root rather than a worktree, and the transcript's
// gitBranch reports wherever the session started — so cwd containment is the
// only reliable local signal, and anything unresolved must stay loose rather
// than becoming a process keyed by its cwd.
function attachSessions(sessions, worktrees) {
  var paths = (worktrees || [])
    .filter(function (w) { return w.path && w.branch; })
    // Longest path first so a nested worktree beats its parent repo.
    .sort(function (a, b) { return b.path.length - a.path.length; });

  var attached = [], loose = [];

  (sessions || []).forEach(function (s) {
    var cwd = s.cwd;
    var hit = cwd ? paths.find(function (w) {
      // Exact match, or cwd is inside the worktree. The separator check stops
      // /w/humand-web-other from matching /w/humand-web.
      return cwd === w.path || cwd.indexOf(w.path + '/') === 0;
    }) : null;

    if (hit) attached.push(Object.assign({}, s, { branch: hit.branch }));
    else loose.push(s);
  });

  return { attached: attached, loose: loose };
}

function groupProcesses(input) {
  var worktrees = (input && input.worktrees) || [];
  var sessions  = (input && input.sessions)  || [];
  var map = new Map();

  function ensure(key, ticket) {
    if (!map.has(key)) {
      map.set(key, { key: key, ticket: ticket || null, branches: [],
                     worktrees: [], sessions: [], lastLocalActivity: null });
    }
    return map.get(key);
  }

  function noteBranch(proc, branch) {
    if (branch && proc.branches.indexOf(branch) === -1) proc.branches.push(branch);
  }

  function bump(proc, ts) {
    if (typeof ts === 'number' && (proc.lastLocalActivity === null || ts > proc.lastLocalActivity)) {
      proc.lastLocalActivity = ts;
    }
  }

  worktrees.forEach(function (wt) {
    var proc = ensure(processKey(wt), extractTicket(wt.branch));
    proc.worktrees.push(wt);
    noteBranch(proc, wt.branch);
    bump(proc, wt.lastCommit);
  });

  sessions.forEach(function (s) {
    // A session with no branch is unattached and belongs in looseSessions.
    // Keying it by cwd would collapse every root-cwd session into one row.
    if (!s.branch) return;
    var proc = ensure(processKey({ branch: s.branch }), extractTicket(s.branch));
    proc.sessions.push(s);
    noteBranch(proc, s.branch);
    bump(proc, s.lastActivity);
  });

  return Array.from(map.values());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COLD_DAYS: COLD_DAYS, extractTicket: extractTicket,
                     processKey: processKey, groupProcesses: groupProcesses,
                     attachSessions: attachSessions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the 14 parser tests plus the grouping and attachment tests.

- [ ] **Step 5: Commit**

```bash
git add classify.js tests/classify-group.test.js
git commit -m "feat: ticket extraction and process grouping"
```

---

### Task 3: `lastActivity` and the state classifier

This is the task that carries the feature. The distinction that matters is *tu turno* vs *esperando a otro* — age alone is not a priority signal.

**Files:**
- Modify: `classify.js` (append before the dual-export footer, and extend the footer)
- Test: `tests/classify-state.test.js`

**Interfaces:**
- Consumes: `COLD_DAYS` from Task 2.
- Produces:
  - `lastActivity(proc, prs) => number|null` — max over `proc.lastLocalActivity` and each PR's `updatedAt`.
  - `classify(proc, prs, now) => 'turno' | 'esperando' | 'pausa' | 'frio'`
  - `sortProcesses(rows, now) => rows` sorted for display, where `rows` is `Array<{ proc, prs }>`.
  - PR objects are the browser's `state.ownPRs` entries: `{ draft, ci, conflicts, approved, changesReq, newComments, newApprovals, newChanges, updatedAt, headRef, number, url, repo }`. `updatedAt` may be a `Date` or epoch ms.

- [ ] **Step 1: Write the failing test**

Create `tests/classify-state.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { lastActivity, classify, sortProcesses } = require('../classify.js');

const NOW = 1785000000000;
const DAY = 86400000;

function proc(over) {
  return Object.assign({ key: 'SQSH-1', ticket: 'SQSH-1', branches: ['feat/SQSH-1-x'],
                         worktrees: [], sessions: [], lastLocalActivity: null }, over);
}
function pr(over) {
  return Object.assign({ draft: false, ci: 'green', conflicts: false, approved: false,
                         changesReq: false, newComments: 0, newApprovals: 0, newChanges: 0,
                         updatedAt: NOW - 30 * DAY, headRef: 'feat/SQSH-1-x',
                         humanReviews: 0 }, over);
}

test('lastActivity takes the max across local activity and PR updates', () => {
  assert.equal(lastActivity(proc({ lastLocalActivity: 1000 }), [pr({ updatedAt: 5000 })]), 5000);
  assert.equal(lastActivity(proc({ lastLocalActivity: 9000 }), [pr({ updatedAt: 5000 })]), 9000);
});

test('lastActivity accepts Date objects for PR updatedAt', () => {
  assert.equal(lastActivity(proc({ lastLocalActivity: 1000 }), [pr({ updatedAt: new Date(7000) })]), 7000);
});

test('lastActivity tolerates missing pieces', () => {
  assert.equal(lastActivity(proc({ lastLocalActivity: null }), []), null);
  assert.equal(lastActivity(proc({ lastLocalActivity: 4000 }), []), 4000);
  assert.equal(lastActivity(proc({ lastLocalActivity: null }), [pr({ updatedAt: 4000 })]), 4000);
});

test('changes requested is your turn', () => {
  assert.equal(classify(proc(), [pr({ changesReq: true })], NOW), 'turno');
});

test('unseen comments are your turn', () => {
  assert.equal(classify(proc(), [pr({ newComments: 2 })], NOW), 'turno');
});

test('unseen change requests are your turn', () => {
  assert.equal(classify(proc(), [pr({ newChanges: 1 })], NOW), 'turno');
});

test('failed CI is your turn', () => {
  assert.equal(classify(proc(), [pr({ ci: 'failed' })], NOW), 'turno');
});

test('conflicts are your turn', () => {
  assert.equal(classify(proc(), [pr({ conflicts: true })], NOW), 'turno');
});

test('own activity within 48h is your turn', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - DAY }), [], NOW), 'turno');
});

test('an open PR with no human review yet is waiting on someone else', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ humanReviews: 0 })], NOW), 'esperando');
});

test('pending CI is waiting on someone else', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 5 * DAY }),
    [pr({ ci: 'pending', humanReviews: 1 })], NOW), 'esperando');
});

test('waiting beats cold — a 30 day old unreviewed PR is still esperando', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 30 * DAY }),
    [pr({ updatedAt: NOW - 30 * DAY, humanReviews: 0 })], NOW), 'esperando');
});

test('13 days with no PR is en pausa, not esperando — nobody is blocking it', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 13 * DAY }), [], NOW), 'pausa');
});

test('3 days with no PR is en pausa', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 3 * DAY }), [], NOW), 'pausa');
});

test('an approved PR with reviews, touched 3 days ago, is en pausa not esperando', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 3 * DAY }),
    [pr({ approved: true, humanReviews: 1, updatedAt: NOW - 3 * DAY })], NOW), 'pausa');
});

test('15 days with no PR is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 15 * DAY }), [], NOW), 'frio');
});

test('an approved and reviewed PR untouched for 15 days is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: NOW - 15 * DAY }),
    [pr({ approved: true, humanReviews: 1, updatedAt: NOW - 15 * DAY })], NOW), 'frio');
});

test('a process with no PR and no known activity is cold', () => {
  assert.equal(classify(proc({ lastLocalActivity: null }), [], NOW), 'frio');
});

test('sortProcesses orders turno, esperando, pausa, frio — oldest first inside each', () => {
  const rows = [
    { proc: proc({ key: 'cold-new', lastLocalActivity: NOW - 15 * DAY }), prs: [] },
    { proc: proc({ key: 'wait-new', lastLocalActivity: NOW - 3 * DAY }),
      prs: [pr({ updatedAt: NOW - 3 * DAY, humanReviews: 0 })] },
    { proc: proc({ key: 'cold-old', lastLocalActivity: NOW - 40 * DAY }), prs: [] },
    { proc: proc({ key: 'paused', lastLocalActivity: NOW - 5 * DAY }), prs: [] },
    { proc: proc({ key: 'wait-old', lastLocalActivity: NOW - 20 * DAY }),
      prs: [pr({ updatedAt: NOW - 20 * DAY, humanReviews: 0 })] },
    { proc: proc({ key: 'mine', lastLocalActivity: NOW - DAY }), prs: [] },
  ];
  const keys = sortProcesses(rows, NOW).map(r => r.proc.key);
  assert.deepEqual(keys,
    ['mine', 'wait-old', 'wait-new', 'paused', 'cold-old', 'cold-new']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `lastActivity is not a function`

- [ ] **Step 3: Write the implementation**

In `classify.js`, insert before the dual-export footer:

```js
var TURN_WINDOW_MS = 48 * 60 * 60 * 1000;
var COLD_MS = COLD_DAYS * 24 * 60 * 60 * 1000;

function toMs(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}

function lastActivity(proc, prs) {
  var best = typeof proc.lastLocalActivity === 'number' ? proc.lastLocalActivity : null;
  (prs || []).forEach(function (p) {
    var ts = toMs(p.updatedAt);
    if (ts !== null && (best === null || ts > best)) best = ts;
  });
  return best;
}

function classify(proc, prs, now) {
  var list = prs || [];

  var yourMove = list.some(function (p) {
    return p.changesReq === true
      || (p.newComments  || 0) > 0
      || (p.newChanges   || 0) > 0
      || (p.newApprovals || 0) > 0
      || p.ci === 'failed'
      || p.conflicts === true;
  });
  if (yourMove) return 'turno';

  var local = typeof proc.lastLocalActivity === 'number' ? proc.lastLocalActivity : null;
  if (local !== null && now - local <= TURN_WINDOW_MS) return 'turno';

  var waiting = list.some(function (p) {
    return p.ci === 'pending' || (p.humanReviews || 0) === 0;
  });
  if (waiting) return 'esperando';

  var last = lastActivity(proc, list);
  if (last === null) return 'frio';
  // Not your move and nobody is blocking it: set down, not dead. Calling this
  // "esperando" would claim someone is blocking a process with no PR.
  return (now - last > COLD_MS) ? 'frio' : 'pausa';
}

var STATE_ORDER = { turno: 0, esperando: 1, pausa: 2, frio: 3 };

function sortProcesses(rows, now) {
  return rows.slice().sort(function (a, b) {
    var sa = STATE_ORDER[classify(a.proc, a.prs, now)];
    var sb = STATE_ORDER[classify(b.proc, b.prs, now)];
    if (sa !== sb) return sa - sb;
    // Within every state, oldest first: the longest wait is the one to chase,
    // and the oldest cold process is the strongest cleanup candidate.
    var la = lastActivity(a.proc, a.prs);
    var lb = lastActivity(b.proc, b.prs);
    if (la === null) return 1;
    if (lb === null) return -1;
    return la - lb;
  });
}
```

Extend the footer to export the new functions:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COLD_DAYS: COLD_DAYS, extractTicket: extractTicket,
                     processKey: processKey, groupProcesses: groupProcesses,
                     attachSessions: attachSessions, lastActivity: lastActivity,
                     classify: classify, sortProcesses: sortProcesses };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add classify.js tests/classify-state.test.js
git commit -m "feat: activity rollup and turno/esperando/frio classifier"
```

---

### Task 4: Path resolution and base-branch derivation

Guards the shareability constraint: a hardcoded path regressing in here is the failure this task's tests exist to catch.

**Files:**
- Create: `collect-paths.js`
- Test: `tests/collect-paths.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveWorkspaceRoot(env, checkoutDir) => string`
  - `resolveClaudeDir(env, homeDir) => string`
  - `pickBaseBranch(originHeadRef: string|null, remoteBranches: string[]) => string|null`

- [ ] **Step 1: Write the failing test**

Create `tests/collect-paths.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch } = require('../collect-paths.js');

test('PRQ_WORKSPACE wins when set', () => {
  assert.equal(resolveWorkspaceRoot({ PRQ_WORKSPACE: '/custom/ws' }, '/anything/pr-queue'), '/custom/ws');
});

test('workspace root defaults to the parent of the checkout', () => {
  assert.equal(resolveWorkspaceRoot({}, '/home/dev/repos/pr-queue'), '/home/dev/repos');
});

test('an empty PRQ_WORKSPACE is ignored', () => {
  assert.equal(resolveWorkspaceRoot({ PRQ_WORKSPACE: '' }, '/home/dev/repos/pr-queue'), '/home/dev/repos');
});

test('CLAUDE_CONFIG_DIR wins over the home default', () => {
  assert.equal(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/cfg/claude' }, '/home/dev'), '/cfg/claude');
});

test('claude dir defaults to ~/.claude', () => {
  assert.equal(resolveClaudeDir({}, '/home/dev'), '/home/dev/.claude');
});

test('pickBaseBranch prefers origin/HEAD when present', () => {
  assert.equal(pickBaseBranch('refs/remotes/origin/develop', ['main', 'develop']), 'develop');
  assert.equal(pickBaseBranch('refs/remotes/origin/main', ['main']), 'main');
});

test('pickBaseBranch falls back to develop, then main, then master', () => {
  assert.equal(pickBaseBranch(null, ['main', 'develop', 'master']), 'develop');
  assert.equal(pickBaseBranch(null, ['main', 'master']), 'main');
  assert.equal(pickBaseBranch(null, ['master']), 'master');
});

test('pickBaseBranch returns null rather than guessing', () => {
  assert.equal(pickBaseBranch(null, []), null);
  assert.equal(pickBaseBranch(null, ['trunk', 'release']), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../collect-paths.js'`

- [ ] **Step 3: Write the implementation**

Create `collect-paths.js`:

```js
// Pure resolution of workspace/config locations and base branch.
// No hardcoded absolute paths: everything derives from env or arguments.
const path = require('node:path');

function resolveWorkspaceRoot(env, checkoutDir) {
  const explicit = env && env.PRQ_WORKSPACE;
  if (explicit && String(explicit).trim() !== '') return explicit;
  // pr-queue is expected to sit alongside the repos it reports on.
  return path.dirname(checkoutDir);
}

function resolveClaudeDir(env, homeDir) {
  const explicit = env && env.CLAUDE_CONFIG_DIR;
  if (explicit && String(explicit).trim() !== '') return explicit;
  return path.join(homeDir, '.claude');
}

const BASE_FALLBACKS = ['develop', 'main', 'master'];

function pickBaseBranch(originHeadRef, remoteBranches) {
  if (originHeadRef) {
    const m = String(originHeadRef).match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  const have = new Set(remoteBranches || []);
  for (const cand of BASE_FALLBACKS) if (have.has(cand)) return cand;
  return null;
}

module.exports = { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add collect-paths.js tests/collect-paths.test.js
git commit -m "feat: env-driven path resolution and derived base branch"
```

---

### Task 5: The collector

**Files:**
- Create: `collect.js`, `bin/collect.js`
- Test: `tests/collect.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1, 2 and 4.
- Produces: `collect(opts) => Promise<payload>` matching the *Collector output contract*. `opts` is `{ env, homeDir, checkoutDir, run, listDirs, listFiles, readTail, now }`, all injectable so tests never touch the real disk.
  - `run(cmd, args, cwd) => Promise<string>` — rejects on failure.
  - `listDirs(root) => Promise<string[]>` — subdirectory names that are **main checkouts**, i.e. whose `.git` is a *directory*. A linked worktree's `.git` is a file; including those makes every sibling worktree look like a repo, and `git worktree list` from each re-reports the whole set (measured: 73 rows for 38 paths, one repeated 4×).
  - `listFiles(dir) => Promise<string[]>` — entry names, used to index transcripts.
  - `readTail(path, bytes) => Promise<string>` — the **last** `bytes` of a file. Reading whole transcripts is unnecessary and slow; 64KB is enough to find the last timestamp.
- Also produces: `bin/collect.js`, runnable as `npm run collect`.

- [ ] **Step 1: Write the failing test**

Injecting `run`/`readFile`/`listDirs` is what makes this testable without a real workspace.

Create `tests/collect.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { collect } = require('../collect.js');

const NOW = 1785000000000;

function harness(over) {
  const calls = [];
  const base = {
    env: {}, homeDir: '/home/dev', checkoutDir: '/w/pr-queue', now: () => NOW,
    listDirs: async () => ['humand-web'],
    listFiles: async (dir) => dir.endsWith('projects') ? ['-w-humand-web'] : ['s1.jsonl'],
    readTail: async () => [
      JSON.stringify({ type: 'user', cwd: '/w/humand-web',
                       timestamp: new Date(NOW - 7200000).toISOString() }),
      JSON.stringify({ type: 'pr-link', prNumber: 9294, prRepository: 'HumandDev/humand-web',
                       prUrl: 'https://github.com/HumandDev/humand-web/pull/9294',
                       timestamp: new Date(NOW - 7200000).toISOString() }),
      JSON.stringify({ type: 'ai-title' }),
    ].join('\n'),
    run: async (cmd, args) => {
      calls.push([cmd, args.join(' ')]);
      if (cmd === 'claude') {
        return JSON.stringify([{ pid: 1, cwd: '/w/humand-web', kind: 'interactive',
          startedAt: NOW - 1000, sessionId: 's1', name: 'humand-09', status: 'idle' }]);
      }
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return ' M src/a.ts\n';
      if (a.includes('log -1')) return String(Math.floor((NOW - 3600000) / 1000));
      if (a.includes('rev-list')) return '2';
      return '';
    },
  };
  return { opts: Object.assign(base, over), calls };
}

test('collect returns the payload contract', async () => {
  const { opts } = harness();
  const out = await collect(opts);
  assert.equal(out.generatedAt, NOW);
  assert.equal(out.workspaceRoot, '/w');
  assert.deepEqual(out.warnings, []);
  assert.equal(out.processes.length, 1);
});

test('collect groups the worktree and session into one ticket process', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.key, 'SQSH-3851');
  assert.equal(p.ticket, 'SQSH-3851');
  assert.equal(p.worktrees.length, 1);
  assert.equal(p.worktrees[0].repo, 'humand-web');
  assert.equal(p.worktrees[0].dirty, 1);
  assert.equal(p.worktrees[0].unpushed, 2);
  assert.equal(p.sessions.length, 1);
  assert.equal(p.sessions[0].resumeCmd, 'claude --resume s1');
});

test('collect takes session activity from the transcript, not the agent startedAt', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.sessions[0].lastActivity, NOW - 7200000);
});

test('collect carries the pr-link through', async () => {
  const { opts } = harness();
  const [p] = (await collect(opts)).processes;
  assert.equal(p.sessions[0].prLink.number, 9294);
  assert.equal(p.sessions[0].prLink.repo, 'HumandDev/humand-web');
});

test('collect never reads a whole transcript', async () => {
  // Guards against someone swapping readTail for a full readFile.
  const seen = [];
  const { opts } = harness();
  const wrapped = Object.assign({}, opts, {
    readTail: async (p, bytes) => { seen.push(bytes); return ''; },
  });
  await collect(wrapped);
  assert.ok(seen.length > 0, 'readTail must be called');
  assert.ok(seen.every(b => b === 65536), `expected 64KB reads, got ${seen}`);
});

test('collect puts a workspace-root session in looseSessions, not in a process', async () => {
  const { opts } = harness({
    readTail: async () => JSON.stringify({
      type: 'user', cwd: '/w', timestamp: new Date(NOW - 3600000).toISOString() }),
  });
  const out = await collect(opts);
  assert.equal(out.looseSessions.length, 1);
  assert.equal(out.processes.every(p => p.sessions.length === 0), true);
  // The failure mode being guarded: a process keyed by the workspace root.
  assert.equal(out.processes.some(p => p.key === '/w'), false);
});

test('collect falls back to startedAt for a session with no transcript', async () => {
  const { opts } = harness({ listFiles: async () => [] });
  const out = await collect(opts);
  const all = out.processes.flatMap(p => p.sessions).concat(out.looseSessions);
  assert.equal(all.length, 1);
  assert.equal(all[0].lastActivity, NOW - 1000);
});

test('collect records a warning and keeps going when a repo throws', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      if (args.join(' ').startsWith('worktree list')) throw new Error('not a git repo');
      return '';
    },
  });
  const out = await collect(opts);
  assert.equal(out.processes.length, 0);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].repo, 'humand-web');
  assert.equal(out.warnings[0].step, 'worktrees');
});

test('collect survives claude being absent', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') throw new Error('command not found');
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      if (a.includes('rev-list')) return '0';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  assert.equal(out.processes.length, 1);
  assert.equal(out.processes[0].sessions.length, 0);
  assert.ok(out.warnings.some(w => w.step === 'agents'));
});

test('collect skips git detail for prunable worktrees', async () => {
  const { opts, calls } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/gone\nHEAD abc\nbranch refs/heads/feat/SQSH-7-gone\n' +
               'prunable gitdir file points to non-existent location\n';
      }
      if (a.includes('symbolic-ref')) return 'refs/remotes/origin/develop';
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  const wt = out.processes[0].worktrees[0];
  assert.equal(wt.prunable, true);
  assert.equal(wt.dirty, null);
  assert.equal(wt.lastCommit, null);
  assert.equal(calls.some(c => c[1].startsWith('status')), false);
});

test('collect reports unpushed as null when no base branch can be derived', async () => {
  const { opts } = harness({
    run: async (cmd, args) => {
      if (cmd === 'claude') return '[]';
      const a = args.join(' ');
      if (a.startsWith('worktree list')) {
        return 'worktree /w/humand-web\nHEAD abc\nbranch refs/heads/feat/SQSH-3851-web-ai\n';
      }
      if (a.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (a.includes('for-each-ref')) return 'trunk\nrelease\n';
      if (a.startsWith('status')) return '';
      if (a.includes('log -1')) return String(Math.floor(NOW / 1000));
      return '';
    },
    listFiles: async () => [],
  });
  const out = await collect(opts);
  assert.equal(out.processes[0].worktrees[0].unpushed, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../collect.js'`

- [ ] **Step 3: Write the implementation**

Create `collect.js`:

```js
// IO orchestration. All effects are injected so this is testable without a
// real workspace; bin/collect.js supplies the real implementations.
const nodePath = require('node:path');
const { parseWorktrees, parseStatusShort, parseAgents,
        parseTranscriptTail } = require('./collect-parse.js');
const { resolveWorkspaceRoot, resolveClaudeDir, pickBaseBranch } = require('./collect-paths.js');
const { groupProcesses, attachSessions } = require('./classify.js');

async function collectRepo(repo, repoPath, run, warn) {
  let worktrees;
  try {
    worktrees = parseWorktrees(await run('git', ['worktree', 'list', '--porcelain'], repoPath));
  } catch (e) {
    warn(repo, 'worktrees', e.message);
    return [];
  }

  let base = null;
  try {
    base = pickBaseBranch(await run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath), []);
  } catch {
    try {
      const refs = await run('git', ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'], repoPath);
      base = pickBaseBranch(null, refs.split('\n').map(s => s.trim()).filter(Boolean));
    } catch (e) {
      warn(repo, 'baseBranch', e.message);
    }
  }

  return Promise.all(worktrees.map(async (wt) => {
    const row = { repo, path: wt.path, branch: wt.branch, detached: wt.detached,
                  prunable: wt.prunable, dirty: null, unpushed: null, lastCommit: null };
    // A prunable worktree's directory is gone — running git in it would just fail.
    if (wt.prunable) return row;

    try {
      row.dirty = parseStatusShort(await run('git', ['status', '--short'], wt.path));
    } catch (e) { warn(repo, 'status', e.message); }

    try {
      const secs = (await run('git', ['log', '-1', '--format=%ct'], wt.path)).trim();
      if (secs) row.lastCommit = Number(secs) * 1000;
    } catch (e) { warn(repo, 'lastCommit', e.message); }

    if (base && wt.branch) {
      try {
        const n = (await run('git', ['rev-list', '--count', `origin/${base}..HEAD`], wt.path)).trim();
        if (n) row.unpushed = Number(n);
      } catch (e) { warn(repo, 'unpushed', e.message); }
    }
    return row;
  }));
}

const TAIL_BYTES = 64 * 1024;

// Builds sessionId -> transcript path by scanning the project dirs. Probed at
// 1271 transcripts across 99 dirs; one readdir each, so this is cheap.
async function indexTranscripts(claudeDir, listFiles, warn) {
  const index = new Map();
  const projects = nodePath.join(claudeDir, 'projects');
  let dirs;
  try {
    dirs = await listFiles(projects);
  } catch (e) {
    warn(null, 'transcriptIndex', e.message);
    return index;
  }
  await Promise.all(dirs.map(async (d) => {
    let files;
    try { files = await listFiles(nodePath.join(projects, d)); } catch { return; }
    files.forEach(f => {
      if (f.endsWith('.jsonl')) {
        index.set(f.slice(0, -'.jsonl'.length), nodePath.join(projects, d, f));
      }
    });
  }));
  return index;
}

async function collectSessions(agents, claudeDir, deps, warn) {
  const { listFiles, readTail } = deps;
  const index = await indexTranscripts(claudeDir, listFiles, warn);

  return Promise.all(agents.map(async (a) => {
    const base = {
      sessionId: a.sessionId, name: a.name, kind: a.kind, status: a.status,
      cwd: a.cwd, lastActivity: a.startedAt, prLink: null, branch: null,
      resumeCmd: `claude --resume ${a.sessionId}`,
    };

    const file = index.get(a.sessionId);
    if (!file) return base;  // observed for background agents; not an error

    let tail;
    try {
      tail = await readTail(file, TAIL_BYTES);
    } catch (e) {
      warn(null, 'transcript', e.message);
      return base;
    }

    const { lastTs, lastCwd, prLink } = parseTranscriptTail(tail);
    return Object.assign(base, {
      // NEVER the file mtime: bookkeeping records bump it by hours or days.
      lastActivity: lastTs !== null ? lastTs : a.startedAt,
      cwd: lastCwd || a.cwd,
      prLink,
    });
  }));
}

async function collect(opts) {
  const { env, homeDir, checkoutDir, run, listDirs, listFiles, readTail, now } = opts;
  const warnings = [];
  const warn = (repo, step, message) => warnings.push({ repo, step, message });

  const workspaceRoot = resolveWorkspaceRoot(env, checkoutDir);
  const claudeDir = resolveClaudeDir(env, homeDir);

  let agents = [];
  try {
    agents = parseAgents(await run('claude', ['agents', '--json'], workspaceRoot));
  } catch (e) {
    warn(null, 'agents', e.message);
  }

  const repos = await listDirs(workspaceRoot);
  const [perRepo, rawSessions] = await Promise.all([
    Promise.all(repos.map(repo =>
      collectRepo(repo, nodePath.join(workspaceRoot, repo), run, warn))),
    collectSessions(agents, claudeDir, { listFiles, readTail }, warn),
  ]);

  const worktrees = perRepo.flat();
  const { attached, loose } = attachSessions(rawSessions, worktrees);

  return {
    generatedAt: now(),
    workspaceRoot,
    warnings,
    processes: groupProcesses({ worktrees, sessions: attached }),
    looseSessions: loose,
  };
}

module.exports = { collect };
```

Create `bin/collect.js`:

```js
#!/usr/bin/env node
// Real-IO wrapper around collect(). Prints the payload to stdout.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('../collect.js');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

async function listDirs(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const checks = await Promise.all(dirs.map(async d => {
    // Main checkouts only: `.git` must be a DIRECTORY. A linked worktree has a
    // `.git` file, and treating those as repos makes `git worktree list` report
    // the same worktree set once per sibling — duplicating every row.
    try {
      const st = await fs.stat(path.join(root, d, '.git'));
      return st.isDirectory() ? d : null;
    } catch { return null; }
  }));
  return checks.filter(Boolean);
}

async function listFiles(dir) {
  return fs.readdir(dir);
}

// Reads only the last `bytes` of a file. Transcripts run to thousands of
// records; we only need the tail to find the last real timestamp.
async function readTail(file, bytes) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length === 0) return '';
    await handle.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function main() {
  const payload = await collect({
    env: process.env,
    homeDir: os.homedir(),
    checkoutDir: path.resolve(__dirname, '..'),
    run, listDirs, listFiles, readTail,
    now: () => Date.now(),
  });
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run, listDirs, listFiles, readTail };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Verify against the real workspace**

Run: `npm run collect | head -40`
Expected: real JSON. Then sanity-check the numbers actually match reality:

```bash
npm run collect > /tmp/prq-collect.json
node -e "const d=require('/tmp/prq-collect.json'); const P=d.processes; const wt=P.flatMap(p=>p.worktrees); const ss=P.flatMap(p=>p.sessions); console.log('processes', P.length); console.log('worktrees', wt.length, '| prunable', wt.filter(w=>w.prunable).length, '| detached', wt.filter(w=>w.detached).length); console.log('sessions attached', ss.length, '| loose', d.looseSessions.length); console.log('withPrLink', ss.concat(d.looseSessions).filter(s=>s.prLink).length); console.log('noTicket', P.filter(p=>!p.ticket).length); console.log('warnings', JSON.stringify(d.warnings));"
```

Expected on the machine this was designed against (measured 2026-07-28): **~110 worktrees, 3 prunable, 12 detached**, and `sessions attached + loose` equal to the length of `claude agents --json`. **If the counts disagree, stop and fix the collector — do not proceed.**

Two checks that specifically catch the bugs found while writing this plan:

```bash
# 1. No session's lastActivity may equal its transcript's file mtime by accident.
#    Several sessions had a 9h-to-5day gap; if every value looks like "just now",
#    the implementation regressed to using mtime.
node -e "const d=require('/tmp/prq-collect.json'); const all=d.processes.flatMap(p=>p.sessions).concat(d.looseSessions); all.forEach(s=>console.log(s.name, new Date(s.lastActivity).toISOString()));"

# 2. Compare against the source of truth for one session.
claude agents --json | head -20
```

Timing: `time npm run collect > /dev/null` should land near ~2s and well under 5s. The transcript tail-reads measured 5ms for 8 sessions, so they must not move this number meaningfully — if they do, something is reading whole files.

- [ ] **Step 6: Commit**

```bash
git add collect.js bin/collect.js tests/collect.test.js
git commit -m "feat: local collector for worktrees, sessions and git state"
```

---

### Task 6: The sidecar server

**Files:**
- Create: `serve.js`
- Test: `tests/serve.test.js`

**Interfaces:**
- Consumes: `collect()` from Task 5, plus `run`/`listDirs` from `bin/collect.js`.
- Produces: `createServer({ collectFn }) => http.Server` and, when run directly, a listener on `PRQ_PORT ?? 7777`.

- [ ] **Step 1: Write the failing test**

Create `tests/serve.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../serve.js');

function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

test('GET /api/local returns the collector payload as JSON', async () => {
  const server = createServer({ collectFn: async () => ({ processes: [], warnings: [], workspaceRoot: '/w' }) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/local`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual((await res.json()).processes, []);
  server.close();
});

test('GET /api/local returns 500 with a message when the collector throws', async () => {
  const server = createServer({ collectFn: async () => { throw new Error('boom'); } });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/api/local`);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /boom/);
  server.close();
});

test('serves index.html at the root', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<script src="state\.js">/);
  server.close();
});

test('serves a static js file with the right content type', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/classify.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  server.close();
});

test('refuses path traversal', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  const res = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
  assert.ok(res.status === 403 || res.status === 404);
  server.close();
});

test('unknown paths 404', async () => {
  const server = createServer({ collectFn: async () => ({}) });
  const port = await listen(server);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope.js`)).status, 404);
  server.close();
});
```

Note: these tests assert only what exists at Task 6. The `local.js` script tag is verified in Task 8, where it is added — no test here is allowed to fail pending a later task.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../serve.js'`

- [ ] **Step 3: Write the implementation**

Create `serve.js`:

```js
// Local sidecar: serves the static site plus GET /api/local.
// Bound to 127.0.0.1 only — this exposes local filesystem state and must
// never be reachable from the network.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { collect } = require('./collect.js');
// bin/collect.js only runs main() when invoked directly, so requiring it here
// is safe and avoids duplicating the real IO implementations.
const { run, listDirs, listFiles, readTail } = require('./bin/collect.js');

const ROOT = __dirname;
const DEFAULT_PORT = 7777;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
};

function realCollect() {
  return collect({
    env: process.env,
    homeDir: os.homedir(),
    checkoutDir: ROOT,
    run, listDirs, listFiles, readTail,
    now: () => Date.now(),
  });
}

function createServer(opts) {
  const collectFn = (opts && opts.collectFn) || realCollect;

  return http.createServer(async (req, res) => {
    // The whole handler is wrapped: a synchronous throw in here (notably
    // decodeURIComponent on a malformed escape like `/%`) would otherwise
    // escape as an uncaught exception and kill the process, taking
    // /api/local down with it.
    try {
      await handle(req, res, collectFn);
    } catch (err) {
      if (!res.headersSent) {
        const bad = err instanceof URIError;
        res.writeHead(bad ? 400 : 500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(bad ? 'bad request' : 'internal error');
      } else {
        res.destroy();
      }
    }
  });
}

async function handle(req, res, collectFn) {
  {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/local') {
      try {
        const payload = await collectFn();
        const body = JSON.stringify(payload);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
                             'cache-control': 'no-store' });
        return res.end(body);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: String(err && err.message || err) }));
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep)) {
      res.writeHead(403); return res.end('forbidden');
    }

    try {
      const data = await fs.readFile(full);
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }
}

// Validates PRQ_PORT before listen(). server.listen(NaN) throws synchronously
// and bypasses the 'error' handler, so an invalid value would surface as a raw
// stack trace instead of a message naming the offending variable.
function resolvePort(env) {
  const raw = env.PRQ_PORT;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PRQ_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return n;
}

if (require.main === module) {
  let port;
  try {
    port = resolvePort(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const server = createServer({});
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Never auto-increment: the whole point is a stable bookmark.
      console.error(`Port ${port} is already in use. Free it, or set PRQ_PORT to another port.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`pr-queue local → http://localhost:${port}`);
  });
}

module.exports = { createServer, DEFAULT_PORT, resolvePort };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, except the `index.html` assertion if Task 8 has not landed yet.

- [ ] **Step 5: Verify the port behavior by hand**

```bash
node serve.js &            # expect: pr-queue local → http://localhost:7777
curl -s localhost:7777/api/local | head -c 200
node serve.js              # expect: "Port 7777 is already in use." and exit 1
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add serve.js tests/serve.test.js
git commit -m "feat: local sidecar serving static site plus /api/local"
```

---

### Task 7: Expose the PR join key

**Files:**
- Modify: `github.js` (the `enrichOwnPR` return object, ~line 114-122)

**Interfaces:**
- Consumes: nothing.
- Produces: `state.ownPRs` entries additionally carrying `headRef: string` and `updatedAt: Date`, plus `humanReviews: number` — the fields Task 8's join and Task 3's classifier need.

- [ ] **Step 1: Add the three fields**

`prDetails` is already fetched, so `head.ref` costs nothing. `pr.updated_at` comes from the search result already in hand. `humanReviews` is `humanRevs.length`, already computed for `approved`/`changesReq`.

In `github.js`, in `enrichOwnPR`'s return, add to the returned object:

```js
      headRef: prDetails.head.ref,
      updatedAt: new Date(pr.updated_at),
      humanReviews: humanRevs.length,
```

- [ ] **Step 2: Verify in the browser**

With `node serve.js` running, open `http://localhost:7777`, save the PAT, let own PRs load, then in the console:

```js
state.ownPRs.map(p => [p.number, p.headRef, p.humanReviews, p.updatedAt])
```

Expected: every row has a non-empty `headRef` matching the PR's branch, a numeric `humanReviews`, and a valid `Date`. **Zero new network requests** — confirm the request count in the Network tab is unchanged from before this task.

- [ ] **Step 3: Commit**

```bash
git add github.js
git commit -m "feat: expose headRef, updatedAt and humanReviews on own PRs"
```

---

### Task 8: The panel

**Files:**
- Create: `local.js`
- Modify: `index.html` (CSS near line 557; `#proc-section` markup above `.main-layout` at line 731; script tags at lines 789-793)

**Interfaces:**
- Consumes: `classify`, `sortProcesses`, `lastActivity`, `COLD_DAYS` globals from `classify.js`; `state.ownPRs` (with `headRef` from Task 7); `timeAgo` and `esc` globals from `render.js`.
- Produces: `initLocalPanel()`, called on load; `window.LOCAL_STATE` holding the last payload.

- [ ] **Step 1: Add the markup, CSS and script tags**

In `index.html`, immediately before `<div class="main-layout">` (line 731), insert:

```html
  <div class="proc-section" id="proc-section" style="display:none">
    <div class="proc-header">
      <button type="button" class="proc-toggle" id="proc-toggle">
        <span id="proc-caret">▾</span> Procesos activos
        <span class="count-badge" id="proc-count"></span>
      </button>
      <span class="proc-meta" id="proc-meta"></span>
    </div>
    <div class="proc-body" id="proc-body"></div>
  </div>
```

Add the CSS next to `.main-layout` (near line 557):

```css
.proc-section { margin-bottom: 16px; }
.proc-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.proc-toggle { background: none; border: 0; color: inherit; font: inherit;
  cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 0; }
.proc-meta { font-size: 11px; opacity: .6; margin-left: auto; }
.proc-body { display: grid; gap: 6px; }
.proc-body.hidden { display: none; }
.proc-row { display: grid; grid-template-columns: 90px 1fr auto;
  gap: 10px; align-items: center; padding: 8px 10px; border-radius: 6px;
  background: rgba(127,127,127,.06); font-size: 12px; }
.proc-state { font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .04em; padding: 2px 6px; border-radius: 4px; text-align: center; }
.proc-state.turno     { background: #d73a49; color: #fff; }
.proc-state.esperando { background: #dbab09; color: #1b1f23; }
.proc-state.pausa     { background: rgba(127,127,127,.45); }
.proc-state.frio      { background: rgba(127,127,127,.25); }
.proc-key { font-weight: 600; }
.proc-noticket { font-size: 10px; opacity: .55; margin-left: 6px; }
.proc-detail { opacity: .7; font-size: 11px; }
.proc-detail code { font-size: 10px; opacity: .8; }
@media (max-width: 680px) { .proc-row { grid-template-columns: 70px 1fr; } }
```

Change the script block (lines 789-793) to load `classify.js` before `local.js`:

```html
<script src="state.js"></script>
<script src="github.js"></script>
<script src="score.js"></script>
<script src="classify.js"></script>
<script src="render.js"></script>
<script src="app.js"></script>
<script src="local.js"></script>
```

- [ ] **Step 2: Write `local.js`**

```js
// Local-only "procesos activos" panel.
//
// Mounts ONLY if /api/local answers. On GitHub Pages that request 404s and
// this file does nothing at all, which is what keeps the shared deploy
// byte-for-byte unchanged for everyone else.

const PROC_CACHE_KEY     = 'prq_proc_cache';
const PROC_COLLAPSED_KEY = 'prq_proc_collapsed';

const procEl = {
  section: () => document.getElementById('proc-section'),
  body:    () => document.getElementById('proc-body'),
  count:   () => document.getElementById('proc-count'),
  meta:    () => document.getElementById('proc-meta'),
  caret:   () => document.getElementById('proc-caret'),
  toggle:  () => document.getElementById('proc-toggle'),
};

function procPRsFor(proc) {
  const own = (typeof state !== 'undefined' && state.ownPRs) || [];
  return own.filter(pr => pr.headRef && proc.branches.indexOf(pr.headRef) !== -1);
}

// A session whose cwd resolved to no worktree can still be placed if its
// pr-link matches a PR we know about: that PR's headRef gives the branch,
// which gives the process. Sessions that still match nothing stay loose and
// at least render their PR link.
function mergeLooseSessions(payload) {
  const own = (typeof state !== 'undefined' && state.ownPRs) || [];
  const stillLoose = [];

  (payload.looseSessions || []).forEach(s => {
    if (!s.prLink) { stillLoose.push(s); return; }
    const pr = own.find(p =>
      p.number === s.prLink.number &&
      s.prLink.repo && s.prLink.repo.toLowerCase() === `${p.owner}/${p.repo}`.toLowerCase());
    if (!pr || !pr.headRef) { stillLoose.push(s); return; }

    const host = payload.processes.find(p => p.branches.indexOf(pr.headRef) !== -1);
    if (!host) { stillLoose.push(s); return; }

    host.sessions.push(Object.assign({}, s, { branch: pr.headRef }));
    if (typeof s.lastActivity === 'number' &&
        (host.lastLocalActivity === null || s.lastActivity > host.lastLocalActivity)) {
      host.lastLocalActivity = s.lastActivity;
    }
  });

  payload.looseSessions = stillLoose;
}

function looseRowHTML(sessions) {
  const items = sessions.map(s => {
    const link = s.prLink && s.prLink.url
      ? ` <a href="${esc(s.prLink.url)}" target="_blank">#${s.prLink.number}</a>` : '';
    const when = s.lastActivity ? ` <span class="proc-detail">${timeAgo(new Date(s.lastActivity))}</span>` : '';
    return `${esc(s.name || s.sessionId.slice(0, 8))}${s.status ? ' (' + esc(s.status) + ')' : ''}${link}${when}`;
  }).join(' · ');

  return `<div class="proc-row">
    <span class="proc-state frio">Sueltas</span>
    <span><span class="proc-key">Sesiones sin worktree</span>
      <br><span class="proc-detail">${items}</span></span>
    <span class="proc-detail">${sessions.length}</span>
  </div>`;
}

const PROC_STATE_LABELS = { turno: 'Tu turno', esperando: 'Esperando',
                            pausa: 'En pausa', frio: 'Frío' };

function procStateLabel(s) {
  return PROC_STATE_LABELS[s] || s;
}

function procRowHTML(row, now) {
  const p = row.proc;
  const s = classify(p, row.prs, now);
  const last = lastActivity(p, row.prs);

  const bits = [];
  row.prs.forEach(pr => {
    const flags = [];
    if (pr.draft) flags.push('draft');
    if (pr.ci === 'failed') flags.push('CI roja');
    if (pr.ci === 'pending') flags.push('CI corriendo');
    if (pr.conflicts) flags.push('conflictos');
    if (pr.changesReq) flags.push('cambios pedidos');
    else if (pr.approved) flags.push('aprobado');
    else if ((pr.humanReviews || 0) === 0) flags.push('sin review');
    bits.push(`<a href="${esc(pr.url)}" target="_blank">#${pr.number}</a>` +
      (flags.length ? ` <span class="proc-detail">${esc(flags.join(' · '))}</span>` : ''));
  });

  const dirty = p.worktrees.reduce((n, w) => n + (w.dirty || 0), 0);
  if (dirty > 0) bits.push(`<span class="proc-detail">${dirty} sin commitear</span>`);

  const prunable = p.worktrees.filter(w => w.prunable).length;
  if (prunable > 0) bits.push(`<span class="proc-detail">${prunable} worktree prunable</span>`);

  const detached = p.worktrees.filter(w => w.detached).length;
  if (detached > 0) bits.push(`<span class="proc-detail">${detached} detached</span>`);

  if (p.sessions.length > 0) {
    const sess = p.sessions.map(x =>
      `${esc(x.name || x.sessionId.slice(0, 8))}${x.status ? ' (' + esc(x.status) + ')' : ''}`).join(', ');
    bits.push(`<span class="proc-detail">sesión: ${sess} · <code>claude --resume ${esc(p.sessions[0].sessionId)}</code></span>`);
  }

  const repos = [...new Set(p.worktrees.map(w => w.repo))].join(', ');

  return `<div class="proc-row">
    <span class="proc-state ${s}">${procStateLabel(s)}</span>
    <span>
      <span class="proc-key">${esc(p.key)}</span>${p.ticket ? '' : '<span class="proc-noticket">sin ticket</span>'}
      ${repos ? `<span class="proc-detail"> · ${esc(repos)}</span>` : ''}
      <br>${bits.join(' · ') || '<span class="proc-detail">sin PR</span>'}
    </span>
    <span class="proc-detail">${last ? timeAgo(new Date(last)) : '—'}</span>
  </div>`;
}

function renderLocalPanel() {
  const payload = window.LOCAL_STATE;
  if (!payload || !payload.processes) return;

  const now = Date.now();
  mergeLooseSessions(payload);
  const rows = payload.processes.map(proc => ({ proc, prs: procPRsFor(proc) }));
  const sorted = sortProcesses(rows, now);

  procEl.section().style.display = '';
  procEl.body().innerHTML = sorted.map(r => procRowHTML(r, now)).join('')
    + ((payload.looseSessions || []).length ? looseRowHTML(payload.looseSessions) : '');

  const states = sorted.map(r => classify(r.proc, r.prs, now));
  const count = s => states.filter(x => x === s).length;

  // The badge counts what needs a decision from you, not everything that exists.
  procEl.count().textContent = count('turno') || '';

  const warn = (payload.warnings || []).length;
  procEl.meta().textContent =
    `${sorted.length} procesos · ${count('turno')} tu turno · ${count('esperando')} esperando · ` +
    `${count('pausa')} en pausa · ${count('frio')} fríos (>${COLD_DAYS}d)` +
    (warn ? ` · ${warn} warnings` : '') +
    (payload.generatedAt ? ` · ${timeAgo(new Date(payload.generatedAt))}` : '');
}

function applyProcCollapsed() {
  const collapsed = localStorage.getItem(PROC_COLLAPSED_KEY) === '1';
  procEl.body().classList.toggle('hidden', collapsed);
  procEl.caret().textContent = collapsed ? '▸' : '▾';
}

let procMounted = false;

// Everything that makes the panel visible and interactive, exactly once.
// The cached paint and the fetched paint both go through here, so the
// collapse preference is applied from the very first frame and the toggle is
// never rendered without its listener.
function mountPanel() {
  renderLocalPanel();
  applyProcCollapsed();
  if (procMounted) return;
  procMounted = true;

  procEl.toggle().addEventListener('click', () => {
    const collapsed = localStorage.getItem(PROC_COLLAPSED_KEY) === '1';
    localStorage.setItem(PROC_COLLAPSED_KEY, collapsed ? '0' : '1');
    applyProcCollapsed();
  });

  // Own PRs load asynchronously and arrive after this point, so the first
  // render has no PR detail. Wrap the existing renderOwnPRs (a global, since
  // these are plain scripts) to re-render the panel whenever they land —
  // cheaper and less invasive than editing render.js.
  if (typeof window.renderOwnPRs === 'function' && !window.renderOwnPRs.__procWrapped) {
    const inner = window.renderOwnPRs;
    const wrapped = function () {
      const out = inner.apply(this, arguments);
      try { renderLocalPanel(); } catch (e) { console.warn('proc panel render failed', e); }
      return out;
    };
    wrapped.__procWrapped = true;
    window.renderOwnPRs = wrapped;
  }
}

// The panel must never survive a failed fetch. A stale cached payload
// rendered as if it were current is worse than no panel at all — this
// feature exists to say which work is actually fresh.
function unmountPanel() {
  window.LOCAL_STATE = null;
  procEl.body().innerHTML = '';
  procEl.count().textContent = '';
  procEl.meta().textContent = '';
  procEl.section().style.display = 'none';
}

async function initLocalPanel() {
  // Paint the cached payload first so the panel is never empty on load.
  let painted = false;
  try {
    const cached = localStorage.getItem(PROC_CACHE_KEY);
    if (cached) { window.LOCAL_STATE = JSON.parse(cached); mountPanel(); painted = true; }
  } catch { /* ignore a corrupt cache */ }

  let payload;
  try {
    const res = await fetch('/api/local', { cache: 'no-store' });
    if (!res.ok) throw new Error('no sidecar');
    payload = await res.json();
    if (!payload || !Array.isArray(payload.processes)) throw new Error('bad payload');
  } catch {
    // GitHub Pages lands here, and so does a developer whose sidecar is down.
    if (painted) unmountPanel();
    return;
  }

  window.LOCAL_STATE = payload;
  try { localStorage.setItem(PROC_CACHE_KEY, JSON.stringify(payload)); } catch { /* quota */ }

  mountPanel();
}

initLocalPanel();
```

- [ ] **Step 3: Extend the serve test to cover the new script tag**

Now that the tag exists, assert it. In `tests/serve.test.js`, in the `serves index.html at the root` test, add:

```js
  assert.match(body, /<script src="classify\.js">/);
  assert.match(body, /<script src="local\.js">/);
```

(capture `const body = await res.text();` once and reuse it for all three assertions).

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Verify the panel against reality**

With `node serve.js` running, open `http://localhost:7777`:

1. Panel appears above the main queue with real processes.
2. Spot-check three rows against the terminal: `git -C <path> status --short | wc -l` matches the "sin commitear" count; `claude agents --json` matches the session name and status.
3. A process whose PR has an unanswered comment shows **Tu turno**; one with an unreviewed open PR shows **Esperando**; a worktree untouched >14 days shows **Frío**.
4. Collapse it, reload → still collapsed. Expand, reload → still expanded.
5. **The panel gains PR detail once own PRs load** — rows start without PR info and fill in a second or two later. If they never fill in, the `renderOwnPRs` wrap did not take.
6. **Session activity is believable.** Cross-check one idle session against its transcript:
   ```js
   window.LOCAL_STATE.processes.flatMap(p => p.sessions)
     .map(s => [s.name, new Date(s.lastActivity).toISOString()])
   ```
   A session last worked on days ago must show days ago, not minutes. Minutes-ago for everything means the implementation regressed to file mtime.
7. **A "Sesiones sin worktree" row appears** for sessions whose `cwd` is the workspace root, rather than those sessions forming a process named after a directory.

- [ ] **Step 5: Verify the self-hide — this is the shared-deploy safety check**

```bash
kill %1                      # stop the sidecar
python3 -m http.server 8123  # serve the same files with no /api/local
```

Open `http://localhost:8123`. Expected: **no panel, no console errors, pr-queue behaves exactly as before.** This is the experience every other user on Pages gets. Then confirm with the real thing: open the Pages URL and check that the panel is absent and the console is clean.

- [ ] **Step 6: Verify without a PAT**

In a fresh private window on `http://localhost:7777`, do not save a token. Expected: the panel still renders from local data, with every row showing "sin PR". Local data must not depend on GitHub auth.

- [ ] **Step 7: Commit**

```bash
git add local.js index.html tests/serve.test.js
git commit -m "feat: active processes panel, self-hiding without the sidecar"
```

---

### Task 9: Shareability — launchd installer and README

Other developers running their own sidecar is a constraint of this change, not a follow-up. This task is what makes it true.

**Files:**
- Create: `scripts/install-launchd.sh`, `README.md`
- Test: `tests/shareability.test.js`

**Interfaces:**
- Consumes: `serve.js` from Task 6.
- Produces: an opt-in launchd agent; documentation.

- [ ] **Step 1: Write the failing test**

The real risk this guards is a `/Users/<someone>` creeping into committed code. Create `tests/shareability.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CODE = ['classify.js', 'collect.js', 'collect-parse.js', 'collect-paths.js',
              'serve.js', 'local.js', 'bin/collect.js', 'scripts/install-launchd.sh'];

test('no committed code contains a hardcoded home directory', () => {
  for (const f of CODE) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    assert.ok(!/\/Users\/[a-z]/i.test(src), `${f} contains a hardcoded /Users path`);
    assert.ok(!/\/home\/[a-z]/i.test(src), `${f} contains a hardcoded /home path`);
  }
});

test('the launchd installer derives its paths instead of baking them in', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/install-launchd.sh'), 'utf8');
  assert.match(src, /BASH_SOURCE/);
  assert.match(src, /\$HOME/);
});

test('the README documents the localStorage gotcha and both env vars', () => {
  const src = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(src, /PRQ_WORKSPACE/);
  assert.match(src, /PRQ_PORT/);
  assert.match(src, /localStorage/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `ENOENT: scripts/install-launchd.sh`

- [ ] **Step 3: Write the installer**

Create `scripts/install-launchd.sh`:

```bash
#!/usr/bin/env bash
# Opt-in: keep the pr-queue sidecar running so localhost:7777 is always live.
# Not required — `node serve.js` is the baseline. Paths are derived, never baked in.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.prqueue.local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PRQ_PORT:-7777}"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/serve.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRQ_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/prqueue-local.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/prqueue-local.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed $LABEL → http://localhost:$PORT"
echo "Logs:      $HOME/Library/Logs/prqueue-local.log"
echo "Uninstall: launchctl unload $PLIST && rm $PLIST"
```

Then: `chmod +x scripts/install-launchd.sh`

- [ ] **Step 4: Write the README**

Create `README.md`:

```markdown
# pr-queue

Dashboard for the PR review queue (other people's PRs worth reviewing, plus your own),
with an optional local panel showing your **active processes** — worktrees, Claude Code
sessions and PRs grouped by ticket-or-branch.

## The review queue

Static site, no build step. Open the deployed page, paste a GitHub PAT with `repo`
scope, pick your tribe label. Everything is stored in your browser's localStorage.

## The active-processes panel (local only)

The panel needs a small local sidecar, because it reads your filesystem: git worktrees,
their dirty/unpushed state, and `claude agents --json`. **None of that leaves your
machine** — the deployed page has no access to it and never will.

```bash
git clone https://github.com/sfavaron-hu/pr-queue.git
cd pr-queue
node serve.js          # → http://localhost:7777
```

Open http://localhost:7777. You get the normal review queue *plus* the panel.

Prefer it always running? `./scripts/install-launchd.sh` installs an opt-in launchd
agent (macOS) that keeps it alive across reboots. It prints its own uninstall command.

### Where it looks

| Env var | Default | What it does |
|---|---|---|
| `PRQ_WORKSPACE` | the parent directory of this checkout | Where to look for repos. Every direct subdirectory containing `.git` is scanned. |
| `PRQ_PORT` | `7777` | Sidecar port. If it is taken, the sidecar exits with an error rather than picking another — a stable bookmark is the point. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its session indexes. |

The default assumes pr-queue is cloned **next to** the repos it reports on. If yours
live elsewhere: `PRQ_WORKSPACE=~/code node serve.js`.

### Gotchas

- **You have to re-enter your PAT.** `localhost:7777` is a different browser origin
  from the deployed page, so it has its own localStorage. Your token and tribe/repo
  config do not carry over. One-time cost, per origin.
- **The panel is invisible without the sidecar.** On the deployed page `/api/local`
  404s and the panel simply never mounts. That is deliberate: the same `main` serves
  both audiences, and someone who never runs the sidecar sees no change at all.
- **No Claude Code? Still works.** You get worktrees and PRs, with no session rows,
  and a warning in the payload. Every source degrades on its own.
- **Prunable worktrees show no git detail.** Their directory is gone, so `git status`
  cannot run. They are surfaced as cleanup candidates instead.
- **Detached worktrees never attach to a PR.** With no branch there is no join key, so
  they appear as branchless rows rather than being dropped.
- **State means turns, not age.** *Tu turno* is unanswered review comments, failed CI,
  conflicts or your own recent work. *Esperando* is an unreviewed PR or CI in flight —
  not your move, however old. *En pausa* is neither: usually no PR yet, just set down.
  *Frío* is nothing from anyone in 14 days.
- **Session liveness is not activity.** An open terminal only means a terminal was left
  open. Activity is the newest of: last session message, last commit, last PR update.
- **Transcript file mtime is not last activity, and this bites.** Claude Code appends
  bookkeeping records (`ai-title`, `mode`, `permission-mode`) with no timestamp long
  after the last real message — measured skews of 9 hours and 5 days. Activity comes
  from the last `timestamp` inside the transcript, read from its final 64KB.
- **Sessions started from the workspace root show under "Sesiones sin worktree."**
  Their `cwd` belongs to no worktree, so there is nothing to attach them to. If such a
  session has recorded a `pr-link`, it gets moved into that PR's process automatically.

## Tests

```bash
npm test        # node --test, no dependencies
```
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 6: Verify the installer end to end**

```bash
./scripts/install-launchd.sh
sleep 2 && curl -s localhost:7777/api/local | head -c 120   # expect JSON
launchctl unload "$HOME/Library/LaunchAgents/com.prqueue.local.plist"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/install-launchd.sh README.md tests/shareability.test.js
git commit -m "docs: README and opt-in launchd agent for local sidecar"
```

---

## Self-review notes

Checked against the spec, section by section:

| Spec section | Task |
|---|---|
| 1. `collect.js` — sources, cost, discovery, degradation, prunable/detached | 1, 4, 5 |
| 1. Session corrections — transcript index, tail timestamps, join priority | 1, 2, 5 |
| 1. Worktree layouts — siblings and nested, no path assumptions | 2 (`attachSessions` longest-match), 5 |
| 2. `serve.js` — `/api/local`, port 7777, launchd opt-in | 6, 9 |
| 3. `local.js` — self-hiding, placement, stale-then-revalidate | 8 |
| 4. Process model — `ticket ?? branch`, aggregation | 2 |
| 5. PR join — `headRef`, `updatedAt`, zero extra calls | 7 |
| 6. Activity and classification — four states, 14 days, sorting | 3 |
| 7. Shareability — no hardcoded paths, env vars, README | 4, 9 |
| Accepted redundancy — "Mis PRs" untouched | no task, by design |
| Testing — classifier, `lastActivity`, grouping, parsers, degradation, paths, base branch | 1-5, 9 |

Notes for the implementer:

- The spec's `humanReviews` requirement is implicit ("PR open with no human review yet"). Task 7 adds the field explicitly, and Task 3's classifier consumes it. Without Task 7, every PR looks unreviewed and lands in *esperando*.
- Task 6's `index.html` test asserts the `local.js` script tag that Task 8 adds. Executing in order, that one assertion fails until Task 8 lands. It is placed in Task 6 because `serve.js` is what makes the tag reachable; do not "fix" it by weakening the assertion.
- **`bin/collect.js` guards `main()` behind `require.main === module`.** `serve.js` requires it for the real IO implementations; without the guard, importing it would run the collector and print to stdout on every server start.
- **Three things here contradict the obvious implementation, and each was measured on the real machine.** Do not "simplify" them back:
  1. `sessions-index.json` is **not** a source — 0 of 14 live sessions resolved through it.
  2. Session activity is the last transcript **`timestamp`**, never the file **mtime** — the observed skew was 9 hours in one case and 5 days in another.
  3. An unresolved session goes to `looseSessions` and is **never keyed by its `cwd`** — most sessions' cwd is the workspace root, so keying by it collapses them into one meaningless row.
- `mergeLooseSessions` mutates the payload, and `renderLocalPanel` runs more than once (cache paint, fetch, then each own-PR render). It is idempotent because a merged session is removed from `looseSessions` as it moves. Keep that property if you touch it.
