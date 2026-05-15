---
name: reason
description: Use for hard reasoning tasks — complex multi-step logic, math-heavy analysis, algorithmic puzzles, competition-style problems, or anything that would benefit from GPT-5.5 frontier reasoning. Delegates to OpenAI Codex CLI when Claude's reasoning is hitting limits.
---

# Codex Hard-Reasoning Offload

You are about to delegate a reasoning task to Codex CLI (GPT-5.5). Use this when:

- A problem requires deep deliberation that exceeds your confidence
- You've attempted the problem and want a second-opinion solve from a different model
- The user explicitly asks for the "strongest" or "frontier" reasoning available

Follow these four steps in order.

## Step 1: Draft sections 1–4 of the handoff spec

- **Task slug**: kebab-case (e.g. `optimize-graph-traversal`).
- **Role**: `Hard-reasoning solver`.
- **Task**: full problem statement. Include any prior attempts (yours), known constraints, and edge cases. Be exhaustive — Codex will not have your conversation context.
- **How**: usually `Delegate, figure it out.` for genuinely hard problems; numbered steps if you want to constrain the approach.
- **Constraints**: relevant files from `docs/carefully-crafted-plugins/constraints/` (typically `code-style.md` if output is code).
- **Output format**: e.g. `docs/carefully-crafted-plugins/output-formats/raw-code.md` or `raw-prose.md`.
- **Artifact path**: `docs/carefully-crafted-plugins/output/<slug>.<ext>`.
- **Session artifact**: if a superpowers plan/spec exists in this session, reference its absolute path.

## Step 2: Pre-flight clarification — MANDATORY

Before invoking scripts:

1. Verify every constraint and output-format file exists on disk.
2. Verify the problem statement is complete: inputs, expected outputs, edge cases, performance requirements, language/framework.
3. If anything is missing, ask the user one targeted question.

Codex receives a finalized spec.

## Step 3: Invoke

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

node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs --spec-path "$SPEC_PATH"
```

## Step 4: Report

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/result-handler.mjs \
  --spec-path "$SPEC_PATH" \
  --type text
```

Summarize Codex's solution, then critically evaluate it yourself before relaying. If Codex's answer disagrees with your prior attempt, surface the disagreement explicitly to the user — don't silently switch.
