---
name: delegate
description: Delegate a coding task to Google's Antigravity CLI (agy) — multi-file edits, refactors, code review, or codebase analysis. Use when the user explicitly asks to use Antigravity, the agy CLI, or Google's terminal coding agent.
argument-hint: <coding task for Antigravity>
---

# Delegate to Antigravity CLI

Antigravity CLI (`agy`) is Google's terminal coding agent — it reads the
codebase, plans, and makes multi-file edits. This skill hands it a coding task
non-interactively and relays the result.

Reach for it when the user explicitly wants Antigravity, or wants a second
agent's take on a codebase task. For OpenAI Codex, use the `codex` plugin
instead. Unlike `codex`, this bridge is intentionally light — no handoff-spec
scaffolding; Antigravity is itself an agent that reads the repo.

## Your input

When invoked as `/agy:delegate <task>`, the user's text arrives as
`$ARGUMENTS` — that is the task to hand to Antigravity. When the skill
auto-triggers from conversation instead, assemble the task from context.

## Step 1: Frame the task

Write a clear, self-contained task description. Antigravity does not share your
conversation history, so include:

- What to do, and in which files or area of the codebase.
- Any constraints — style, framework, "tests must still pass".
- What "done" looks like.

You can point Antigravity at specific files inline with its `@` syntax — e.g.
`@src/auth.ts`, a directory `@src/`, or a glob `@**/*.ts` — by writing those
references into the task text.

## Step 2: Invoke

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs --prompt "<task>"
```

- Add `--json` when you intend to parse the result (`--output-format json`).
- Add `--verbose` to stream Antigravity's full reasoning trace — off by default
  to keep your context window clean.
- Antigravity runs in its own secure sandbox and applies the permission mode
  from the user's Antigravity settings. For smooth headless runs the user
  should have a non-interactive mode configured (e.g. `proceed-in-sandbox`); a
  600s timeout guards against a run that stalls on an approval prompt.

## Step 3: Report and evaluate

Relay what Antigravity did — files changed, decisions made. Then evaluate it
critically: Antigravity is a capable peer, not an authority. Sanity-check its
edits, flag anything you disagree with, and let the user decide. If it made
changes you did not expect, say so plainly rather than glossing over it.
