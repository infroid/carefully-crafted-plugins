---
name: resume
description: Continue the most recent OpenAI Codex session in this directory with a follow-up prompt while pinning the resumed run to a read-only sandbox. Slash-command only: invoke as /codex:resume <follow-up>.
argument-hint: <follow-up for the last Codex session>
disable-model-invocation: true
---

# Codex Session Resume

This skill continues the **most recent Codex session in the current
directory** — `codex exec resume --last`. The resumed session keeps its
transcript and model context. The wrapper explicitly pins the resumed run
to `sandbox_mode=read-only` so current user configuration cannot silently
escalate it. It is slash-command only.

When the user runs `/codex:resume <follow-up>`:

1. Take everything after `/codex:resume` as the follow-up prompt — it is
   provided as `$ARGUMENTS`. If empty, ask: "What follow-up should I send to
   the last Codex session?"
2. Invoke:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs \
  --resume-last \
  --raw "$ARGUMENTS" \
  --sandbox read-only
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
- Model and reasoning effort remain session-owned. The wrapper pins sandbox
  mode independently.
- If the follow-up must edit files, add `--sandbox workspace-write` only after
  the user authorizes that escalation. Never assume the prior run's effective
  sandbox is still in force.
