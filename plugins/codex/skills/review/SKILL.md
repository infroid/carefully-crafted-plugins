---
name: review
description: On explicit request, run OpenAI Codex as an independent, read-only code auditor and hand back falsifiable evidence for a human or the active Superpowers review workflow to weigh. Slash-command only: invoke as /codex:review [target].
argument-hint: [target paths, diff range, or question]
disable-model-invocation: true
---

# Codex Independent Read-Only Review

This is an explicitly-requested second opinion, not the default review path.
It never auto-triggers, never applies changes, and never marks anything
complete — it inspects the target and hands back structured, falsifiable
evidence for you (or an active `superpowers:receiving-code-review` workflow)
to weigh. It is always `--sandbox read-only`; there is no apply/refactor mode.

## Your input

When invoked as `/codex:review [target]`, `$ARGUMENTS` may name paths, file
references, a revision/diff range, or an explicit question. It may also be
empty.

## Step 1: Resolve and announce the scope — deterministic order

1. `$ARGUMENTS`: named paths, file references, revision/diff range, or
   explicit question.
2. When arguments are absent: non-empty staged, unstaged, and named
   untracked working-tree changes.
3. Otherwise: stop and ask one concise target question. Never silently
   audit "recent work" or the whole repository.

State the resolved scope back to the user before invoking Codex.

## Step 2: Invoke — pass references, don't inline them

Draft sections 1–4 of the handoff spec:

- **Task slug**: kebab-case (e.g. `review-auth-module`).
- **Role**: `Read-only code auditor`.
- **Task**: the resolved scope from Step 1 (paths, diff range, or question),
  the repo `cwd`, and paths to any applicable `AGENTS.md`, `CLAUDE.md`, or
  constraint files. State what "good" looks like: falsifiable correctness,
  security, performance, and design risks with concrete evidence and a
  minimal fix. Do **not** pre-read and inline entire files/diffs/rules, and
  do not repeat a list of commands Codex may use — Codex is a read-only
  worker with its own filesystem access; let it inspect on demand.
- **How**: `Delegate, figure it out.`
- **Constraints**: relevant files from `docs/carefully-crafted-plugins/constraints/`
  (typically `code-style.md`, and `security.md` for anything auth-related).
  If the project has no such file, use the packaged default at
  `${CLAUDE_PLUGIN_ROOT}/reference/defaults/constraints/code-style.md` (or
  `security.md`) — never scaffold the project file yourself.
- **Output format**: `docs/carefully-crafted-plugins/output-formats/code-review.md`,
  or if absent, the packaged default at
  `${CLAUDE_PLUGIN_ROOT}/reference/defaults/output-formats/code-review.md`.
- **Artifact path**: `none` — this is a read-only reviewer; it never writes
  the working tree. Evidence comes back through the host-managed result file.

```bash
SPEC_PATH=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/spec-builder.mjs \
  --task-slug "<slug>" \
  --role "Read-only code auditor" \
  --task "<resolved scope + cwd + rule-file paths + what 'good' looks like>" \
  --how "Delegate, figure it out." \
  --constraints "<abs paths>" \
  --output-format "<abs path to code-review.md>" \
  --artifact-path "none" \
  --clarifications "<summary>")

node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs \
  --spec-path "$SPEC_PATH" \
  --sandbox read-only \
  --reasoning-effort high \
  --output-schema "${CLAUDE_PLUGIN_ROOT}/reference/schemas/code-review.schema.json"
```

`--output-schema` locks Codex's response to the bounded, provenance-preserving
evidence contract in `code-review.schema.json` (status, scope, up to 20
findings with `F-NNN` ids, limitations). `codex-invoke.mjs` already uses
`--output-last-message` internally in spec mode — no extra flag needed.

For a general non-code second opinion, route to `/codex:reason` instead. For
multi-view deliberation across Claude, Codex, and Antigravity, route to
`/contexthub:converge`.

## Step 3: Report — the locked evidence contract

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/result-handler.mjs \
  --spec-path "$SPEC_PATH" \
  --type review
```

This validates the result and prints a bounded compact index. Two outcomes:

- **Exit 0**: the index lists every returned finding ID exactly once
  (severity, location, confidence, title) plus status, scope, and
  limitations. Build a compact table from it, and for each finding add two
  annotations on separate axes **without altering Codex's severity or
  claim**:
  - **Evidence**: confirmed / contradicted / context-missing / not yet
    evaluated.
  - **Kind**: bug / security / performance / design / other.
  Expand full detail (claim, evidence, impact, minimal fix) only for
  critical/high, contradicted, or context-missing entries by default; keep
  the rest to the compact table. Always disclose the raw artifact path from
  the index output. If status is `NO_FINDINGS`, report it exactly as "no
  actionable findings for this declared scope" — including any limitations —
  never as a clean bill of health.
- **Exit non-zero**: this is a review **failure** (missing, empty,
  malformed, or contract-violating output), not an empty review. Report the
  failure and the full artifact path named in the error output. Do not
  synthesize or imply `NO_FINDINGS`.

Apply `${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`, including its
review-specific section, before relaying anything.

## What this skill never does

- Never edits, refactors, or applies anything — it is read-only, always.
- Never verifies or marks a change complete — that belongs to the active
  `superpowers:receiving-code-review` workflow. When the user asks to act on
  findings, hand the annotated finding IDs to that workflow, or tell them
  Superpowers must own that step.
- Never requires an `AskUserQuestion` step to select findings — accept
  finding IDs in a normal follow-up message.
- Never auto-resumes a peer debate. If Codex's findings are genuinely
  disputed and worth discussing further, and the exact Codex session ID from
  this run is available, resume it explicitly with `--resume <session-id>`
  — never the ambient `--resume-last`, which could resume an unrelated
  session.
