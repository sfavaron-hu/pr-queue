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
| `PRQ_PORT` | `7777` | Sidecar port. If it is taken, the sidecar exits with an error rather than picking another — a stable bookmark is the point. Must be an integer between 1 and 65535; anything else and the sidecar exits 1 with a message naming `PRQ_PORT`. |
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
- **Base-branch checkouts are excluded.** A worktree sitting on its repo's own base
  branch (`develop`/`main`/`master`, or whatever `origin/HEAD` points at) isn't work in
  progress, so it's dropped before grouping. Processes group by branch name, so leaving
  these in would merge every repo's base checkout into a single `main` row.
- **Detached worktrees never attach to a PR.** With no branch there is no join key, so
  they appear as branchless rows rather than being dropped.
- **State means turns, not age — and there are four of them.** *Tu turno* is unanswered
  review comments, failed CI, conflicts or your own recent work. *Esperando* is an
  unreviewed PR or CI in flight — not your move, however old. *En pausa* is neither:
  typically no PR yet, just a worktree that was set down — calling it "esperando" would
  claim someone is blocking work when no one is. *Frío* is nothing from anyone in 14 days.
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
