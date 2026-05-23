---
name: resume
description: Continue the most recent OpenAI Codex session with a follow-up prompt, keeping its full transcript, plan, and approvals. Use via /codex:resume.
argument-hint: <follow-up for the last Codex session>
---

# Codex Session Resume

This skill continues the **most recent Codex session in the current
directory** — `codex exec resume --last`. The resumed session keeps the
original transcript, plan history, and approvals, and inherits its model,
reasoning effort, and sandbox mode. It is slash-command only.

When the user runs `/codex:resume <follow-up>`:

1. Take everything after `/codex:resume` as the follow-up prompt — it is
   provided as `$ARGUMENTS`. If empty, ask: "What follow-up should I send to
   the last Codex session?"
2. Invoke:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs --resume-last --raw "$ARGUMENTS"
```

3. Relay Codex's output to the user, then apply
   `${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md` — evaluate the
   result critically rather than accepting it wholesale.

## When to use it

- Iterating on a previous delegation ("tighten the error handling", "now add
  tests").
- Asking Codex to reconsider in light of new information.
- Discussing a disagreement peer-to-peer (see `critical-evaluation.md`).

## Notes

- "Last" is scoped to the current working directory. If several Codex sessions
  were run here, it resumes the most recent one.
- Do not pass `--model`, `--reasoning-effort`, or `--sandbox` on a resume — the
  session already has them. If the user explicitly wants different settings,
  start a fresh delegation instead of resuming.
