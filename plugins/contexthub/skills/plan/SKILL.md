---
name: plan
description: (context-hub:plan) Convert an approved spec into a step-by-step task plan with exact file paths and verification steps. Use whenever the user asks to plan, decompose, break down, or implement-strategy a feature or change. Stress-tests the plan with /codex:reason for edge cases and verifies coverage with /agy:longctx when the plan touches many files. Default planning path in this marketplace.
argument-hint: <path to spec, or paste the spec directly>
---

# contexthub:plan — Plan Writing

The second phase of the multi-agent lifecycle. Take an approved spec and
decompose it into atomic tasks: each one 5–15 minutes of work, each
named with the exact file paths it touches and how it will be verified.

Where Superpowers does this with one mind, `contexthub:plan` adds two
sanity checks: `codex:reason` stress-tests for missed edge cases, and
`agy:longctx` verifies the plan touches every relevant callsite when
the work spans many files.

## Your input

When invoked as `/contexthub:plan <spec-path-or-text>`, treat `$ARGUMENTS` as
either an absolute path to a spec written by `contexthub:spec`, or the spec
text itself. If a path, read the file first.

## Step 1: Grade the plan's difficulty

Invoke `/triage:grade` on the work-as-a-whole. This sets the effort
floor for the stress-test phase. If the plan is genuinely **low**,
skip Step 3 and Step 4 — single-perspective planning is sufficient.

## Step 2: Claude drafts the plan

Decompose into atomic tasks. Each task gets:

```
## Task <id>: <one-line summary>
- **Files touched**: path/a.ts, path/b.ts
- **Approach**: 1-3 sentences. Concrete enough to start typing.
- **Verification**: how we'll confirm this task is done (test, command,
  manual check).
- **Difficulty**: low | medium | hard (per triage:grade rubric)
- **Specialist**: claude | codex | agy | contexthub
```

Aim for 3–8 tasks for a typical change. More than 12 → likely
over-decomposed, fold related items together.

## Step 3: Stress-test with codex:reason (medium+ plans only)

Invoke `/codex:reason` with the drafted plan and ask it explicitly:

> Here is the plan. List edge cases this plan misses, ordering
> failures, partial-failure scenarios, and constraints that aren't
> obviously satisfied. Be specific. Cite line numbers in the plan.

Codex will return a critique. Integrate findings:

- Real misses → add tasks to cover them.
- Misreads → leave the plan unchanged but note Codex's concern in the
  artifact so future readers see the contested point.

## Step 4: Verify coverage with agy:longctx (multi-file plans only)

If the plan touches >5 files OR mentions repo-wide concepts ("every
callsite of X", "all places that do Y"), invoke `/agy:longctx`:

> Given this plan, list every callsite in `@<repo-paths>` that the
> plan SHOULD touch but doesn't mention. Format: file:line — one-line
> reason.

Add missed callsites as tasks. Skip this step for single-file or
clearly-scoped changes — long-context calls cost real tokens.

## Step 5: Write the plan artifact

Structure:

```
# Plan: <spec title>

Spec: <link to spec artifact>
Triage: <link to triage artifact>

## Tasks
<task blocks from Step 2, with any additions from Steps 3 and 4>

## Validation notes
- What codex:reason flagged (accepted vs. rejected, with reasoning)
- What agy:longctx flagged (accepted vs. rejected, with reasoning)
```

Write via:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs --phase plan --slug "<kebab-slug>"
<plan body>
EOF
```

Relay the artifact path.

## Step 6: Hand off to tdd

Tell the user: "Plan written to <path>. Next: `/contexthub:tdd <plan-path>`
to execute task-by-task with TDD." Do not auto-invoke — the user
reviews the plan first.

## Honesty

- If Codex's critique exposed a real miss, integrate it. Don't
  pretend you thought of it.
- If `agy:longctx` flagged 50 callsites and only 5 are relevant, say
  so in the validation notes. Long-context output can hallucinate
  edges; spot-check.
- Never inflate task count to look thorough. Atomic + sufficient
  beats granular + bloated.
