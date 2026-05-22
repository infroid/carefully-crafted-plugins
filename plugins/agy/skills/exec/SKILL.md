---
name: exec
description: Power-user escape hatch — pass any prompt straight to Google's Antigravity CLI (agy) for general coding tasks (multi-file edits, refactors, repo analysis). Use only when the focused skills (/agy:longcontext, /agy:image, /agy:video) do not fit. Slash-command only.
disable-model-invocation: true
argument-hint: <task for agy>
---

# Antigravity Raw Passthrough

This skill is the escape hatch — hand any task to Antigravity CLI
non-interactively. It is slash-command only; Claude Code will not auto-trigger
it from natural language.

When the user runs `/agy:exec <task>`:

1. Take everything after `/agy:exec` as the task — it is provided as
   `$ARGUMENTS`. If empty, ask: "What should I pass to Antigravity?"
2. Invoke:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs --prompt "$ARGUMENTS"
```

   - Add `--json` for structured output you intend to parse.
   - Add `--verbose` to stream Antigravity's full reasoning trace.
   - Add `--cwd <dir>` to run from a different working directory.

3. Relay what Antigravity did — files changed, decisions made. Then sanity-
   check critically: Antigravity is a capable peer, not an authority. Flag
   anything you disagree with and let the user decide. If it made changes you
   did not expect, surface that plainly rather than glossing over it.

## When to use which agy skill

- **Repo-wide or huge-document analysis** → `/agy:longcontext`
- **Image generation** (Nano Banana Pro) → `/agy:image`
- **Video generation** (Veo) → `/agy:video`
- **Anything else** delegated to Antigravity → this skill, `/agy:exec`

For most general coding tasks, Claude Code itself is the right tool —
`/agy:exec` is specifically for sending work *to Antigravity*.
