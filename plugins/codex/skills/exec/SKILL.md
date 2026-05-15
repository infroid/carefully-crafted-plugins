---
name: exec
description: Power-user escape hatch — pass any prompt directly to Codex CLI non-interactively without the structured 5-section handoff. Use only when the user explicitly invokes /codex:exec.
disable-model-invocation: true
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

4. Relay Codex's output verbatim to the user. Do not re-interpret or re-format — the user opted into raw mode deliberately.

If the user did not provide any arguments, ask: "What should I pass to Codex?"

## Reminder

For most tasks, prefer the structured skills (`image`, `reason`, `browser`) — they enforce constraint files, output-format contracts, and pre-flight clarification. `/codex:exec` skips all of that.
