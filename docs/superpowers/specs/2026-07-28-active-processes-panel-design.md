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
| `~/.claude/projects/*/<sessionId>.jsonl` (tail) | real last activity, last `cwd`, and `pr-link` records |
| `git worktree list --porcelain` per repo | worktree path + branch, plus `prunable` / `detached` markers |
| `git log -1 --format=%ct` per worktree | last commit timestamp |
| `git status --short` per worktree | dirty file count |
| `git log origin/<base>..HEAD --oneline` per worktree | unpushed commit count |

#### Session data: three corrections found by probing the real files

The obvious implementation of this section is wrong in three ways. Each was measured, not reasoned about.

**`sessions-index.json` does not contain active sessions.** Of the 14 live sessions, **0 resolved** — the index is written for closed/historical sessions. The usable source is the transcript itself: build a `sessionId → path` map by scanning `<claudeDir>/projects/*/*.jsonl` (1271 files in this workspace, one `readdir` per project dir) and look sessions up there.

**File mtime is not last activity.** Bookkeeping records (`ai-title`, `mode`, `permission-mode`) are appended without a `timestamp` and bump mtime long after real work stopped. Measured: one session's mtime read `23:26` while its last real record was `13:52` — a **9-hour** skew; another showed a **5-day** skew (mtime 07-28, last message 07-23). Using mtime would paint stale sessions as active, which is precisely the failure this panel exists to prevent. Activity is the **maximum `timestamp` across transcript records**, found by reading the **last 64KB** of the file and scanning backwards. Cost: **5ms for 8 sessions** — negligible. Sessions with no transcript at all (observed: one background agent) fall back to `startedAt`.

**A session's `cwd` is often the workspace root, not a worktree.** So `cwd` alone cannot attach a session to a process, and the transcript's `gitBranch` field is worse than useless — it reports the branch of wherever the session started, which for root-cwd sessions is the workspace repo's own `main`. Join priority:

1. **`pr-link` records** — `{ type: 'pr-link', sessionId, prNumber, prUrl, prRepository, timestamp }`. A direct, unambiguous session→PR association recorded by Claude Code itself.
2. **`cwd` matching a known worktree path** — resolved against the worktree list, which yields the branch and therefore the ticket.
3. **Neither** — the session is *unattached*. It goes in an explicit "sesiones sueltas" group. It must never be keyed by its `cwd`, or every root-cwd session collapses into one meaningless process.

`pr-link` also removes the label-scope limitation described in §5: a process can show its PR number and URL from local data alone, whether or not GitHub returned that PR.

#### Base-branch checkouts are not processes

A worktree sitting on its repo's own base branch is excluded. It is not work in progress, and because processes group by branch name, including them is worse than noise: every repo whose main checkout sits on `main` collapses into a **single** process named `main`, merging unrelated repos into one row. Observed live before the fix: one `main` row spanning `eslint-plugin-suggest-hugo-components`, `hu-rooms`, `humand-janus` and `material-hu`, plus a matching `develop` row. That is not merely untidy, it is misleading.

The base branch is already derived per repo for the unpushed count, so the data is on hand. Two cases are deliberately kept: a **detached** worktree (no branch, so it cannot be a base-branch checkout) and any worktree in a repo whose base branch **could not be derived** — with no base to compare against, dropping work would be worse than showing it.

#### Worktree layouts

Both conventions are in use here — siblings of the repo (`humand-web--SQSH-3851-…`) and nested inside it (`humand-web/.worktrees/chore/SQSH-3239-…`). `git worktree list` reports both, so discovery needs no special handling; **path-prefix assumptions about where a worktree lives would break**, and nothing may rely on them.

Two real cases the porcelain parser must handle, found while measuring — the current workspace has **110 worktrees, 3 prunable and 12 detached**:

- **`prunable`** — the worktree's gitdir points at a location that no longer exists. Its directory is gone, so `status`/`log` would fail; it is reported with a `prunable` flag and no git detail. These are the clearest cleanup candidates the panel can surface.
- **`detached`** — no `branch` line at all. With no branch there is no join key, so these appear as branchless worktrees that never attach to a PR, marked as such rather than silently dropped.

Measured cost (23 repos, 91 worktrees, warm FS): `claude agents` 0.76s, reading 99 index files (52K) 0.03s, `worktree list` 0.29s, `git log -1` 1.12s, `git status` 2.75s — **~5s serial**. Repos are walked concurrently, which puts the target at ~1.5–2s. `git status` is more than half the budget; if it ever becomes the bottleneck it is the first thing to make optional, since dirty-state is the least essential field.

Repo discovery: **main checkouts** directly under the workspace root — a directory whose `.git` is itself a **directory**. This distinction is not cosmetic: a linked worktree's `.git` is a *file*, so treating "contains `.git`" as "is a repo" discovers every sibling worktree as its own repo, and `git worktree list` run from each one re-reports that repo's entire worktree set. Measured on this machine: **73 worktree rows for 38 distinct paths, one path repeated 4×**, with `dirty` and `unpushed` counts multiplied accordingly. The collector additionally de-duplicates by worktree path as a backstop.

The root is resolved in this order, with **no hardcoded path anywhere** (see *Shareability*):

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

`loadOwnPRs` scopes its search by `label:<tribu>`, so a PR without the tribe label will not join from the GitHub side. This is largely covered by the `pr-link` records described in §1: the process still shows its PR number and URL from local data, just without live CI/review state. A process with neither a labeled PR nor a `pr-link` appears with no PR detail at all, which is correct — the panel's spine is local data. Adding an unlabeled own-PR query stays a follow-up.

### 6. Activity and state classification

**Session liveness is deliberately not used as the activity signal.** An open terminal means only that a terminal was left open — sometimes for weeks, waiting on an external blocker — and a closed one means nothing at all, since finished sessions are closed without a trace. Sessions are an *attachment* to a process (with a resume command), never evidence that it is moving.

```
lastActivity = max(last transcript timestamp, last commit, PR updatedAt)
```

Explicitly **not** the transcript's file mtime — see §1, where that was measured skewing by up to 5 days.

Four states, evaluated in order:

1. **Tu turno** — `changesReq`, or unseen comments/reviews (`newComments`/`newChanges` > 0), or `ci === 'failed'`, or `conflicts`, or own activity within 48h.
2. **Esperando a otro** — PR open with no human review yet, or `ci === 'pending'`, or review requested and unanswered.
3. **En pausa** — none of the above, and last activity within **14 days**. Typically a process with no PR yet that was simply set down. Not your move, but nobody is blocking it either.
4. **Frío** — `lastActivity` older than **14 days**, or unknown. Candidate to close or delete.

*En pausa* exists because the obvious three-state model has no honest home for a process with no PR that was last touched five days ago: it is not your turn, and calling it "esperando a otro" claims someone is blocking it when no one is. With 110 worktrees that bucket is large, and a label that lies about it makes the whole panel less trustworthy.

Sorting: **Tu turno** first, then **Esperando a otro** oldest wait first (that is the one to go chase), then **En pausa**, then **Frío**, each oldest first.

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

### 8. Recall and actionability (follow-up increment)

Using the finished panel surfaced two gaps that only appear once you look at 28 real rows.

**A ticket number is not a memory.** `SQSH-3954` tells you nothing about what it was. Each row gets a **context subtitle**: the first available of the PR title, the session's `aiTitle`, or the last commit's subject. All three are free — `enrichOwnPR` already returns `title`; Claude Code writes an `aiTitle` record into the transcript tail this collector already reads (observed: *"Review GitHub pull request 133 adversarially"*, *"E2E test coverage mapping for multiple modules"*); and `git log -1` already runs, so `--format=%ct%x00%s` adds a subject at no cost.

**Rows with neither a session nor a PR had nothing to act on.** Every row now ends in an actionable chain, first applicable wins but several can show at once:

1. the PR link, when one joined
2. otherwise a **GitHub compare link** — `https://github.com/<owner>/<repo>/compare/<base>...<branch>` — which needs `owner/repo` parsed from `git remote get-url origin` (one call per repo, ~16 here) and the base branch already derived for the unpushed count. This doubles as the shortcut to *open* the PR, since GitHub's compare page carries the create-PR button.
3. `claude --resume <id>` when a session is attached
4. a copy-able `cd <path>` for the worktree

Degenerate cases get the actionable that actually applies: a **prunable** worktree has no directory to `cd` into, so it offers `git worktree prune` instead; a **detached** worktree has no branch, so it gets no compare link.

Row shape becomes three lines: identity, context subtitle, actionables. `localhost` is a secure context, so click-to-copy via `navigator.clipboard` works for the command chips.

### Accepted redundancy

A process card and the "Mis PRs" column will both show the same open PR. Accepted for v1: folding "Mis PRs" into the panel is a larger, riskier change, and keeping it means this one is purely additive and can be reverted by deleting one script tag. If the panel proves to be the better view, that merge is a follow-up.

## Testing

The repo has no test suite. This change introduces `node --test` (built into Node, no dependency) covering `collect.js`, which is where the real logic is:

- **State classifier** — a pure function from `(process, prs, now)` to one of the four states. Table-driven cases: changes-requested, unseen comments, failed CI, conflicts, recent own activity, open PR with no review, pending CI, 13-day-old with no PR (*en pausa*), 15-day-old (*frío*), and a process with no PR and no known activity.
- **`lastActivity`** — picks the max across the three timestamps, and tolerates any one of them being absent.
- **Ticket extraction and grouping** — `SQSH-1234` and `CSBM-5716` from real branch names; two repos on the same ticket collapse into one process; a branch with no ticket becomes its own process and is marked.
- **Session attachment** — a session with a `pr-link` attaches via that PR; one whose `cwd` matches a worktree attaches via that branch; one with a root `cwd` and no `pr-link` lands in "sesiones sueltas" rather than forming a process keyed by its `cwd`. This last case is the regression that would quietly ruin the panel, and it is the reason this test exists.
- **Transcript activity** — the last `timestamp` wins over the file mtime, trailing records without a `timestamp` are skipped, and a session with no transcript falls back to `startedAt`.
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
