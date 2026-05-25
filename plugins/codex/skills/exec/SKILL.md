---
name: exec
description: Power-user escape hatch — pass any prompt directly to Codex CLI non-interactively without the structured 5-section handoff. Use only when the user explicitly invokes /codex:exec.
argument-hint: <raw prompt for codex>
---

# Codex Raw Passthrough

This skill is for power users who want to invoke Codex without the structured handoff spec. It is **slash-command only** — Claude Code will not auto-trigger it from natural language.

When the user runs `/codex:exec <prompt>`:

1. Take everything after `/codex:exec` as the raw prompt (it is provided as `$ARGUMENTS`).
2. Do **not** run `spec-builder.mjs`. There is no spec for this call.
3. Invoke Codex directly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs --raw "$ARGUMENTS"
```

   This runs `--sandbox read-only` by default. If the user's task needs Codex
   to write files or use the network, add `--sandbox workspace-write` (or
   `danger-full-access`) — but treat that as a high-impact choice and confirm
   first, per `${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`.

   The wrapper already defaults to the strongest setup: `--model gpt-5.5`,
   `--reasoning-effort xhigh`, `--verbosity low`. Only pass `--model`,
   `--reasoning-effort`, or `--verbosity` when the user explicitly asks for
   something different.

4. Relay Codex's output verbatim to the user. Do not re-interpret or re-format — the user opted into raw mode deliberately.

If the user did not provide any arguments, ask: "What should I pass to Codex?"

## Reminder

For most tasks, prefer the structured skills (`image`, `reason`, `browser`,
`review`) — they enforce constraint files, output-format contracts, and
pre-flight clarification. `/codex:exec` skips all of that.
