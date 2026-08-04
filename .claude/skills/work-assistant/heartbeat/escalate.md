This is a headless, single-turn session: no later turn and nothing watching for one. Run every command in the foreground and block until it finishes.

The deterministic drain already ran. It pushes/prunes/drafts my own branches through argv (no shell) and queues the decisions that need me — it does NOT answer questions. Its full output is on disk:

  file:   {{OUTPUT}}
  size:   {{BYTES}} bytes
  status: {{STATUS}}   (4 = gh failed mid-pass, so the PR half is untrustworthy and the drain skipped every worktree action; 10 = reserved for model-needing residue)

Read that entire file first (page with offset until you have covered all {{BYTES}} bytes). Then:

- If status is **4**: gh was degraded. Do NOT run the drain yourself and do NOT push or open PRs — the PR half is unknown, so a draft could be opened for a branch that already has a PR. Just note in your summary that this pass was incomplete and the next healthy tick (or an on-demand /work-assistant) will finish it.
- Do NOT answer any queued question. Questions are the owner's decision and wait for /work-assistant. Answering here is the failure mode this check is designed to avoid.
- Do NOT reply to review comments or touch anyone else's branch — that is pr-babysit's job, not this one.

End with a one- or two-line summary: what the drain did (from the file), and whether this pass was degraded.
