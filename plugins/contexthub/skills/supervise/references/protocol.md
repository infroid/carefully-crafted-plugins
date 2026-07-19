# /contexthub:supervise protocol reference

This is the detailed reference `SKILL.md` intentionally omits. It documents
the state machine, the run ledger, the machine task graph, approvals,
recovery, exact-session correction policy, cleanup safety, and receipt
shapes — the boundary between this transport and Superpowers methodology,
never a copy of Superpowers' own methodology content.

## The transport, not the methodology

`supervise.mjs` is a thin CLI shell over five frozen modules:
`contracts.mjs` (validation), `state.mjs` (the phase machine and durable
ledger), `codex.mjs` (the private Codex transport), `git.mjs` (isolation and
atomic integration), and `scheduler.mjs` / `checkpoint.mjs` / `verify.mjs`
(wave execution, compact receipts, host verification). It contains no
planning or review judgment of its own — every judgment call
(design approval, plan quality, acceptance classification, finish choice)
is yours, recorded through a CLI subcommand, never inferred by the
transport.

## State machine (phase -> phase)

```
INITIALIZED -> GRADING -> GRADED -> [APPROVAL_PENDING ->] PLANNED
  -> WAVE_1_RUNNING -> WAVE_1_COMPLETE
  -> (no gaps) VERIFYING
  -> (gaps)    REVIEWED -> WAVE_2_RUNNING -> WAVE_2_COMPLETE
               -> CORRECTIONS_REVIEWED -> VERIFYING
  -> FINISH_PENDING -> FINISH_ACTION_PENDING -> COMPLETE
```

`BLOCKED` is reachable from any non-terminal phase and always records
hashed evidence; `recover` is the only way out. `REVIEWED -> WAVE_2_RUNNING`
is the *only* edge that can ever produce a second execution wave — the
`Phase` enum has no third-wave member, and a correction graph's `wave`
field is contractually pinned to the literal integer `2`. A third wave is
not merely policy-forbidden; it has no representable state to land in.

## Run ledger layout

```text
<git-common-dir>/carefully-crafted/supervise/<run-id>/
├── run.json              the durable phase machine (state.mjs-owned)
├── preflight.json        repo info, Codex preflight evidence, integration worktree path
├── request.md            your exact $ARGUMENTS, copied once
├── complexity.json       the grader's validated output
├── plan.md               the accepted human plan (overwritable on a genuine replan)
├── task-graph.json        the accepted machine task graph (same)
├── approvals.json        live approval-flag bookkeeping (same)
├── review.json           wave-one Claude review
├── correction-graph.json  wave-two machine task graph (gap path only)
├── final-review.json     post-correction Claude review (gap path only)
├── checkpoint-1.json, checkpoint-2.json   compact wave receipts
├── final.json            the final verification receipt
├── finish-choice.json, finish-evidence.json, cleanup.json
├── changed-conditions/   recover's supporting evidence
├── orders/, reports/, receipts/, logs/
```

Immutable artifacts (request, complexity, reviews, correction graph,
checkpoints, final, evidence files) use exclusive creation: a restart may
reuse an artifact only on an exact byte-for-byte match, never a silent
overwrite. `plan.md`/`task-graph.json`/`approvals.json` are the one
exception — they are legitimately overwritten on a genuine re-plan, which
is reachable only after a rejected approval returns the run to `GRADED`.

## The machine task graph

A closed, ≤65536-byte JSON object: `version` (literal `1`), `run_id`,
`base_commit` (must exactly equal the integration worktree's clean HEAD),
`complexity_review` (`grader_score`, `claude_score`,
`override_reason` — required exactly when the two scores differ),
`acceptance` (≤40 criteria), `approval_flags` (all `PENDING`),
`final_verification` (≤20 commands), and `tasks` (≤12, each with disjoint
`write_paths`, empty `depends_on` — every task in a wave starts from the
same base commit — `effort` one of `high|xhigh|max` (at most one `max`,
only at `claude_score` 5), and `risk` one of `low|medium|high`). A
correction graph is the same shape with `wave` pinned to `2`, no
`complexity_review`/`acceptance`/`approval_flags`/`final_verification`
fields of its own, and each task additionally carrying `source_task_id`
and `session_policy` (`fresh` or `resume-exact`).

## Approvals

Every `approval_flags` entry is one of nine categories (destructive,
dependency, network, credential, data-migration, security-api-decision,
scope-expansion, external-action, product-decision). `decide-approval` is
idempotent for a repeated identical decision; a conflicting decision on an
already-decided flag is rejected. The **final** approval moves
`APPROVAL_PENDING` to `PLANNED`; any single rejection invalidates the whole
accepted graph and returns to `GRADED` for replanning — nothing is salvaged
from a partially-approved plan.

## Recovery

`recover` handles two distinct situations:

1. **`BLOCKED`** — requires `--changed-condition-file`; the file's bytes
   must differ from whatever caused the block (a byte-identical resubmission
   is refused). Recovery returns the run to `blockedFrom`.
2. **An interrupted running phase** (`GRADING`, `WAVE_1_RUNNING`,
   `WAVE_2_RUNNING`, `VERIFYING`) — recovery independently confirms the
   previously recorded operation's process is no longer alive, then
   reconciles processes, receipts, worktrees, and integration HEAD before
   relaunching. For an interrupted wave, this means consulting each task's
   receipt and its commit's integration status directly — a task that
   already produced a verified, uncommitted-to-integration commit is
   integrated from that existing commit, never re-run through a worker.

## Exact-session correction policy

A wave-two task's `session_policy: "resume-exact"` is only ever honored
when the run's own Codex preflight (captured once, at `init`) reported
`resumeSupported: true`; otherwise it silently falls back to `fresh`. When
honored, the correction reuses the exact wave-one worktree path (cleanly
removed and recreated at the identical path) so a Codex `resume` — confined
by that path alone, never by an argv flag — lands on the original session.
`resume-exact` requires unchanged `effort` and a `write_paths` subset of
the source wave-one task's ownership.

## Finishing: the decision file and the `target` contract

`choose-finish --decision-file <path>` takes a JSON object recording the
user's exact choice. Its `target` field is the ref the work lands on, and it
is **mandatory for `merge` and `push`**:

```json
{ "target": "release" }
```

`complete-finish` verifies those two choices by proving the integration HEAD
is reachable from that recorded ref. Without a target there is nothing to
verify against, so completion would collapse to "the worktree is clean and
some evidence file was supplied" — which would accept an action that was
never performed. `choose-finish` therefore refuses a missing or empty
target up front, while the user is still being asked, rather than
discovering it at completion time.

### The property a target must satisfy

> A merge/push target must **name a destination ref that a merge could land
> in**, and that ref must **not be this run's own integration branch**.

Both halves are enforced, at `choose-finish` and again at `complete-finish`,
and each half exists because its absence makes the completion check
incapable of failing:

- **Must name a destination ref.** The target is resolved with
  `git rev-parse --symbolic-full-name --verify`, and the result must land in
  `refs/heads/**` or `refs/remotes/**` — a local branch or a remote-tracking
  branch. Anything else is refused. A value naming a *commit* rather than a
  destination (a full or abbreviated SHA, a reflog entry, a `^{commit}`
  peel) cannot express "the place the work landed"; and a tag, the stash, or
  a worktree-local ref names something nothing merges into. In every one of
  those cases, pointing the value at the integration HEAD makes the
  reachability check pass trivially. Refusal, not a fallthrough, is what
  closes this.
- **Must not be this run's integration branch.** Compared against the
  resolved ref, including any ref whose full name ends in this run's
  integration branch path, which covers remote-tracking copies of it. A
  branch is always reachable from itself, so such a target could never
  distinguish a performed merge from an unperformed one.

The rule is stated as a property rather than as a list of rejected spellings
deliberately: this check was reopened more than once by closing the specific
spellings that had been demonstrated, while the property they violated
stayed unenforced. Anything failing either half above is refused regardless
of how it is written.

**The limit of what this can prove.** Once a target is a legitimate branch,
the check confirms the integration HEAD is reachable from it — and no local
check can distinguish a real fast-forward merge from someone having pointed
that branch at the same commit. That is an accepted limit, not an oversight:
the two are identical in the repository. What the rules above guarantee is
narrower and still worth having — the target names somewhere work can land,
it is not the run's own integration line, and so the check cannot be
satisfied *by construction, before any action occurs*.

`keep`, `discard`, and `pr` require no target. `pr` is deliberately
excluded: its meaningful evidence is the remote pull request, which this
transport cannot check without network access, so it stays on the
bounded-evidence path rather than pretending to a guarantee it cannot make.

## Cleanup safety

Finishing is two-phase: `choose-finish` records the exact choice/target
while the integration worktree still exists; `complete-finish` (or, for
discard, supervisor-owned `cleanup --mode discard`) verifies before
claiming completion. Discard never lets a methodology skill delete
anything — `cleanup --mode discard` runs from the original repository,
validates the pre-recorded discard decision, refuses if any run worktree is
dirty, and only then removes proven-clean worktrees and this run's own
branches. Both cleanup modes refuse to run from a cwd inside a worktree
they would remove, and both prune stale worktree registrations before
deleting branches so a worktree whose directory vanished out of band does
not dead-end the command.

Optional post-completion cleanup requires a fresh decision file and never
removes the kept integration worktree/branch. A leftover task worktree that
is still dirty is left completely intact — both the worktree and its branch
— and reported under `cleanup.json`'s `skipped` array rather than failing
the command.

## Receipts

Every task receipt is host-authenticated: `thread_id`/`usage` from the
Codex JSONL accumulator, `commit`/`actual_changed_files`/`ownership_valid`
from git, `process_exit_code` from the child process,
`host_verification` from `verify.mjs`. The model's own claim sits
quarantined under `report` — nothing from it is ever merged upward into a
host-derived field.
