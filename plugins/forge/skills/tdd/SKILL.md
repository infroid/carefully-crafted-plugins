---
name: tdd
description: Execute a forge plan task-by-task using RED → GREEN → REFACTOR, in a worktree so the main branch stays clean. Use whenever the user asks to implement, build, code, or start writing a planned change. Delegates stuck subproblems to /codex:reason; otherwise stays in Claude. Default implementation path in this marketplace.
argument-hint: <path to plan, or task id to execute>
---

# forge:tdd — Test-Driven Execution

The third phase. Take an approved plan and execute task-by-task. For
each task: write a failing test (RED), implement the smallest change
that passes (GREEN), refactor (REFACTOR), commit, move on.

Claude executes most tasks inline. When stuck on a hard subproblem
after one or two attempts, route to `codex:reason` instead of burning
turns in Claude.

## Your input

When invoked as `/forge:tdd <plan-path-or-task>`, `$ARGUMENTS` is either
the plan artifact path or a specific task id ("t3") to execute. If a
plan path, work through every task in order; if a task id, execute
just that one.

## Step 1: Set up a worktree (optional but recommended)

For multi-task plans, isolate the work in a git worktree so the main
branch stays clean and you can compare progress easily:

```bash
git worktree add ../<repo-name>-<plan-slug> -b forge/<plan-slug>
cd ../<repo-name>-<plan-slug>
```

Skip the worktree for single-task changes — overhead exceeds the
benefit.

## Step 2: Per-task loop — RED, GREEN, REFACTOR

For each task in the plan:

### RED — write the failing test first

Find or create the test file. Write the test that captures the
acceptance criterion from the plan's Verification field. Run it.
Confirm it fails for the **expected reason** (not a compile error in
the test itself).

### GREEN — minimal implementation

Make the test pass with the smallest reasonable change. Do not add
features the task doesn't require. Do not refactor adjacent code "while
you're here." YAGNI is non-negotiable.

If after one or two genuine attempts you are stuck — algorithm doesn't
work, you don't see the path, the design feels wrong — **stop and
delegate the subproblem to `codex:reason`** with the test, the failing
output, and what you've tried. Don't burn five turns on Claude when one
Codex call would resolve it.

### REFACTOR — only if it improves clarity

Tighten the code if it earns its complexity. Names, decomposition,
duplication. Stop the moment the change becomes speculative
("might need this later").

Run the test suite — green stays green.

### Commit

One commit per task. Message format: `<task-id>: <plan task summary>`.
Use the body to describe what was attempted, what worked, what
surprised you. The commit history IS the audit trail.

## Step 3: When tasks reorder

If executing a task reveals the plan was wrong (e.g. task t4 should
have come before t2), DO NOT silently rearrange. Stop, surface the
issue to the user with the evidence (what test you wrote, what
implementation you tried, why the order matters). Let the user decide
whether to amend the plan or push through.

This is the hard part — silent reordering is the #1 reason agents lose
the user's trust mid-plan.

## Step 4: Hand off

After all tasks pass, tell the user: "All tasks executed. Next:
`/forge:review <branch>` for the three-way audit." Do not auto-invoke.

## Honesty

- Never claim a task is done if its test is skipped, mocked, or
  green-by-coincidence (e.g. the test asserts the wrong thing).
- If you delegated a subproblem to `codex:reason`, name which task and
  what came back. The user deserves to see where the lifecycle leaned
  on a specialist.
- If you violated YAGNI mid-task — added something the task didn't
  require — say so. Don't quietly bundle in unrelated work.
