This is a headless, single-turn session: no later turn and nothing watching for one. Run every command in the foreground and block until it finishes.

The deterministic drain already ran. It pushes/prunes/drafts my own branches through argv (no shell) and queues the decisions that need me — it does NOT answer questions. Its full output is on disk:

  file:   {{OUTPUT}}
  size:   {{BYTES}} bytes
  status: {{STATUS}}   (10 = a NEW decision is waiting for me; 4 = gh failed mid-pass, so the PR half is untrustworthy and the drain skipped every worktree action)

Read that entire file first (page with offset until you have covered all {{BYTES}} bytes). Then, based on status:

**If status is 10 — new questions are waiting.** The JSON's `questions.waiting` lists them (each with a `header`, a `key`, and the `question` text). Your ONLY job is to ping me so I open a session and run `/work-assistant` myself. Send ONE Slack DM to `U07GJ2PRSLS` via `slack_send_message`:

- One short intro line: how many decisions are waiting.
- One bullet per waiting question: its `header` and the `question` text. **Headers and the question line only — do NOT include the evidence, the options, or any recommendation.** This is a heads-up, not the decision.
- Close with: `Abrí una sesión y corré /work-assistant.`

Example:

> 🗂️ El work-assistant tiene 2 decisiones esperando:
> • *Frío* — SQSH-4084 no se toca hace más de 14 días. ¿Qué hago?
> • *Sin commit* — feat/x tiene 3 archivo(s) sin commitear. ¿Qué hago?
> Abrí una sesión y corré /work-assistant.

**If status is 4 — gh was degraded.** Do NOT run the drain yourself and do NOT push or open PRs — the PR half is unknown, so a draft could be opened for a branch that already has a PR. Send ONE Slack DM to `U07GJ2PRSLS` noting the pass was incomplete (gh failed) and the next healthy tick or an on-demand `/work-assistant` will finish it. Do not list questions — the queue is not trustworthy this pass.

**Always, whatever the status:**

- Do NOT answer any queued question. Questions are my decision and wait for `/work-assistant`. Answering here is the exact failure mode this check is designed to avoid.
- Do NOT run `run.js` (or any push / PR / worktree command) yourself — the drain already ran; you only notify.
- Do NOT reply to review comments or touch anyone else's branch — that is pr-babysit's job, not this one.

End with a one-line summary of what you sent.
