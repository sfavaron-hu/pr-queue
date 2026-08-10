# Work assistant

## Problem

The active-processes panel put local work state and PR state in one place for the first time: 27–29 processes, each carrying its worktrees, Claude Code sessions and PRs, classified by whose turn it is. That join is currently only useful to a human looking at a browser tab.

The same data would let an agent advance the work that needs no decision from the owner, and ask — once, in one place, with evidence — about the work that does. Snapshot from the real payload while writing this spec:

| | count |
|---|---|
| processes | 27 |
| with commits above base | 24 |
| branch genuinely absent from origin | 5 |
| worktree with uncommitted changes | 10 |
| no ticket | 19 |
| nothing from anyone in >14 days | 10 |
| Claude Code sessions attached (8 idle, 2 busy, 1 waiting) | 11 |

Two things are missing for an agent to act on this:

1. **The join lives in the browser.** `/api/local` is local-only by design and carries no GitHub data at all; `local.js` joins it against `state.ownPRs` at render time. Outside the browser there is no joined view.
2. **Nothing separates "safe to do now" from "needs a human".** The panel renders a state per process; it does not say which actions are mechanical and which are decisions.

`pr-babysit` already owns the PR side (review comments, conflicts, CI, merge). The unattended blind spot is everything *before* the PR — exactly the local half this panel collects.

### What the field already settled, and where we differ

Researched before designing (sources at the end). Three findings shaped this spec:

- **The inbox is the consensus interface.** LangChain's Agent Inbox types human-in-the-loop items three ways — `notify`, `question`, `review` — rather than treating everything as a question. Adopted in §2.2.
- **Autonomy is graded by reversibility**, and *reversibility is a property of the environment, not of the operation*. `git push` of an unconsumed branch is reversible; the same push once someone has pulled it, or once CI deploys from it, is not. Adopted in §2.1.
- **Batching every question into one pass is the documented antipattern** (*approval fatigue*): when a queue accumulates, humans batch-approve to drain it and oversight collapses into rubber-stamping. The remedy is fewer approvals, not tidier ones — reserve them for genuinely risky actions, expand bounded autonomy, and **review coherent units of work (a finished PR) rather than individual actions**. Adopted as the question budget in §2.2 and as "the review unit is the draft PR" in §2.1.

No existing tool does the whole thing. Composio's Agent Orchestrator is the closest (worktree per session, supervises sessions/branches/PRs, routes CI failures and review comments back to the right session) and has no question queue for blocked work. That queue is the differentiated part, and it is what §4 specifies.

## Non-goals

- **Anything that reaches a human or a remote system of record.** No Jira tickets, no Slack, no ready-for-review, no merge, no review comments (that is `pr-babysit`). The blast radius of v1 is exactly: local disk, the owner's own branches on origin, and PRs in draft.
- **Closing or cleaning cold work autonomously.** Cold and ticketless processes are question material, never actions.
- **Absorbing `pr-babysit`.** It is integrated by aggregation (§2.3), not rewritten.
- **Writes from the browser beyond an answer value.** The sidecar stays a reader plus, later, one answer endpoint (§6).
- **Changing anything for a pr-queue user who never opts in.** Without the two installers the repo behaves exactly as it does today.

## Design

Four components with contracts between them, so each is usable alone: the UI consumes C1, the heartbeat consumes C2, the future browser endpoint writes C3, and only C4 contains a model.

```
              C1 ledger            C2 gate              C3 queue           C4 executor
 workspace ─▶ local + PR   ─────▶  actions[] + items[] ─▶ files  ──────────▶ run / dispatch
   + gh       (pure join)          (pure, no model)      (append-only)      (the only model)
                  │                      │                  ▲                    │
                  └── browser panel      └── heartbeat gate  └── /api/answer     └── subagents
```

### 1. `assist/ledger.js` — one joined view (C1)

Node, no dependencies, no side effects. Output is a document on stdout, same discipline as `collect.js`.

**The join stops being browser-only.** Three pure functions move from `local.js` to `classify.js` (already dual browser/Node): `attachOwnPRs`, `synthesizeProcesses`, `prTicket` (~60 lines). `local.js` keeps only rendering. There is then one join implementation with two consumers, which is the point.

**The one unavoidable duplication is the fetch**, not the join: the browser uses the PAT in `github.js`, the assistant uses `gh` in `assist/prs.js`. They are held together by a contract — both emit the same `pr` shape:

```
{ owner, repo, number, title, url, headRef, draft, merged,
  ci: 'green'|'failed'|'pending'|'unknown', approved, changesReq, conflicts,
  newComments, humanReviews, updatedAt }
```

A test asserts both producers agree on that field set. `assist/prs.js` deliberately does **not** inherit `render.js`'s `org:` qualifier (`render.js:272`), which is why pr-queue's own PR #1 renders as "sin PR" in the panel today: the assistant queries `--author=@me` across every org.

Output:

```
{ version, generatedAt, workspaceRoot,
  processes: [ { ...process, prs: [...], state, flags } ],
  looseSessions, warnings }
```

`state` comes from the existing `classify()`. `flags` are the derived booleans the gate reads: `needsPush`, `notOnOrigin`, `consumedByOthers`, `mergedWithLiveWorktree`, `dirty`, `cold`, `noTicket`, `sessionIdle`, `hasDraftPR`, `hasOpenPR`.

`gh` unavailable or failing is a `warnings` entry and a degraded exit — never an empty `prs` that reads as "no PRs".

### 2. `assist/gate.js` — the deterministic half (C2)

Pure function of the ledger; no model, no network beyond what C1 already did. This is `pr-babysit`'s most load-bearing rule applied here: anything mechanical — a comparison, a dedup, a skip decision — belongs in the script, never in a prompt.

Exit codes are the heartbeat's contract verbatim:

| Exit | Meaning |
|---|---|
| `0` | looked, nothing to do |
| `10` | actions and/or items found |
| `4` | degraded — `gh` failed, so the PR half is unknown and a clean result is not trustworthy |
| `3` | could not check at all |
| `5` | a sibling run holds the lock |

`0` never means "I did not look".

#### 2.1 `actions[]` — mechanical and reversible *now*

Each action: `{ id, kind, processKey, repo, cmd, reversibility, why, evidence }`.

| kind | condition | reversibility |
|---|---|---|
| `push` | `notOnOrigin` and **not** `consumedByOthers` | reversible while unconsumed |
| `open-draft-pr` | branch on origin, commits above base, no PR, **worktree clean** | draft — no human is notified |
| `prune-worktree` | worktree directory gone | reversible (metadata only) |
| `remove-merged-worktree` | every PR on the process merged, directory present, **worktree clean** | reversible: the branch stays on origin, only local state goes |

`consumedByOthers` is the environment caveat made concrete: a branch that any PR references, or that has a remote ref someone else could have pulled, is no longer a candidate for an autonomous push. Reversibility is re-evaluated every pass, never cached.

**A dirty worktree is never resolved autonomously**, in either direction: committing on the owner's behalf is a decision, and `git worktree remove` on uncommitted changes is data loss (git refuses it, and that refusal is a safety net worth keeping rather than routing around with `--force`). So a dirty worktree suppresses `open-draft-pr` and `remove-merged-worktree` and emits a `question` instead — which is the entire treatment of the 10 dirty worktrees in the snapshot.

**Naming trap for the implementer:** the collector's `unpushed` field is *commits above base* (`origin/<base>..HEAD`), not "commits not pushed". That is why 24 of 27 processes report a non-zero value — most of them are pushed. `push` therefore keys off `onOrigin === false`, never off `unpushed > 0`; a squash-merged branch makes the count arithmetically correct and completely misleading.

**The review unit is the draft PR, not the decision.** The 24 processes with commits above base do not produce 24 questions; they produce pushes plus draft PRs, and the thing the owner reviews is the PR — in the panel that already exists. That is where most of the question volume disappears.

#### 2.2 `items[]` — typed, budgeted, renderable

| type | meaning | needs an answer? |
|---|---|---|
| `notify` | something happened worth knowing | no |
| `question` | the assistant cannot proceed without a decision | yes, blocking |
| `review` | work done in draft, awaiting approve/edit/reject | yes, non-blocking |

**The budget is 4 questions per pass**, and the number is not arbitrary: the skill presents them with the `AskUserQuestion` tool, which accepts **1–4 questions in one call**. One pass is therefore literally one call — the owner's "all the questions in one go" — with the tool's own ceiling as the defence against approval fatigue. Over-budget questions are **not emitted**; they are re-derived next pass if still true. The queue is not a backlog to drain.

Ordering is by how much a question unblocks: number of downstream actions gated on it, then recency.

Because the items are rendered by `AskUserQuestion`, the gate is responsible for emitting only renderable ones, and a test enforces it:

- 2–4 `options`, each with a `label` and a `description` carrying the evidence
- `header` ≤ 12 characters
- `question` text ends with `?`
- no cross-item dependencies — batched questions must be independent by construction, or the answer to one invalidates another

Worked example, the shape a cold process produces:

```
question: "fix/no-ticket-tiptap-v3 no se toca hace 23 días. ¿Qué hago?"
header:   "Frío"
options:  Retomar    — "9 commits sobre base, rama en origin, sin PR. Abro draft y sigo."
          Dejar      — "No pregunto de nuevo por 30 días."
          Archivar   — "git worktree remove. El branch queda en origin."
```

Without the evidence in the descriptions the question is unanswerable, and that is where most of the value is.

#### 2.3 `pr-babysit` by aggregation

If `~/.claude/skills/pr-babysit/state/` exists, the gate reads `pending-comments.txt`, `pending-conflicts.txt` and `needs-human-*` and emits them as `notify` items so there is one place to look. It never acts on them and never claims they are handled. Absent that directory, nothing changes. No behaviour of `pr-babysit` is duplicated or replaced.

### 3. `assist/queue.js` — the file protocol (C3)

`state/assist/` (gitignored), Maildir-style atomic delivery: write to `tmp/`, `rename()` into place, so nothing is ever read half-written.

```
state/assist/
  items/<id>.json       # written by the gate, never mutated
  answers/<id>.json     # written by the skill (or later /api/answer)
  done/<id>.json        # moved here after the executor acts; retained 30 days
  declined/<id>.json    # { until } — a "leave it" that has to stick
```

**Ids are content-addressed**: `sha256(type + processKey + subjectKind + evidenceFingerprint)`, truncated. Re-deriving the same question yields the same id, so it is not duplicated — the problem `pr-babysit` paid for with its `seen-*` files. A *changed* situation produces a different fingerprint and therefore legitimately asks again.

**`declined` persists, and this is not optional.** A cold process answered "leave it" that gets re-asked on the next 20-minute tick is a fatigue machine. Default TTL 30 days, carried in the file.

**`done/` is kept rather than deleted.** TASKS.md deletes completed tasks because git holds the history; `state/` is gitignored, so deletion would lose the record of what the assistant did while the owner was away — which is exactly the digest.

**Answers accept two shapes.** `{ value }` must be one of the item's declared options. `{ other: "<free text>" }` is accepted only from the skill, because `AskUserQuestion` always offers "Other" and a human typing a sentence is a legitimate answer for a model to interpret. The future browser endpoint accepts `{ value }` only (§6).

### 4. `.claude/skills/work-assistant/` — the executor (C4)

The only component containing a model. Two entry points, one executor.

**Unattended (heartbeat).** An opt-in check whose `check.json` points at this repo, exactly as the `prs` check points at `~/.claude/skills/pr-babysit`. Per tick: run the gate; run the reversible actions; write the items. Escalate a model session **only** when something needs a model — writing a draft PR description, or diagnosing an idle session. Leave a digest.

**On demand (`/work-assistant`).** Show the digest of what happened unattended, then present the unanswered questions with **one `AskUserQuestion` call** (≤4 questions, evidence in the option descriptions), write the answers to the queue, and execute what that unblocked. Answering is decoupled from executing: the answer is a file, and the executor reads files.

**Idle sessions**: read the transcript to understand where it stopped, then start the work in a **subagent** — never `claude --resume` of the owner's interactive session, which cannot be audited or parallelised. The session's `aiTitle` and `resumeCmd` stay as context and as an escape hatch for the human.

Mechanical actions run through `assist/bin/run.js <action-id>`, a plain shell path with no model, so the unattended majority costs no tokens.

### 5. Packaging

Everything ships inside pr-queue. A teammate clones one repo — no dependencies, no build step — and gets the UI; the assistant is opt-in via two installers that derive their paths and print their own uninstall, mirroring `scripts/install-launchd.sh`:

- `scripts/install-skill.sh` — symlinks `.claude/skills/work-assistant` into `~/.claude/skills/`, so the command is available from any workspace, not only with pr-queue as cwd.
- `scripts/install-heartbeat-check.sh` — creates `~/.claude/heartbeat/checks/work/` with a `check.json` pointing at this checkout and a `gate.sh` that shells to `assist/bin/gate.js`.

Neither installer is required to use the panel, and `shareability.test.js` already fails the build if a hardcoded home directory appears in any of it.

### 6. The UI later, with no redesign

The sidecar gains exactly one write endpoint, `POST /api/answer { id, value }`:

- `value` must be one of the options declared in `items/<id>.json` — enum only, no free text, so **no command string can ever originate in the browser**
- reject unless `Origin`/`Sec-Fetch-Site` say same-origin, plus a token read from a local file

This matters more than it looks: any page the owner visits can POST to `localhost:7777` without a preflight, and that origin holds their PAT in `localStorage`. With an enum-only answer endpoint, the worst a hostile page achieves is answering one of the owner's own questions. Execution stays with the single executor; the browser never launches a process.

Out of scope for v1. The file protocol is what makes it a small addition rather than a rewrite.

### 7. Order of work

Four increments, each verifiable on its own, deliberately putting the protocol before the orchestrator: the interactive skill is the *last* thing built, so it is a client of the queue rather than the place the protocol lives. That is what keeps the eventual UI from being a rewrite.

1. **C1** — move the three join functions into `classify.js`, add `assist/prs.js` and `assist/ledger.js`. Verifiable: the panel behaves identically (existing tests unchanged) and `assist/bin/ledger.js` prints a joined document with PR state outside the browser.
2. **C3 then C2** — the queue protocol, then the gate that writes into it. Verifiable with no model at all: run the gate and read the files it produced, including a second run that adds nothing because the ids match.
3. **C4** — the skill: digest, one `AskUserQuestion` call, `assist/bin/run.js` for mechanical actions, subagent dispatch for the rest.
4. **Heartbeat check** — `scripts/install-heartbeat-check.sh`, gated so a quiet pass costs no session.

## Testing

`node --test`, no dependencies, consistent with the repo.

| Unit | Covers |
|---|---|
| gate | table-driven over synthetic ledgers: each action kind's precondition, and that a **consumed** branch never produces a `push` |
| gate | question budget caps at 4; over-budget questions are absent, not hidden |
| gate | every emitted question validates against the `AskUserQuestion` schema (option count, header length, trailing `?`) |
| gate | exit codes, including `4` when `gh` fails and `0` never standing in for "did not look" |
| queue | atomic write via rename; a truncated `tmp/` file is never read |
| queue | same situation ⇒ same id (no duplicate); changed evidence ⇒ new id (asks again) |
| queue | `declined` suppresses re-asking until `until`, then stops suppressing |
| queue | an answer outside the declared options is rejected |
| contract | `assist/prs.js` and `github.js` agree on the `pr` field set |
| join | the functions moved out of `local.js` behave identically from Node (existing panel tests keep passing unchanged) |

## Deferred

- `POST /api/answer` and answering from the panel (§6).
- Absorbing the PR side from `pr-babysit` rather than aggregating it.
- Autonomous cleanup of cold work.
- A second writer (a teammate's agent) — the file backend's optimistic claim is enough for one owner; TASKS.md's git-native compare-and-swap is the upgrade path if that ever changes.

## Sources

- [LangChain — Introducing ambient agents](https://www.langchain.com/blog/introducing-ambient-agents) — `notify`/`question`/`review` taxonomy, agent inbox
- [Approval fatigue — Encyclopedia of Agentic Coding Patterns](https://aipatternbook.com/approval-fatigue) — the antipattern and its four remedies
- [Tiered autonomy by reversibility](https://antigravitylab.net/en/articles/agents/antigravity-agent-reversibility-tiered-autonomy-architecture) and [AI agent autonomy levels](https://dev.to/brennhill/ai-agent-autonomy-levels-from-logged-to-locked-down-45am) — reversibility × blast radius, and reversibility as a property of the environment
- [TASKS.md](https://github.com/tasksmd/tasks.md) — stable ids, blocked-by, done-as-deletion, file vs git-native backends
- [agent-message-queue](https://github.com/avivsinai/agent-message-queue) — Maildir-style atomic delivery
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — closest existing tool; no question queue
- [Why we made our agent ask questions before it builds](https://www.braingrid.ai/blog/why-we-made-our-agent-ask-questions) — capping question count by design
