# Active processes panel

## Problem

Work is spread across many parallel "processes" — a Jira ticket (or a branch with no ticket yet), its worktrees, its open Claude Code sessions, and its PRs. Today there is no single view of them, so two failure modes are invisible:

1. **No prioritization signal.** Open PRs and open sessions are visible in separate places, but not *whose turn it is*. A PR waiting three weeks on someone else's review looks the same as one waiting on the author.
2. **No decay signal.** Finished sessions get closed without ceremony; unfinished ones stay open in a terminal for weeks waiting on external blockers. Snapshot at design time: **91 worktrees across 23 repos**. Nothing surfaces which of those are dead.

`pr-queue` already shows the review queue and own PRs, so it is the natural home — but it is deployed on GitHub Pages and used by several people, each with their own PAT. **Any design that publishes one person's local state to a shared remote is wrong.** This panel is therefore local-only and self-hiding.

## Non-goals

- Writing local state anywhere off the machine (no gist, no commit, no shared endpoint).
- Changing anything about how pr-queue behaves for other users on Pages.
- Replacing the "Mis PRs" column. See *Accepted redundancy* below.
- Making Jira the source of truth. Processes without a ticket are first-class.

## Design

### 1. `collect.js` — local data, stdout, no HTTP

Node, no dependencies. Emits one JSON document on stdout. Knows nothing about GitHub or HTTP, which is what keeps the transport swappable.

Split for testability: `collect.js` exports pure functions (parsers, ticket extraction, grouping, `lastActivity`, the state classifier) and a `collect()` that does the IO. A thin `bin/collect.js` wrapper calls `collect()` and prints. Tests import the pure functions directly and never touch the real disk.

Sources, all already verified to exist:

| Source | Gives |
|---|---|
| `claude agents --json` | active sessions: `sessionId`, `name`, `cwd`, `kind` (`interactive`/`background`), `status` (`idle`/…) or `state` (`blocked`/…), `startedAt` |
| `~/.claude/projects/*/sessions-index.json` | per session: `gitBranch`, `projectPath`, `summary`, `modified`, `messageCount` |
| `git worktree list --porcelain` per repo | worktree path + branch |
| `git log -1 --format=%ct` per worktree | last commit timestamp |
| `git status --short` per worktree | dirty file count |
| `git log origin/<base>..HEAD --oneline` per worktree | unpushed commit count |

Measured cost (23 repos, 91 worktrees, warm FS): `claude agents` 0.76s, reading 99 index files (52K) 0.03s, `worktree list` 0.29s, `git log -1` 1.12s, `git status` 2.75s — **~5s serial**. Repos are walked concurrently, which puts the target at ~1.5–2s. `git status` is more than half the budget; if it ever becomes the bottleneck it is the first thing to make optional, since dirty-state is the least essential field.

Repo discovery: directories containing `.git` directly under the workspace root. The root is resolved in this order, with **no hardcoded path anywhere** (see *Shareability*):

1. `PRQ_WORKSPACE` env var, if set.
2. Otherwise the parent directory of the pr-queue checkout — which is correct for anyone who clones pr-queue alongside their repos.

The Claude config directory is `CLAUDE_CONFIG_DIR` if set, else `~/.claude`.

Base branch per repo (needed for the unpushed count) is **derived, not assumed** — repos here disagree, some `develop` and some `main`. Read `git symbolic-ref refs/remotes/origin/HEAD`; if that ref is absent (common on fresh clones), fall back to the first of `develop`, `main`, `master` that exists on the remote, and if none do, report the unpushed count as unknown rather than guessing.

**Degradation is per-source, never fatal.** No `claude` on PATH → processes render without sessions. A repo that throws → that repo is skipped and appended to a `warnings[]` array in the output. The collector exits 0 with partial data rather than failing closed; a panel showing 20 of 23 repos beats a panel showing an error.

### 2. `serve.js` — static files + `/api/local`

Node, no dependencies. Serves the existing pr-queue static files, plus:

- `GET /api/local` → runs `collect.js`, returns its JSON. Computed per request, so it is always fresh; at ~2s there is no reason to cache server-side.

Kept alive on **port 7777** by a launchd agent, so `localhost:7777` is a bookmark that always has data. 7777 was verified free and sits well clear of the Vite dev-server range, which auto-increments from 5173. The port is overridable via `PRQ_PORT`; if the port is taken, `serve.js` fails with a clear message rather than silently picking another, since the whole point is a stable bookmark.

**launchd is opt-in.** The baseline is one command, `node serve.js`. The always-on agent is a convenience installed by a separate script, never a prerequisite — a teammate trying this out should not have to install a background daemon to see whether it is useful. This is the whole reason for choosing a sidecar over a scheduled collector: the data has to be there when the page opens, not when the user remembers to refresh.

### 3. `local.js` — the panel, self-hiding

New file loaded by `index.html` like the existing scripts.

On load it fetches `/api/local`. **On any failure — 404, network error, non-JSON — it returns without mounting anything.** That is the Pages case for every other user: the file loads, the fetch 404s, and pr-queue is byte-for-byte the behavior it has today. There is no origin sniffing and no build flag; absence of the endpoint *is* the signal.

Placement: a collapsible full-width `#proc-section` above `.main-layout`. Not inside `#own-column`, for two reasons — `.main-layout` is `2fr 1fr` and a third column would crowd it, and `#own-column` is `display:none` until a token and `state.me` exist, whereas this panel needs no token at all (local data works unauthenticated). Collapsed state persists in localStorage under `prq_proc_collapsed`.

Follows the existing stale-then-revalidate pattern: last payload cached in localStorage (`prq_proc_cache`), rendered immediately on load, replaced when the fetch resolves. At ~2s this is a polish detail rather than a necessity, but it matches how `prq_prs_cache` already behaves.

### 4. Process model

**Key: `ticket ?? branch`.** The ticket is extracted from the branch name (`/([A-Z]{3,5}-\d+)/`). Branches with no ticket group by branch name and are first-class rows, explicitly marked. Work here often starts before the ticket exists and the ticket is sometimes filed retroactively, so a model that assumes a ticket would drop real work on the floor. The mark doubles as a nudge: the panel shows which processes have no ticket yet.

A process aggregates:
- **worktrees** — path, branch, dirty count, unpushed count, last commit
- **sessions** — name, `kind`, `status`/`state`, last activity, resume command (`claude --resume <sessionId>`)
- **PRs** — joined from `state.ownPRs` by head ref

### 5. PR join

`enrichOwnPR` in `github.js` already fetches `pulls/{number}`, whose response contains `head.ref` — it just isn't returned. Two fields get added to its return value:

```js
headRef: prDetails.head.ref,
updatedAt: new Date(pr.updated_at),
```

**Zero additional API calls.** `state.ownPRs` already carries `ci`, `conflicts`, `draft`, `approved`, `changesReq`, `newComments`, `newApprovals`, `newChanges` — the complete signal set the classifier needs.

Known limitation, accepted for v1: `loadOwnPRs` scopes its search by `label:<tribu>`, so a PR without the tribe label will not join. Because the panel's spine is *local* data, such a process still appears — just without PR detail. Adding an unlabeled own-PR query is a follow-up if this proves to matter in practice, not part of this change.

### 6. Activity and state classification

**Session liveness is deliberately not used as the activity signal.** An open terminal means only that a terminal was left open — sometimes for weeks, waiting on an external blocker — and a closed one means nothing at all, since finished sessions are closed without a trace. Sessions are an *attachment* to a process (with a resume command), never evidence that it is moving.

```
lastActivity = max(session .jsonl mtime, last commit, PR updatedAt)
```

Three states, evaluated in order:

1. **Tu turno** — `changesReq`, or unseen comments/reviews (`newComments`/`newChanges` > 0), or `ci === 'failed'`, or `conflicts`, or own activity within 48h.
2. **Esperando a otro** — PR open with no human review yet, or `ci === 'pending'`, or review requested and unanswered.
3. **Frío** — `lastActivity` older than **14 days** and none of the above. Candidate to close or delete.

Sorting: **Tu turno** first, then **Esperando a otro** oldest wait first (that is the one to go chase), then **Frío** oldest first.

The distinction that carries the whole feature is *tu turno* vs *esperando a otro*. Age alone is not a priority signal; a three-week wait on someone else's review needs a nudge, not work.

### 7. Shareability

If the panel turns out to be useful, any developer should be able to run their own sidecar against their own machine. That is a constraint on this change, not a later port — retrofitting hardcoded paths is exactly the kind of work that never happens.

What it requires, all already folded into the sections above:

- **No hardcoded paths.** Workspace root and Claude config dir resolve from env vars with sane derivations. No `/Users/sebas` anywhere in the committed code.
- **No assumed repo layout.** Base branch is derived per repo; repo list is discovered, not enumerated. `REPOS_ACTIVE` in `state.js` stays what it is today — a snapshot for the *review queue* pills — and this panel does not read it.
- **No org coupling.** The collector is pure git plus `claude agents`; nothing in it knows about HumandDev.
- **No dependencies and no build step**, matching the rest of the repo. `node serve.js` on a stock Node is the entire setup.
- **Graceful without Claude Code.** Someone who does not use it, or uses it elsewhere, gets worktrees and PRs and no sessions — the panel is still useful.

Deliverable: a README section covering `node serve.js`, the two env vars, the optional launchd install, and the one non-obvious gotcha — **the local origin has its own localStorage, so the PAT and tribe/repo config must be entered once on `localhost:7777`**, separate from whatever is saved on the Pages origin.

The panel self-hiding on Pages is what makes this safe to share: the same `main` serves both audiences, and a teammate who never runs the sidecar sees no change at all.

### Accepted redundancy

A process card and the "Mis PRs" column will both show the same open PR. Accepted for v1: folding "Mis PRs" into the panel is a larger, riskier change, and keeping it means this one is purely additive and can be reverted by deleting one script tag. If the panel proves to be the better view, that merge is a follow-up.

## Testing

The repo has no test suite. This change introduces `node --test` (built into Node, no dependency) covering `collect.js`, which is where the real logic is:

- **State classifier** — a pure function from `(process, now)` to one of the three states. Table-driven cases: changes-requested, unseen comments, failed CI, conflicts, recent own activity, open PR with no review, pending CI, 13-day-old, 15-day-old, and a process with no PR at all.
- **`lastActivity`** — picks the max across the three timestamps, and tolerates any one of them being absent.
- **Ticket extraction and grouping** — `SQSH-1234` and `CSBM-5716` from real branch names; two repos on the same ticket collapse into one process; a branch with no ticket becomes its own process and is marked.
- **Parsers** — `git worktree list --porcelain`, `git status --short`, and `claude agents --json` against captured real fixtures, so the collector is testable without touching the actual disk.
- **Degradation** — a repo whose git command throws produces a `warnings[]` entry and does not abort the run.
- **Path resolution** — `PRQ_WORKSPACE` wins when set; without it the root derives from the checkout location. Guards the shareability constraint against regressing into a hardcoded path.
- **Base branch derivation** — `origin/HEAD` present, absent-with-`develop`, absent-with-`main`, and none-of-them (unpushed count reported unknown, not guessed).

Manual QA for the panel:
1. `serve.js` running → panel renders, processes grouped, states plausible against reality.
2. Kill `serve.js`, open the Pages URL → panel absent, pr-queue identical to today (this is the other-users case).
3. Open with no PAT saved → panel still renders from local data, PR sections empty.
4. A worktree with uncommitted changes and no commits for >14 days → shows as **Frío** with its dirty count.
5. Reload → collapsed/expanded state persists; stale cache paints before the fetch resolves.
