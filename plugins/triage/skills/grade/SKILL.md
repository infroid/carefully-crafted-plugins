---
name: grade
description: Grade a task low/medium/hard and decompose into subtasks if scope warrants, then write a routing plan that downstream bridges read to set model effort. Use whenever you are about to delegate work to /codex:*, /agy:*, or /contexthub:converge — call this first to avoid overspending tokens on easy work. Default token-efficiency path in this marketplace.
argument-hint: <task description>
---

# Triage: Difficulty Grading & Routing Plan

You are about to grade an incoming task — decide whether it's one task or
several, rate each by difficulty, and write a routing plan that downstream
specialists read to set the right model effort. This is the
token-efficiency primitive: **the bridge defaults drop to `medium` effort,
and triage escalates to `high` / `xhigh` only when difficulty warrants
it.**

Call this **before** invoking any specialist (`/codex:*`, `/agy:*`,
`/contexthub:converge`) — unless the user explicitly asked for a specific
effort or you have strong context the task is uniform.

## Your input

When invoked as `/triage:grade <task>`, the user's text arrives as
`$ARGUMENTS` — that is the task description. When this skill auto-triggers
from conversation, assemble the same description from context.

## Step 1: Decompose — single or subtasks?

Decompose only when scope is genuinely multi-task. A task is "single" if it:

- Fits a single specialist's strength end-to-end (e.g. "audit
  src/auth.ts" → one `codex:review` call)
- Is described as one user-visible deliverable

A task is "subtasks" if it:

- Spans multiple specialists (e.g. "generate an icon AND benchmark
  performance" → codex:imagegen + codex:reason)
- Has user-visible milestones that should be graded independently
- Mixes easy and hard pieces — separating them saves tokens on the easy
  ones

When in doubt, prefer **single**. Over-decomposition costs context.

## Step 2: Grade each task — low / medium / hard

Use `${CLAUDE_PLUGIN_ROOT}/skills/grade/references/difficulty-heuristics.md`
for the full rubric. Quick version:

- **low** — single-file edit, well-defined spec, no ambiguity, no
  cross-cutting impact, no research required.
- **medium** — 2–3 files; standard pattern; some ambiguity but solvable
  in-context.
- **hard** — cross-cutting; ambiguous spec; root-cause debugging from
  symptom; novel architecture; performance work; anything needing >Claude's
  context to verify.

Bias toward **low**. Reserve **hard** for tasks that genuinely benefit
from the strongest effort. Over-grading wastes the user's tokens.

## Step 3: Pick specialist + effort + model

| Difficulty | Specialist | Codex effort | Agy model | Claude routing |
|---|---|---|---|---|
| low | claude | low | flash-tier | Stay in Claude; don't delegate |
| medium | codex / agy / claude | medium | pro | Single specialist if needed |
| hard | codex / agy / contexthub | xhigh | pro (full 1M) | Multi-agent if perspective matters |

Specialist choice:

- **claude** — task fits Claude's context and capability; no delegation needed.
- **codex** — hard reasoning, code review, Playwright browser, image gen.
- **agy** — whole-repo audits (>Claude context), Nano Banana images, Veo video.
- **contexthub** — controversial design calls where diverse perspectives are
  worth the cost.

## Step 4: Write the routing plan

Use `${CLAUDE_PLUGIN_ROOT}/scripts/triage-write.mjs` to emit the JSON
artifact. Pass tasks one-by-one (or the whole plan as a single JSON blob on
stdin):

```bash
# Single task
node ${CLAUDE_PLUGIN_ROOT}/scripts/triage-write.mjs \
  --decomposition single \
  --task-id t1 \
  --summary "audit src/auth.ts for race conditions" \
  --difficulty hard \
  --specialist codex \
  --effort xhigh \
  --model gpt-5.5

# Multi-task: pass --decomposition subtasks and repeat the task block
node ${CLAUDE_PLUGIN_ROOT}/scripts/triage-write.mjs \
  --decomposition subtasks \
  --task-id t1 --summary "..." --difficulty low --specialist claude --effort low \
  --task-id t2 --summary "..." --difficulty hard --specialist codex --effort xhigh
```

The script writes `docs/carefully-crafted-plugins/triage/<YYYY-MM-DD-HHMMSS>-<slug>.json`
and prints the artifact path. Use that path as input to downstream skills.

## Step 5: Apply the plan

For each task in the artifact:

- If `specialist: claude` and `difficulty: low` → handle inline; do not
  delegate.
- If specialist is `codex` / `agy` / `contexthub` → invoke the
  corresponding skill, passing `--reasoning-effort <effort>` (codex) or
  `--model <model>` (agy) to override the wrapper's default.

Tell the user, briefly, what you graded and why — one line per task.
Example: *"Graded `audit src/auth.ts` as hard → routing to /codex:review
at xhigh."*

## Honesty

- Do not grade a task as **hard** to flex the strongest model. The user
  pays per token.
- Do not grade a task as **low** to look efficient. The user pays in
  correctness.
- If you genuinely can't decide between two grades, name both in one
  sentence and pick the lower one. The bridge's default behaviour is
  graceful at `medium`.
