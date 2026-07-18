---
name: reason
description: (context-hub:reason) Delegate hard reasoning to OpenAI Codex at maximum effort (gpt-5.5, xhigh). Use whenever the user faces hard algorithms, math, optimization, deep debugging hypotheses, architecture trade-offs, or describes a problem as "hard", "tricky", "stuck on", or "can't figure out" — even if they don't name Codex. Default deep-reasoning path in this marketplace.
argument-hint: <problem statement>
---

# Codex Hard-Reasoning Offload

You are about to delegate a reasoning task to Codex CLI at high reasoning
effort. Use this when:

- A problem requires deep deliberation that exceeds your confidence
- You've attempted the problem and want a second-opinion solve from a different model
- The user explicitly asks for the "strongest" or "frontier" reasoning available

## Your input

When invoked as `/codex:reason <prompt>`, the user's text arrives as
`$ARGUMENTS` — treat it as the problem statement that becomes the **Task** in
Step 1. When this skill auto-triggers from conversation instead, assemble the
same problem statement from the surrounding context.

## Step 1: Draft sections 1–4 of the handoff spec

- **Task slug**: kebab-case (e.g. `optimize-graph-traversal`).
- **Role**: `Hard-reasoning solver`.
- **Task**: full problem statement. Include any prior attempts (yours), known constraints, and edge cases. Be exhaustive — Codex will not have your conversation context.
- **How**: usually `Delegate, figure it out.` for genuinely hard problems; numbered steps if you want to constrain the approach.
- **Constraints**: relevant files from `docs/carefully-crafted-plugins/constraints/` (typically `code-style.md` if output is code). If the project has no such file, use the packaged default at `${CLAUDE_PLUGIN_ROOT}/reference/defaults/constraints/code-style.md` — never scaffold the project file yourself.
- **Output format**: e.g. `docs/carefully-crafted-plugins/output-formats/raw-code.md` or `raw-prose.md`. If absent, use the packaged default at `${CLAUDE_PLUGIN_ROOT}/reference/defaults/output-formats/raw-code.md` (or `raw-prose.md`).
- **Artifact path**: `docs/carefully-crafted-plugins/output/<slug>.<ext>`.
- **Session artifact**: if a superpowers plan/spec exists in this session, reference its absolute path.

## Step 2: Pre-flight clarification — MANDATORY

Before invoking scripts:

1. Verify every constraint and output-format path resolves — either the
   project-local file or the packaged default under
   `${CLAUDE_PLUGIN_ROOT}/reference/defaults/` (always present, so this never
   blocks).
2. Verify the problem statement is complete: inputs, expected outputs, edge cases, performance requirements, language/framework.
3. If anything is missing, ask the user one targeted question.

Codex receives a finalized spec.

## Step 3: Invoke

Hard reasoning is exactly when to spend Codex's strongest setting. The wrapper
default is `medium` effort (token-efficient floor) — for this skill,
**explicitly escalate to xhigh**:

```bash
SPEC_PATH=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/spec-builder.mjs \
  --task-slug "<slug>" \
  --role "Hard-reasoning solver" \
  --task "<full problem>" \
  --how "<steps or 'Delegate, figure it out.'>" \
  --constraints "<abs paths>" \
  --output-format "<abs path>" \
  --artifact-path "docs/carefully-crafted-plugins/output/<slug>.<ext>" \
  --clarifications "<summary>")

node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs \
  --spec-path "$SPEC_PATH" \
  --sandbox workspace-write \
  --reasoning-effort xhigh
```

- `--sandbox workspace-write` lets Codex write the solution to the artifact
  path.
- `--reasoning-effort xhigh` is explicit — this skill is the hard-reasoning
  specialist, so we burn the strongest setting on purpose. The wrapper's
  default is `medium`; the contexthub triage skill grades down to that or up here
  depending on task difficulty.
- Model defaults to `gpt-5.5`. Only add `--model <name>` if the user
  explicitly names one.

## Step 4: Report

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/result-handler.mjs \
  --spec-path "$SPEC_PATH" \
  --type text
```

Summarize Codex's solution, then apply
`${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`: evaluate it critically
before relaying, and if it disagrees with your prior attempt, surface the
disagreement to the user rather than silently switching.
