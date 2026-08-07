---
name: work-assistant
description: Use when the owner runs /work-assistant — review what the unattended assistant did on my own branches/PRs, answer the queued decisions in one pass, and execute what that unblocks. Local disk + my own origin branches + draft PRs only.
---

# Work assistant (on demand)

The deterministic half already ran (see `assist/gate.js`, `assist/queue.js`): reversible actions on my own branches are drained mechanically by the heartbeat, and the decisions that need me are sitting as files in the queue. Your job is the *interactive* pass: show what happened, ask me the open questions **once**, write my answers, and run what that unblocks.

**Blast radius — do not exceed it:** local disk, my own branches on origin, and **draft** PRs. Never ready-for-review, never merge, never reply to review comments (that is `pr-babysit`). Never `git commit --force`, never `git worktree remove --force`, never `git push --force`.

## 0. Locate the checkout

The skill is symlinked into the config dir; the pr-queue checkout is where its real path lives.

```bash
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SKILL_REAL="$(readlink -f "$CFG/skills/work-assistant" 2>/dev/null || echo "$CFG/skills/work-assistant")"
ROOT="$(cd "$SKILL_REAL/../../.." && pwd)"   # <checkout>/.claude/skills/work-assistant → <checkout>
```

Run every `run.js` command below as `node "$ROOT/assist/bin/run.js" …`.

## 1. Show the digest

```bash
ls -t "$ROOT/state/assist/done" 2>/dev/null | head -20   # what got resolved while I was away
node "$ROOT/assist/bin/run.js" list                       # every open item: [{id, item, answered}]
```

Summarize in two or three lines: what the drain pushed / pruned / switched, and how many decisions are open. Keep it readable while tired.

**Correct the framing if the queue is misleading.** Several items are often one recurring cause, not several problems — the most common being branches whose PR already merged or was closed. Say that out loud rather than presenting them as N independent decisions.

## 2. Ask the open questions — ONE call

```bash
node "$ROOT/assist/bin/run.js" ask     # the budgeted batch: [{id, item}], gate order, answered ones dropped
```

`ask` is the authority on **which** questions and **how many**. Do not re-derive the batch from `list` and do not cap it yourself: `list` is a directory read with no ordering, so "the top 4" from it is arbitrary, and the budget must stay in one place (it is the whole defence against approval fatigue).

Each `item` already validates as `AskUserQuestion` input — 2–4 `options`, each with a `label` and an evidence-carrying `description`, `header ≤ 12`, trailing `?`. **Pass them through unchanged**, in one call. If `ask` returns `[]`, skip to step 4.

**The one allowed second call:** if I reply asking for context instead of choosing ("this name tells me nothing", "depends what those changes are"), that is not a decision — go get the evidence, show it, and ask again. Preserve the original `label` strings so `answer --value` still validates. Anything else — reformulating, splitting, confirming — is a loop, and the ceiling exists to prevent it.

## 3. Write each answer, then act on it

```bash
node "$ROOT/assist/bin/run.js" answer <id> --value "<the label I chose>"
node "$ROOT/assist/bin/run.js" answer <id> --other "<what I typed>"   # if I picked Other
```

A rejected write tells you why; handle each differently rather than retrying:

| `reason` | What it means | What to do |
|---|---|---|
| `already-done` | Resolved before the answer landed | Tell me it was already handled; do not redo it |
| `declined` | Currently suppressed for 30 days | Nothing; say so |
| `no-item` | The id never existed | Re-run `ask` — do not guess an id |
| `bad-value` | Not one of that item's labels | Use a label verbatim, or `--other` |

Then resolve by the value:

- **Dejar** → nothing by hand; the next drain records the 30-day decline.
- **Retomar** (or an "Other" meaning "continue this"): read the idle session's transcript to see where it stopped (`processKey` maps to the ledger). **Start the work in a subagent** via the Task tool. **Never** `claude --resume` my interactive session: it can't be audited or parallelised. Then `run.js done <id> --resolution "retomado en subagente: <1-line>"`.
- **Archivar** → `git -C <repo> worktree remove <path>`; the branch stays on origin. First confirm `git -C <path> status --porcelain` is empty. If the only untracked entry is a `node_modules` **symlink** into another checkout, delete the symlink (`rm <path>/node_modules` — this never touches the target) and remove cleanly. **Never reach for `--force`.** If there is real uncommitted work, do not remove: tell me and leave the item open.
- **Ir a la base** → the process is the repo's **main working tree**, which cannot be removed (`git worktree remove` on it exits 128). `git -C <path> switch <baseBranch>` instead. Two traps: the repo may not have the branch you assume (check `git branch -a` — several here have only `main`, no `develop`), and `git branch -d` refuses an unmerged branch. Delete the local branch only after confirming `git rev-list --count origin/<base>..<branch>` is `0`, or that its commits are on origin. Say which you did.
- **Commitear** → commit the uncommitted changes, then let the next drain push. But **read the diff first**: the question tells you which files changed, and a single modified file is as likely to be a local-testing hack (`// TEMP — DO NOT COMMIT`, a forced feature flag) as real work. If it looks like a deliberate local override, do not commit it — say what it is and leave the item open.
- **Nuevo PR** (the `Huérfano` question — the PR already landed or was closed, but the worktree still holds local work): first show me the content so I can judge — `git -C <path> log --oneline <base>..HEAD` and `git -C <path> diff --stat <base>..HEAD`. Then open it as a fresh **draft** PR with a model-authored body, exactly as in step 5 (never `--fill`). If the branch's commits turn out to already be in the merged PR (a squash re-listing them), say so and offer `Descartar` instead of opening a duplicate.
- **Descartar** → **destructive, interactive-only, never from the drain.** It abandons the worktree *and* the local branch (a plain `worktree remove` leaves the commits on the branch ref, so the branch is deleted too). Before touching anything: show me exactly what is lost — `git -C <path> log --oneline <base>..HEAD` for the commits, `git -C <path> status --porcelain` for uncommitted — and confirm they are genuinely not on any remote (`git -C <path> log --oneline @{u}..HEAD` should be non-empty / no upstream). Get my explicit go-ahead in this turn. Only then: `git -C <repo> worktree remove --force <path>` then `git -C <repo> branch -D <branch>`. If the branch is on origin, that copy survives; if not, this is irreversible — if anything about "not in remote" is uncertain, stop and ask rather than delete.

`run.js done <id> --resolution "<what happened>"` after each. Write the resolution for someone reading `done/` in three weeks: name the repo, the PR number, and any surprise (`"era el checkout principal, no un worktree"`).

## 4. Run the mechanical drain

```bash
node "$ROOT/assist/bin/run.js"    # push/prune/remove/switch via argv, sync questions, apply declines, prune
```

Exit codes:

| Exit | Meaning |
|---|---|
| `0` | Nothing waiting |
| `10` | Work surfaced — normal when questions are open |
| `4` | **`gh` was degraded this pass.** Say so, and do not treat a clean-looking result as trustworthy: every "this branch has no PR" conclusion is unreliable, so no worktree was touched |
| `3` | The executor itself failed |

Read `actions.results` even on a success exit — the drain isolates failures, so `ran: 2, failed: 2` is a normal-looking shape that means nothing worked. Report a non-zero `code` per action rather than summarizing the pass as clean. `questions.deferred` counts items persisted but not asked this pass; that is by design, not a drop.

## 5. Open the pending draft PRs — well-formatted, one by one

```bash
node "$ROOT/assist/bin/run.js" drafts   # [{ id, githubRepo, head, base, repo, why, evidence }]
```

**Vet every entry before opening anything.** On the first real run, three of four "pending drafts" should not have existed. The gate now catches merged and closed PRs on the same branch, but not work that landed from a *different* branch — so check, per entry:

```bash
gh pr list -R <githubRepo> --head <head> --state all --json number,state,url
git -C <repo> rev-list --count <head>..origin/<head>    # >0 → the local worktree is BEHIND origin
git -C <repo> diff --stat origin/<base>...origin/<head> # three-dot: what GitHub will actually render
```

Skip and tell me, rather than opening, when: a PR already exists in any state; the same change is already open from another branch (compare the touched files, not the branch name); or the three-dot diff is empty.

If local and origin disagree, **origin wins** — `gh pr create --head` resolves the remote ref, so the PR is correct, but never `git push` the stale local to "fix" it.

Then, for each surviving entry:

1. Read the branch's real changes — `gh api "repos/<githubRepo>/compare/<base>...<head>" --jq '.commits[].commit.message'` plus the three-dot diff above. Read the actual diff of the substantive files, not only the commit subjects.
2. Compose a title and a Markdown body: lead with what was broken and why, then a "## Qué cambia" section grouping the real changes, then "## Notas" for anything a reviewer needs (no ticket, branch far behind base, a deferred decision). Spanish, casual. Do **not** use `--fill`.
3. Open it as a **draft**, via `--body-file` so the body survives verbatim:
   ```bash
   gh pr create --draft -R <githubRepo> --head <head> --base <base> \
     --title "<title>" --body-file <path>
   ```

Open one at a time and show me each URL. If a branch's changes are unclear or look like they belong in another PR, ask me instead of guessing. A ready-for-review or a merge is never yours to do.

## 6. Close out

One short summary: what I answered, what got pushed / switched / archived / drafted, what a subagent picked up (with its handle), and anything left open. Name anything you deliberately did **not** do and why. End there — no menu.
