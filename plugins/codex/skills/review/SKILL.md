---
name: review
description: Delegate code review and refactoring to OpenAI Codex. Use whenever the user wants a code review, audit, security check, bug hunt, refactor, or an independent second opinion on a diff or file set — even if they don't name Codex. Default code-review path in this marketplace.
argument-hint: <review target or refactor brief>
---

# Codex Code Review & Refactoring

You are about to delegate a code-review or refactoring task to Codex CLI —
reviewing a diff, auditing files, or applying a refactor. Working over real
code is Codex's core strength.

## Your input

When invoked as `/codex:review <text>`, the user's text arrives as
`$ARGUMENTS` — treat it as the review target or refactor brief that becomes
the **Task** in Step 1. When this skill auto-triggers from conversation
instead, assemble the same brief from the surrounding context.

## Review vs. apply — pick the sandbox deliberately

- **Review / analysis only** (the default) → `--sandbox read-only`. Codex
  inspects and reports; it changes nothing.
- **Apply a refactor** → `--sandbox workspace-write`. Only when the user has
  clearly asked Codex to *make* the changes, not just suggest them. Confirm
  this in Step 2 per `${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`.

## Step 0: Ensure the bridge is set up

Run this first. It is a fast, idempotent no-op once the repo is configured:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs --ensure
```

If it reports a first-time setup, tell the user in one plain line — e.g.
"First use of the Codex bridge here, so I ran a quick one-time setup; starter
standards files are under `docs/carefully-crafted-plugins/`, customize them
anytime" — then continue. Do not pause for approval: the scaffold is safe and
never overwrites existing files.

## Step 1: Draft sections 1–4 of the handoff spec

- **Task slug**: kebab-case (e.g. `review-auth-module`).
- **Role**: `Code reviewer` (review only) or `Refactoring agent` (apply mode).
- **Task**: exactly what to review and where — the diff, file paths, or
  refactor goal. Name the files; state what "good" looks like (correctness,
  security, performance, readability). Codex will not have your conversation
  context, so be explicit.
- **How**: `Delegate, figure it out.` for an open review; numbered steps when
  the user wants a specific refactor done a specific way.
- **Constraints**: relevant files from `docs/carefully-crafted-plugins/constraints/`
  (typically `code-style.md`, and `security.md` for anything auth-related).
- **Output format**: `docs/carefully-crafted-plugins/output-formats/code-review.md`.
- **Artifact path**: `docs/carefully-crafted-plugins/output/<slug>.md`.

## Step 2: Pre-flight clarification — MANDATORY

1. Verify every constraint and output-format file exists on disk.
2. Confirm the exact review scope (which files / which diff range).
3. Confirm **review-only vs. apply** with the user, and therefore the sandbox.
   Treat `workspace-write` as a high-impact choice — see
   `${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`.

## Step 3: Invoke

Review only (default):

```bash
SPEC_PATH=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/spec-builder.mjs \
  --task-slug "<slug>" \
  --role "Code reviewer" \
  --task "<what to review>" \
  --how "<steps or 'Delegate, figure it out.'>" \
  --constraints "<abs paths>" \
  --output-format "<abs path to code-review.md>" \
  --artifact-path "docs/carefully-crafted-plugins/output/<slug>.md" \
  --clarifications "<summary>")

node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs \
  --spec-path "$SPEC_PATH" \
  --sandbox read-only
```

To apply a refactor, set `--role "Refactoring agent"` and
`--sandbox workspace-write` instead (only after confirming in Step 2).

## Step 4: Report

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/result-handler.mjs \
  --spec-path "$SPEC_PATH" \
  --type text
```

Summarize the findings, then apply
`${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`: do not relay Codex's
review as gospel — sanity-check its claims, flag anything you disagree with,
and let the user decide.
