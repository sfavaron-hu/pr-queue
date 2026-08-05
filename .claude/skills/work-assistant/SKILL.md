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

Pick up the reversible actions the gate now emits (a freshly-committed branch to push, a merged worktree to remove, a stale worktree to prune) and apply any `Dejar` declines:

```bash
node "$ROOT/assist/bin/run.js"        # drain: push/prune/remove via argv, sync questions, apply declines, prune
```

The drain **does not open draft PRs** — it only pushes the branch so it is ready. It reports `draftsPending` (how many branches are waiting for a PR). If it exits **4**, `gh` was degraded this pass — say so and do not treat a clean-looking result as trustworthy.

## 5. Open the pending draft PRs — well-formatted, one by one

The drain leaves draft-PR creation to you (a model) so the body is written properly, not filled from commit subjects. List what is pending:

```bash
node "$ROOT/assist/bin/run.js" drafts   # [{ id, githubRepo, head, base, repo, why, evidence }]
```

For each entry, write a **well-formatted** draft PR:

1. Gather the branch's real changes — the commits and the diff against its base:
   ```bash
   gh api "repos/<githubRepo>/compare/<base>...<head>" --jq '.commits[].commit.message'
   ```
   (or `git -C <worktree> log --oneline <base>..<head>` if you have the worktree path from the ledger).
2. Compose a title and a Markdown body: a one-line summary, a "## Qué cambia" section grouping the commits, and a "## Notas" line if the branch has no ticket. Spanish, casual, lead with what changed. Do **not** use `--fill`.
3. Open it as a **draft** (never ready-for-review), letting me see it before it exists:
   ```bash
   gh pr create --draft -R <githubRepo> --head <head> --base <base> \
     --title "<title>" --body "<body>"
   ```

Open one at a time and show me each URL. If a branch's changes are unclear or look like they belong in another PR, ask me instead of guessing. These are draft PRs on my own branches — inside the blast radius — but a ready-for-review or a merge is never yours to do.

## 6. Close out

One short summary: what I answered, what got pushed/drafted/archived, what a subagent picked up (with its handle), and anything left open. End there — no menu.
