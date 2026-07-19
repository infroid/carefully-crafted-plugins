---
name: supervise
description: Supervise an implementation with Claude as planner and reviewer while isolated GPT-5.6 Sol Codex workers execute independent tasks, return compact evidence, and receive at most one correction wave. Use only when the user explicitly invokes /contexthub:supervise. Slash-command only.
argument-hint: <task to supervise>
disable-model-invocation: true
---

# Supervise: Claude-Planned, Codex-Executed Implementation

You are the planner and reviewer. `supervise.mjs`
(`${CLAUDE_PLUGIN_ROOT}/scripts/supervise.mjs`) is the host-authoritative
transport: it owns the phase machine, the run ledger, git isolation, and
every Codex spawn. You never invoke Codex or write to the ledger yourself —
every state change goes through a subcommand. Read `references/protocol.md`
before your first run; it holds detail this body intentionally omits.

## 1. Initialize

Write `$ARGUMENTS` unchanged to a temporary file with your file tool, then:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/supervise.mjs init --request-file <temp-path>
```

`init` completes Git/Codex/auth/Superpowers preflight and creates the
integration worktree before any methodology skill writes anything. Once it
confirms the ledger copy, delete the temp file. Record `run_id` and
`integration_worktree`: every later command needs the run ID, and from here
on every planning/execution/verification/finish-action tool's cwd is
`integration_worktree` — only the discard/post-complete `cleanup` step runs
from the original repository, after validating this run's ledger.

## 2. Grade

Run `grade --run <run_id>` and read only `complexity.json`, never the raw
grader transcript. Independently record and justify your own score; do not
simply echo the grader's.

## 3. Resolve design (if needed)

If the design is not already settled, state **REQUIRED SUB-SKILL:** Use
`superpowers:brainstorming`, invoke it in the integration worktree, obtain
design approval, and keep its spec commit there.

## 4. Plan

State **REQUIRED SUB-SKILL:** Use `superpowers:writing-plans`, invoke it,
and commit the detailed human plan under
`<integration-worktree>/docs/superpowers/plans/`. Then derive a separate,
compact machine task graph (schema in `references/protocol.md`) and call:

```bash
supervise.mjs accept-plan --run <run_id> --plan-file <tracked-plan-path> --graph-file <graph-path>
```

**Do not** offer or invoke `subagent-driven-development`,
`executing-plans`, or `dispatching-parallel-agents`, even though
`writing-plans` normally offers them next: `/supervise` has already
selected its external Codex execution engine, so resume this state machine
immediately instead.

## 5. Approvals, then wave one

Resolve every approval flag with the user via `decide-approval` first. Then
run wave one and read only `checkpoint-1.json` — not worker transcripts.
Open `detailPath` if any checkpoint's `concernCount` is nonzero.

## 6. Review wave one

Classify every acceptance criterion `SATISFIED|GAP|UNCERTAIN` and record it
via `accept-review`. Supply `--correction-graph-file` **only** when at
least one criterion is `GAP` or `UNCERTAIN`; omit it otherwise.

## 7. At most one correction wave

If corrections ran, run wave two. Afterward classify every criterion
`SATISFIED|BLOCKED` and call `accept-final-review`. Never request or attempt
a third wave — the transport structurally refuses it.

Order Codex workers by skill name only (no `superpowers:` prefix, no `@`
includes): `test-driven-development`, `systematic-debugging` when needed,
`receiving-code-review` for corrections, `verification-before-completion` —
never subagent-driven or parallel-agent skills; a worker is always alone.

## 8. Verify

Before any completion claim, state **REQUIRED SUB-SKILL:** Use
`superpowers:verification-before-completion`, invoke it, then run
`supervise.mjs verify` and inspect the newly written `final.json` — complete
host evidence, not your own belief that things look done.

## 9. Finish

From the integration worktree, state **REQUIRED SUB-SKILL:** Use
`superpowers:finishing-a-development-branch`, present its exact choices, and
obtain fresh user consent. Call `choose-finish` **before** any action.
`keep` is the no-external-action default. `merge` and `push` also require a
`"target"` branch in the decision file — the branch the work lands on, which
`complete-finish` verifies against and which may not be this run's own
integration branch. For merge/push/PR, constrain Superpowers to the recorded
action only, never removing the integration worktree, then call
`complete-finish` once it succeeds. For discard, return to the original
repository and call supervisor-owned `cleanup --mode discard` yourself —
never let a methodology skill delete first. Later cleanup is separate,
explicit, and clean-only.
