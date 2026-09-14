# pr-queue

Dashboard for the PR review queue (other people's PRs worth reviewing) next to a
**Active work** panel for your own work: PRs grouped by ticket-or-branch, each
card classified by whose turn it is. With a local sidecar running, the same cards
also carry your worktrees and Claude Code sessions.

## The review queue

Static site, no build step. Open the deployed page, paste a GitHub PAT with `repo`
scope, pick your tribe label. Everything is stored in your browser's localStorage.

## The Active work panel

The right-hand column, always on. What it can show depends on what it can read.

**Everything GitHub knows works on the deployed page**, with no sidecar and no
install: your own PRs grouped by ticket (a ticket with a PR in two repos is one
card), the *your move / active / in review / ci running / paused / cold / merged*
state on each, state-then-recency ordering, the `open` / `draft` filter, and the
CI / review / diff badges. All of it is the same code in `classify.js`, which is pure and has no
idea whether a sidecar answered.

**Everything about your filesystem needs the sidecar** below, because it reads your
machine: git worktrees and their dirty/unpushed state, `claude agents --json`, the
`cd` / `push` / `resume` / `prune` chips, and the mission-control cards. **None of
that leaves your machine** — the deployed page has no access to it and never will.

## The sidecar (local only)

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
| `PRQ_PORT` | `7777` | Sidecar port. If it is taken, the sidecar exits with an error rather than picking another — a stable bookmark is the point. Must be an integer between 1 and 65535; anything else and the sidecar exits 1 with a message naming `PRQ_PORT`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its session indexes. |
| `PRQ_MC_BIN` | `$CLAUDE_CONFIG_DIR/mission-control/bin/mc` | The `mc` CLI, if you run one. Its state becomes extra cards in the panel. Not there and not set? No new cards, no new chip — the panel is exactly what it was. Set explicitly and missing, though, is reported as broken: naming a path is saying you expect it to exist. |

The default assumes pr-queue is cloned **next to** the repos it reports on. If yours
live elsewhere: `PRQ_WORKSPACE=~/code node serve.js`.

### Gotchas

- **You have to re-enter your PAT.** `localhost:7777` is a different browser origin
  from the deployed page, so it has its own localStorage. Your token and tribe/repo
  config do not carry over. One-time cost, per origin.
- **Without the sidecar the panel mounts anyway, over an empty local payload.**
  `/api/local` 404s, `window.LOCAL_STATE` becomes `emptyLocalPayload()`, and every
  row comes out of `synthesizeProcesses()` — one card per PR, or per ticket when
  several PRs share one. Nothing branches on "did the sidecar answer": the
  worktree/session/warning segments of a card simply have nothing to iterate. This
  replaced an earlier invariant ("someone who never runs the sidecar sees no change
  at all"), on purpose: the PR-derived half of the panel is better than the flat
  list it used to fall back to, and it costs a teammate nothing to receive.
- **`render.js`'s flat "My PRs" list is now the crash fallback only.** If a panel
  render throws, `unmountPanel()` hands the column back to it rather than leaving it
  blank. It is not reachable any other way.
- **`with PR` / `without PR` hides itself when it cannot partition.** Every row on the
  deployed page has a PR, so "without PR" would always be 0 and "with PR" always
  everything — two chips that can't change the list read as broken, not as
  inapplicable. They go away and `open` / `draft` is promoted to stand alone
  (see `prSplitIsMeaningful`). With a sidecar whose every worktree happens to have
  a PR, the same thing correctly happens.
- **No Claude Code? Still works.** You get worktrees and PRs, with no session rows,
  and a warning in the payload. Every source degrades on its own.
- **Prunable worktrees show no git detail.** Their directory is gone, so `git status`
  cannot run. They are surfaced as cleanup candidates instead.
- **Base-branch checkouts are excluded.** A worktree sitting on its repo's own base
  branch (`develop`/`main`/`master`, or whatever `origin/HEAD` points at) isn't work in
  progress, so it's dropped before grouping. Processes group by branch name, so leaving
  these in would merge every repo's base checkout into a single `main` row.
- **Detached worktrees never attach to a PR.** With no branch there is no join key, so
  they appear as branchless rows rather than being dropped.
- **State means who the row waits on, not how old it is — and there are seven.**
  *Your move* is unanswered review comments, failed CI or conflicts: something demands
  an action from you. *Active* is your own work in the last 48h with nothing demanding —
  split out of *your move* so the red badge keeps meaning "act now" on a machine
  carrying dozens of worktrees. *In review* is an open, non-draft PR nobody has looked
  at; drafts are excluded, because nobody is expected to review a draft and calling one
  "in review" claims a reviewer is blocking work that is still yours. *CI running* is
  the nearest gate when CI has not answered yet, and wins over *in review* while it
  holds. *Paused* is none of those and recent; *cold* is nothing from anyone in 14 days;
  *merged* is work that landed, where the only thing left is the worktree to clean up.
- **`with PR` / `without PR` is a filter with an off state** (when it is shown at all —
  see above). Neither chip selected means
  *all*; clicking the lit chip turns it off, clicking the other one replaces it. The
  chips stay **disabled until GitHub's PR data lands** — until then every card looks
  "without PR", so either chip would hide real work; their counts are blanked rather than
  printed as zeros, same rule the meta line follows. That line keeps reporting totals
  over *every* process, filter or not, and says separately how many are on screen. The
  "Sessions with no worktree" row only appears with the filter off: it isn't a process and
  has no PR to file it under. In a background tab the chips can stay disabled for a
  while: `loadOwnPRs` skips hidden tabs, so PR data only lands once you look at it.
- **`open` / `draft` is a second row, subordinate to `with PR` only while that
  chip exists.** Asking which PR status to keep has no answer for a row with no PR,
  so while the `with PR` row is on screen this one appears when `with PR` lights up and
  its selection is dropped when that chip goes off — a hidden row never keeps
  filtering from behind. When the `with PR` split is hidden as degenerate (the
  deployed page: every row has a PR), this row is unindented, shown unconditionally,
  and its selection is the only filter there is. `open` means open **and not a
  draft**: draft is the
  distinction being drawn, so the two are a split, not a superset. Their counts can sum
  to less than `with PR` (a *merged* row is neither) and can overlap (a multi-repo
  process with a draft in one repo and a ready PR in another is both) — the numbers on
  the chips are what make that legible.
- **Session liveness is not activity.** An open terminal only means a terminal was left
  open. Activity is the newest of: last session message, last commit, last PR update.
- **Transcript file mtime is not last activity, and this bites.** Claude Code appends
  bookkeeping records (`ai-title`, `mode`, `permission-mode`) with no timestamp long
  after the last real message — measured skews of 9 hours and 5 days. Activity comes
  from the last `timestamp` inside the transcript, read from its final 64KB.
- **Sessions started from the workspace root show under "Sesiones sin worktree."**
  Their `cwd` belongs to no worktree, so there is nothing to attach them to. If such a
  session has recorded a `pr-link`, it gets moved into that PR's process automatically.

## Work assistant (opt-in)

A `/work-assistant` skill (Task 4) that digests your own branches/PRs, asks you the
decisions that need a human via one `AskUserQuestion`, then executes your answers
through `assist/bin/run.js` — argv only, never a shell. Neither installer below is
required to use the panel.

- **`./scripts/install-skill.sh`** symlinks the skill into
  `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/work-assistant`, so `/work-assistant` is
  available from any workspace, not just this checkout. `Uninstall: rm` the printed
  symlink path.
- **`./scripts/install-heartbeat-check.sh`** registers a `work` heartbeat check,
  disabled by default, exactly like the `prs` check registers pr-babysit. Its gate is
  the mechanical drain (`assist/bin/run.js`) — no model runs on a clean pass. The drain
  only pushes/prunes/drafts your own branches (reversible actions); it never answers a
  queued question — those always wait for `/work-assistant`. It escalates to a model
  session only when the pass came back degraded (gh unavailable mid-run). `Uninstall:
  rm -rf` the printed check directory.

A caller that dispatches work to agents passes the branches they hold as repeated
`--skip-branch <name>` flags, and no action is derived for those branches — not a
push, not a worktree removal, not a draft PR. The skipped ones are counted and named
in `actions.leasedSkipped`, so a pass that ran nothing because everything was in
flight does not read as a pass with nothing to do. The queue never reads the caller's
lease store; the branch names arrive on the command line.

## Tests

```bash
npm test        # node --test, no dependencies
```
