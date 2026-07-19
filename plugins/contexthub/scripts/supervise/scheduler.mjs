// scheduler.mjs — wave scheduling and the per-task execution pipeline for
// /contexthub:supervise.
//
// THE CENTRAL DESIGN DECISION (see beginTrackedOperation below).
//
// state.mjs's reducer requires `event.operation = {pid, startedAt, kind}`
// with a POSITIVE INTEGER pid on every child-launching transition
// (START_GRADING, RUN_WAVE_1, RUN_WAVE_2, START_VERIFY, and the no-gap
// ACCEPT_REVIEW branch) — and its own module comment says that operation
// must be persisted "before the child is spawned." Those two requirements
// cannot both be satisfied literally: a pid does not exist until spawn, so
// nothing can be persisted with a real pid before spawn happens.
//
// This file resolves that tension ONCE, in `beginTrackedOperation`, and
// every one of the five edges is expected to go through it unchanged:
// SPAWN, THEN IMMEDIATELY PERSIST, under the run lock, before any other
// async work happens. The window between "spawn returned a pid" and "the
// ledger write completed" is bounded by exactly one synchronous
// `spawnChild()` call plus one atomic, fsync'd `updateRun` write — typically
// sub-millisecond, and never includes reading output, waiting for exit, or
// running a pool. A crash inside that window is the one case recovery
// cannot see; every other window (spawn to completion, or completion to the
// next transition) is fully covered by `RECOVER_INTERRUPTED`'s
// reconciliation requirement. This is the same trade the brief's own
// "spawn-then-immediately-persist... accepting a bounded, documented
// window" resolution names, applied literally and identically everywhere.
//
// WHAT "pid" MEANS ON EACH EDGE. `START_GRADING` launches exactly one Codex
// child — `spawnChild` there IS the real `child_process.spawn`, and `pid` is
// that child's real OS pid. `RUN_WAVE_1`, `RUN_WAVE_2`, and `START_VERIFY`
// (and ACCEPT_REVIEW's no-gap branch, which enters VERIFYING the same way
// START_VERIFY does) each launch a POOL of independent children (worker
// worktrees, or a set of verification commands) — there is no single "the"
// child pid to record for those. For those edges `spawnChild` returns
// `{ pid: process.pid }`: the HOST'S OWN pid, representing "this Node
// process is currently orchestrating the wave/verification set." This is
// not a fiction — it is exactly the process whose crash `RECOVER_INTERRUPTED`
// needs to detect, and the ledger's `operation.pid` was only ever a
// liveness/crash HINT, never the source of truth for "did work happen"
// (that is always re-derived from git, per every module in this system).
// Individual worker pids are instead visible in each task's own verification
// logs/receipts, which is where per-task provenance actually belongs.
//
// Task 9 itself calls this helper from `executeWave` (for RUN_WAVE_1 /
// RUN_WAVE_2, when a caller opts in via `options.operationTracking`) — the
// one edge Task 9 owns end to end. Task 10, which owns the top-level
// phase-by-phase orchestrator, MUST reuse this exact helper, unmodified, for
// START_GRADING, START_VERIFY, and ACCEPT_REVIEW's no-gap branch rather than
// re-deriving the spawn/persist ordering a second, third, and fourth time.
//
// Node 20+ standard library only.

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";

import { ContractError, pathsOverlap, validateWorkerReport } from "./contracts.mjs";
import {
  createTaskWorktree, inspectTaskChanges, createTaskCommit, inspectTaskCommit,
  assertCommitOwnership, createCandidateIntegration, integrateCandidateCommit,
  abortCandidateIntegration, publishCandidateIntegration, readHead,
} from "./git.mjs";
import { runVerificationSet } from "./verify.mjs";
import { runCodex, isRetryable, isSupportedModel, isSupportedEffort } from "./codex.mjs";

export class SchedulerError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchedulerError";
  }
}

// --------------------------------------------------------------------------
// beginTrackedOperation — the central helper (see module comment above)
// --------------------------------------------------------------------------

// `spawnChild` is called synchronously-or-awaited exactly once, IMMEDIATELY
// followed by exactly one `updateRunFn` call — nothing else runs in
// between. `spawnChild()` must resolve to an object with a positive integer
// `.pid`; `updateRunFn` must be a function that performs the actual
// `state.mjs:updateRun(repoInfo, runId, event)` call (injected rather than
// imported directly, so this file never has to duplicate state.mjs's own
// locking/atomicity — it only has to call it at the right moment).
export async function beginTrackedOperation(options) {
  const { updateRunFn, eventType, kind, buildEventExtras, spawnChild } = options ?? {};
  if (typeof spawnChild !== "function") {
    throw new SchedulerError("beginTrackedOperation: options.spawnChild must be a function returning (or resolving to) { pid }");
  }
  if (typeof updateRunFn !== "function") {
    throw new SchedulerError("beginTrackedOperation: options.updateRunFn must be a function that persists the event (e.g. state.mjs's updateRun bound to repoInfo/runId)");
  }
  if (typeof eventType !== "string" || eventType.length === 0) {
    throw new SchedulerError("beginTrackedOperation: options.eventType is required");
  }
  if (typeof kind !== "string" || kind.length === 0) {
    throw new SchedulerError("beginTrackedOperation: options.kind is required");
  }

  const startedAt = new Date().toISOString();
  const spawned = await spawnChild(); // the ONLY thing that happens before persistence
  if (!spawned || !Number.isInteger(spawned.pid) || spawned.pid <= 0) {
    throw new SchedulerError("beginTrackedOperation: spawnChild() must resolve to an object with a positive integer .pid");
  }
  const extras = typeof buildEventExtras === "function" ? buildEventExtras() : {};
  const operation = { pid: spawned.pid, startedAt, kind };
  const event = { type: eventType, ...extras, operation };
  // IMMEDIATELY persisted — no verification, no pool execution, no output
  // reading happens between spawn and this call.
  const run = await updateRunFn(event);
  return { spawned, run, operation };
}

// --------------------------------------------------------------------------
// getRunnableTasks
// --------------------------------------------------------------------------

// WAVE IS THE PRIMARY FILTER, NOT depends_on.
//
// This previously filtered on `depends_on` alone. But `assertParallelSafe`
// rejects ANY task with a non-empty `depends_on`, so for every graph the
// system actually accepts, the dependency clause is vacuously true and this
// degenerated to "every incomplete task" — including WAVE-2 tasks while
// wave 1 was still running. The defect was invisible because its only test
// used `depends_on: ["t1"]`, a shape no accepted graph can contain.
//
// v6's real runnability rule is the wave boundary: a task is runnable in
// wave N when it belongs to wave N and has not already completed. The
// dependency clause is retained beneath it as defense in depth — it is
// vacuous for accepted graphs by construction, but keeping it means this
// function stays correct rather than merely lucky if the wave model ever
// widens.
//
// `wave` is REQUIRED. Making it optional would preserve exactly the
// silently-wrong behavior this fix exists to remove.
export function getRunnableTasks(graph, completedTaskIds, wave) {
  if (wave !== 1 && wave !== 2) {
    throw new SchedulerError(`getRunnableTasks: wave must be 1 or 2, got ${JSON.stringify(wave)} — filtering without a wave silently returns tasks from BOTH waves`);
  }
  const completed = new Set(completedTaskIds ?? []);
  const tasks = graph?.tasks ?? [];
  return tasks.filter((t) => {
    // A correction graph's tasks carry no `wave` field of their own (the
    // graph itself is `wave: 2`), so an absent per-task wave is treated as
    // belonging to the graph's wave rather than excluded.
    const taskWave = t.wave ?? graph?.wave ?? wave;
    if (taskWave !== wave) return false;
    if (completed.has(t.id)) return false;
    return (t.depends_on ?? []).every((d) => completed.has(d));
  });
}

// --------------------------------------------------------------------------
// assertParallelSafe
// --------------------------------------------------------------------------

// Independently re-derives, from the exported public primitives
// (contracts.mjs's `pathsOverlap` — the dependency-hygiene/max-effort
// internals in contracts.mjs are not exported, on purpose, so this is not a
// copy of private code, it is the same policy re-expressed against the
// public surface), the three properties every accepted wave must have
// BEFORE a single worktree is created: no same-wave dependencies (v6 has
// exactly two waves and every task in a wave starts from the same base
// commit, so any depends_on is unsound by construction — combine dependent
// work into one task instead), at most one "max"-effort task, and no
// overlapping write ownership between any two tasks in the wave.
export function assertParallelSafe(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new SchedulerError("assertParallelSafe: tasks must be a non-empty array");
  }
  for (const t of tasks) {
    if (!Array.isArray(t.depends_on) || t.depends_on.length > 0) {
      throw new SchedulerError(`assertParallelSafe: task "${t.id}" has a non-empty depends_on — every task in a wave starts from the same base commit, so a same-wave dependency is unsound; combine the dependent changes into one work order instead`);
    }
  }
  const maxTasks = tasks.filter((t) => t.effort === "max");
  if (maxTasks.length > 1) {
    throw new SchedulerError(`assertParallelSafe: ${maxTasks.length} tasks at effort "max" in one wave (${maxTasks.map((t) => t.id).join(", ")}); at most one "max" task is permitted per wave`);
  }
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      for (const wa of tasks[i].write_paths) {
        for (const wb of tasks[j].write_paths) {
          if (pathsOverlap(wa, wb)) {
            throw new SchedulerError(`assertParallelSafe: tasks "${tasks[i].id}" and "${tasks[j].id}" have overlapping write ownership at "${wa}" / "${wb}" and cannot share a wave`);
          }
        }
      }
    }
  }
  return true;
}

// --------------------------------------------------------------------------
// recommendedConcurrency
// --------------------------------------------------------------------------

// The plan's global constraint, verbatim: "Run at most three Codex workers
// concurrently." This is a HARD CEILING, not advice — every concurrency
// decision in this file passes through `clampConcurrency` below, so no
// caller-supplied value and no default can exceed it. Exported so the bound
// is a shared symbol rather than a number re-derived from prose in each
// call site (the same discipline codex.mjs applies to its own policy
// constants).
export const MAX_WORKER_CONCURRENCY = 3;

export function recommendedConcurrency(score) {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new SchedulerError(`recommendedConcurrency: score must be an integer 1-5, got ${JSON.stringify(score)}`);
  }
  if (score === 1) return 1;
  if (score <= 3) return 2;
  return MAX_WORKER_CONCURRENCY;
}

// The single chokepoint that enforces MAX_WORKER_CONCURRENCY.
//
// `executeWave` previously fell back to `tasks.length` when `concurrency`
// was omitted and honored any integer when it was supplied — so a 6-task
// wave with no explicit concurrency launched 6 simultaneous Codex workers,
// and an explicit `10` was obeyed. `recommendedConcurrency` capped at 3 but
// nothing ever called it or clamped against it. Both paths now clamp here.
export function clampConcurrency(requested, taskCount) {
  const ceiling = Math.min(MAX_WORKER_CONCURRENCY, Math.max(1, taskCount));
  if (!Number.isInteger(requested) || requested < 1) return ceiling;
  return Math.min(requested, ceiling);
}

// --------------------------------------------------------------------------
// runPool — bounded-concurrency executor
// --------------------------------------------------------------------------

// Every item runs to completion regardless of sibling failures (captured as
// { ok:false, error } rather than aborting the pool) — a wave's ownership
// and integration safety come entirely from what `executeWave` does with
// each item's OUTCOME, not from cancelling siblings when one item throws.
export async function runPool(items, limit, worker) {
  if (!Array.isArray(items)) {
    throw new SchedulerError("runPool: items must be an array");
  }
  if (items.length === 0) return [];
  const concurrency = Number.isInteger(limit) && limit > 0 ? Math.min(limit, items.length) : 1;

  const results = new Array(items.length);
  let nextIndex = 0;
  async function runOne() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runOne()));
  return results;
}

// --------------------------------------------------------------------------
// assertReportVerificationCoverage — carry-forward #5 (verification-ID
// cross-check)
// --------------------------------------------------------------------------

// contracts.mjs:validateWorkerReport(value, acceptanceIds) has NO parameter
// for a task's declared `verify` IDs — it only checks the report's OWN
// verification array for internal shape/coherence. A worker can therefore
// report `status: "DONE"` with `verification: []` and pass contracts
// validation cleanly, even though the task declared one or more required
// verification commands. This gap is invisible from inside contracts.mjs
// (it has no access to the task graph); closing it is Task 9's job, using
// live task-graph data contracts.mjs never sees.
export function assertReportVerificationCoverage(task, report) {
  const declared = new Set((task?.verify ?? []).map((v) => v.id));
  const reported = new Set((report?.verification ?? []).map((v) => v.id));
  const missing = [...declared].filter((id) => !reported.has(id));
  if (missing.length > 0) {
    throw new SchedulerError(
      `assertReportVerificationCoverage: task "${task?.id}" worker report does not cover declared verify id(s) [${missing.join(", ")}] `
      + "— validateWorkerReport has no parameter for a task's declared verify IDs, so a report claiming DONE with an empty or partial verification array "
      + "passes contracts.mjs cleanly; this cross-check against the task graph's own verify list is what closes that gap",
    );
  }
  return true;
}

// --------------------------------------------------------------------------
// buildTaskReceipt — the Step 6 host-authenticated receipt envelope
// --------------------------------------------------------------------------

// The brief's Step 6 specifies this exact envelope shape, and every field in
// it is host-derived: `thread_id`/`usage` from the Codex JSONL accumulator,
// `commit`/`actual_changed_files`/`ownership_valid` from git,
// `process_exit_code` from the child process, `host_verification` from
// verify.mjs. Only the nested `report` is the model's own claim, and it sits
// clearly quarantined under its own key rather than being merged up into
// host-derived fields.
//
// This exists because nothing else produced it: `taskResult` returns a loose
// ad-hoc object, and `checkpoint.mjs:summarizeUsage` consumes a `receipts`
// array that consequently had NO producer anywhere in the system. (The
// brief's Interfaces block omits a receipt builder while its Step 6
// specifies the shape verbatim; the shape is the thing that actually has to
// exist, so it is built here.)
//
// A receipt is emitted for EVERY task, not only successful ones — see the
// usage-preservation note in runOneTaskAndCommit.
export function buildTaskReceipt(input) {
  const {
    taskId, workerOutcome, commit, changedFiles, ownershipValid,
    hostVerification, report,
  } = input ?? {};

  const usage = workerOutcome?.usage ?? null;

  return {
    version: 1,
    task_id: taskId,
    thread_id: workerOutcome?.threadId ?? null,
    usage: usage
      ? {
        input_tokens: usage.inputTokens ?? 0,
        cached_input_tokens: usage.cachedInputTokens ?? 0,
        output_tokens: usage.outputTokens ?? 0,
        reasoning_output_tokens: usage.reasoningOutputTokens ?? 0,
      }
      : null,
    commit: commit ?? null,
    // The ONLY value this field ever takes. A commit in this system is
    // created by the host, after verification, or it does not exist — there
    // is deliberately no vocabulary here for a model-created commit.
    commit_source: commit ? "host-after-verification" : null,
    actual_changed_files: (changedFiles ?? []).slice(),
    ownership_valid: ownershipValid === true,
    process_exit_code: workerOutcome?.processExitCode ?? null,
    // Surfaces codex.mjs's classification (timeout, transport,
    // missing-completion, ...) so it reaches the user instead of dead-ending
    // as an opaque "model-status-missing"/ownership-check reason. There is
    // no retry vocabulary here on purpose (plan line 204 forbids auto-retry)
    // — this is evidence for a human, not a retry trigger.
    failure_category: workerOutcome?.failureCategory ?? null,
    host_verification: (hostVerification ?? []).map((v) => ({
      id: v.id,
      status: v.status,
      exit_code: v.exitCode ?? null,
      log_path: v.logPath ?? null,
    })),
    report: report ?? null,
  };
}

// --------------------------------------------------------------------------
// Per-task pipeline (internal) — the host-authoritative sequence between a
// worker exiting and a task becoming integration-ready.
// --------------------------------------------------------------------------

function taskResult(taskId, status, extra = {}) {
  return { taskId, status, ...extra };
}

async function runOneTaskAndCommit(task, ctx) {
  const {
    repoInfo, runId, wave, baseCommit, worktreePaths, runWorker, approvals,
    logsDir, verificationTimeoutMs, resumeExactSourceTaskId,
  } = ctx;

  let wt;
  try {
    wt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave, taskId: task.id, baseCommit, resumeExactSourceTaskId });
  } catch (err) {
    return taskResult(task.id, "BLOCKED", { reason: `worktree-setup-failed:${err.message}`, receipt: buildTaskReceipt({ taskId: task.id }) });
  }

  // COST EVIDENCE IS PRESERVED ON EVERY EXIT PATH.
  //
  // `workerOutcome` used to propagate only on the READY path, so thread ID
  // and token usage were silently discarded for exactly the tasks that spent
  // tokens and produced nothing (ownership failure, verification failure,
  // invalid report, ineligible model status). That undercounted cost
  // precisely where accounting matters most, and contradicted "the host is
  // authoritative for thread ID and usage" — the data was in hand and thrown
  // away. It is now captured in a closure variable the moment the worker
  // returns and folded into a receipt on every single return below.
  let workerOutcome = null;
  let changes = null;
  let verify = null;
  let report = null;

  const receiptFor = ({ commit = null, ownershipValid = false } = {}) => buildTaskReceipt({
    taskId: task.id,
    workerOutcome,
    commit,
    changedFiles: changes?.ok ? changes.changedPaths : [],
    ownershipValid,
    hostVerification: verify?.results ?? [],
    report,
  });

  try {
    // The worker itself is the ONE injected dependency — a real Codex call
    // in production, a fake in tests. Everything after this point is
    // host-derived from git and the (cross-checked) report; nothing here
    // ever trusts workerOutcome.report's claims about WHAT changed.
    workerOutcome = await runWorker(task, { worktreePath: wt.path, baseCommit, branch: wt.branch });

    // WORKER-FAILURE SHORT-CIRCUIT. A non-null failureCategory (timeout,
    // transport, missing-completion, ...) means codex.mjs itself could not
    // get a trustworthy completion out of the worker — there is no report
    // to trust and no reason to believe the worktree reflects a finished
    // attempt. Previously this fell through to ownership derivation and then
    // host verification (build/test commands) against that same
    // untrustworthy partial tree before failing anyway on an unrelated
    // downstream reason (typically "model-status-missing") — paying
    // verification's full cost for a result already known to be void, and
    // burying the actual failure category (see buildTaskReceipt above; it is
    // not auto-retried either way — plan line 204 forbids that — so nothing
    // is lost by failing closed here instead of one step further down).
    if (workerOutcome.failureCategory) {
      return taskResult(task.id, "BLOCKED", {
        reason: `worker-failed:${workerOutcome.failureCategory}`,
        worktreePath: wt.path, branch: wt.branch, workerOutcome, receipt: receiptFor(),
      });
    }

    // Host-authoritative ownership derivation (git.mjs). A worker that
    // stages, moves HEAD, or touches anything outside write_paths is
    // rejected here, before verification or a host commit is ever
    // considered.
    changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit, writePaths: task.write_paths });
    if (!changes.ok) {
      return taskResult(task.id, "BLOCKED", { reason: `ownership-check-failed:${changes.reason}`, worktreePath: wt.path, branch: wt.branch, detail: changes, workerOutcome, receipt: receiptFor() });
    }

    // Host-owned verification, in the worker worktree, after the model
    // exits and before any commit. A non-zero/timeout result, or any
    // mutation of the pre-verification fingerprint, blocks unconditionally
    // — independent of whatever the model claims.
    verify = await runVerificationSet({
      commands: task.verify,
      worktreePath: wt.path,
      approvals,
      logDir: join(logsDir, "verification"),
      logPrefix: task.id,
      timeoutMs: verificationTimeoutMs,
      snapshotBefore: changes.fingerprint,
      snapshotAfterFn: () => {
        const after = inspectTaskChanges({ worktreePath: wt.path, baseCommit, writePaths: task.write_paths });
        return after.ok ? after.fingerprint : `INVALID:${after.reason}`;
      },
    });
    if (!verify.allPass) {
      return taskResult(task.id, "BLOCKED", { reason: verify.residue ? "verification-diff-residue" : "verification-failed", worktreePath: wt.path, branch: wt.branch, verify, workerOutcome, receipt: receiptFor() });
    }

    // Re-validate the model's report shape independently (defense in
    // depth — a fake/broken `runWorker` must not be able to smuggle an
    // unvalidated report past this pipeline just because it constructed the
    // object in-process rather than parsing it from JSON), then close the
    // verification-ID gap contracts.mjs cannot see.
    const rawReport = workerOutcome?.report ?? null;
    if (rawReport !== null) {
      try {
        report = validateWorkerReport(rawReport, task.acceptance_ids);
      } catch (err) {
        return taskResult(task.id, "BLOCKED", { reason: `invalid-worker-report:${err.message}`, worktreePath: wt.path, branch: wt.branch, verify, workerOutcome, receipt: receiptFor() });
      }
      // The coverage cross-check only makes sense for a report CLAIMING
      // success — NEEDS_CONTEXT/BLOCKED explicitly means "did not get far
      // enough to verify," so an empty verification array there is
      // expected, not a gap to close.
      if (report.status === "DONE" || report.status === "DONE_WITH_CONCERNS") {
        assertReportVerificationCoverage(task, report);
      }
    }

    const reportStatus = report?.status ?? null;
    if (reportStatus !== "DONE" && reportStatus !== "DONE_WITH_CONCERNS") {
      // NEEDS_CONTEXT and BLOCKED (and a missing report entirely) never
      // commit or integrate.
      return taskResult(task.id, "BLOCKED", { reason: `model-status-${reportStatus ?? "missing"}`, worktreePath: wt.path, branch: wt.branch, verify, report, workerOutcome, receipt: receiptFor() });
    }

    // Only now — ownership proven, host verification passed, model status
    // eligible — does the host create the one, single, host-owned commit.
    const commitInfo = createTaskCommit({
      repoInfo, worktreePath: wt.path, baseCommit, writePaths: task.write_paths,
      runId, taskId: task.id, expectedFingerprint: changes.fingerprint,
    });

    const commitInspect = inspectTaskCommit({ worktreePath: wt.path, baseCommit, commit: commitInfo.commit });
    if (!commitInspect.ok) {
      return taskResult(task.id, "BLOCKED", { reason: "commit-not-clean-or-not-single", worktreePath: wt.path, branch: wt.branch, commitInspect, workerOutcome, receipt: receiptFor({ commit: commitInfo.commit }) });
    }
    const ownership = assertCommitOwnership({
      worktreePath: wt.path, baseCommit, commit: commitInfo.commit, writePaths: task.write_paths, expectedFingerprint: changes.fingerprint,
    });

    return taskResult(task.id, "READY", {
      commit: commitInfo.commit, worktreePath: wt.path, branch: wt.branch, verify, changes, workerOutcome, report,
      receipt: buildTaskReceipt({
        taskId: task.id,
        workerOutcome,
        commit: commitInfo.commit,
        // Ownership comes from the FINISHED commit's own diff, not from the
        // pre-commit working-tree scan — the authoritative record of what
        // actually landed.
        changedFiles: ownership.files,
        ownershipValid: true,
        hostVerification: verify.results,
        report,
      }),
    });
  } catch (err) {
    return taskResult(task.id, "BLOCKED", { reason: `exception:${err.message}`, worktreePath: wt.path, branch: wt.branch, workerOutcome, receipt: receiptFor() });
  }
}

// --------------------------------------------------------------------------
// executeWave — Step 4
// --------------------------------------------------------------------------

// WAVE-LEVEL ALL-OR-NOTHING. If ANY task in the wave fails — ownership,
// host verification, invalid report, or model status — the wave integrates
// NOTHING. No candidate is built, no publish occurs, and the real
// integration ref stays byte-for-byte at its recorded pre-wave HEAD.
//
// The plan text governs here; this was decided and is not to be
// relitigated. Line 1570 reads "one worker failure integrates no commits
// FROM THAT WAVE" (not "from that worker"), and line 1572 speaks of
// "successful WAVES" integrating — the wave, not the task, is the unit that
// succeeds. A per-task reading also makes line 1570 unfalsifiable: a failed
// worker has no commit, so trivially none of its commits integrate, which
// cannot be what a bullet listed among falsifiable properties intends.
//
// The safety argument, beyond the plan text: `assertParallelSafe` guarantees
// disjoint write_paths, so a partial wave would merge CLEANLY — but clean is
// not coherent. Task A's tests may assume Task B's change. All-or-nothing
// preserves the invariant that the integration branch only ever holds
// complete, fully-verified waves.
//
// SUCCESSFUL WORK IS WITHHELD, NEVER DESTROYED. Every task that succeeded
// still gets its host commit created, and that commit survives on its
// private `carefully-crafted/<run-id>/w<wave>-<task-id>` branch (plan line
// 1571: "successful commits survive for recovery and are not rerun
// unnecessarily"). A later wave or a recovery pass can cherry-pick it
// without re-spending a worker. `readyTaskIds` on the return value names
// exactly those commits.
//
// TWO DISTINCT ALL-OR-NOTHING PATHS, DELIBERATELY KEPT SEPARATE:
//
//   1. WORKER FAILURE (this gate, `waveOutcome:
//      "BLOCKED_BY_TASK_FAILURE"`): a task never produced a verified commit.
//      Detected before any candidate exists, so no candidate is created at
//      all — there is nothing to abort.
//   2. CANDIDATE CHERRY-PICK CONFLICT (`waveOutcome:
//      "BLOCKED_BY_CANDIDATE_CONFLICT"`): every task succeeded, but their
//      commits cannot be composed onto the current integration HEAD. The
//      candidate DOES exist and must be aborted and removed, leaving the
//      real integration ref untouched (see git.mjs's
//      abortCandidateIntegration and the regression tests in
//      tests/unit/supervise-git.test.mjs).
//
// Publication itself is a single `git merge --ff-only` from the clean
// integration worktree, run only after every candidate cherry-pick has
// succeeded.
//
// `resumeExactMap` (taskId -> sourceTaskId) drives ONLY worktree-path reuse
// (git.mjs's clean-remove/recreate rule) — it must already reflect
// `effectiveSessionPolicy`'s resolution, not a task's raw `session_policy`
// field. A caller (Task 10) building this map is expected to include an
// entry ONLY when `effectiveSessionPolicy(task, preflight) === "resume-exact"`;
// if preflight found resume unsupported and the caller still passed the raw
// "resume-exact" intent through unchanged, the worktree would be reused for
// a task that `buildCodexWorker` is (correctly) about to run FRESH — a
// pointless and confusing path reuse with no actual Codex resume behind it.
export async function executeWave(options) {
  const {
    repoInfo, runId, wave, tasks, baseCommit, worktreePaths, concurrency,
    integrationWorktreePath, runWorker, approvals = {}, logsDir,
    verificationTimeoutMs, resumeExactMap = {}, operationTracking,
  } = options ?? {};

  if (wave !== 1 && wave !== 2) {
    throw new SchedulerError(`executeWave: options.wave must be 1 or 2, got ${JSON.stringify(wave)}`);
  }
  if (typeof runWorker !== "function") {
    throw new SchedulerError("executeWave: options.runWorker must be a function");
  }
  assertParallelSafe(tasks);

  // IDENTITY IS CHECKED BEFORE DISPATCH, NOT AT COMMIT TIME.
  //
  // `createTaskCommit` also refuses without a usable identity, but that is
  // the LAST step of a task — by then the full worker cost for the entire
  // wave has already been paid, and every task fails identically for a
  // reason that was knowable before any of them started. The brief requires
  // a usable author/committer identity "before worker dispatch"; this is
  // that gate. `inspectRepository` already computed it and supplies an
  // actionable message, so this surfaces the prerequisite error verbatim
  // rather than inventing a second wording for the same condition.
  if (repoInfo && repoInfo.identityOk === false) {
    throw new SchedulerError(`executeWave: refusing to dispatch workers — ${repoInfo.prerequisiteError ?? "Git author/committer identity is not usable"}`);
  }

  // BASE-COMMIT OWNERSHIP LANDS HERE.
  //
  // git.mjs deliberately defers the base rule to "the scheduler", and
  // executeWave previously deferred it to *its* caller, so no layer actually
  // owned it. This is the layer that can check it: a wave's tasks branch
  // from `baseCommit`, and the candidate is built on the integration
  // worktree's current HEAD, so those two must agree — otherwise every task
  // commit is rooted somewhere the candidate cannot fast-forward from, and
  // the only symptom is a whole-wave discard at integration time, long after
  // the cost is spent.
  //
  // Wave 1: baseCommit MUST equal the current integration HEAD (the
  // post-planning HEAD). Wave 2: the same equality holds, because by then
  // the integration HEAD *is* the fully-integrated wave-one HEAD. A caller
  // that genuinely intends to run against a stale base (recovery replay,
  // some deliberate re-run) must say so explicitly via `allowBaseDrift`
  // rather than having it pass silently.
  const integrationHeadAtStart = readHead(integrationWorktreePath);
  if (baseCommit !== integrationHeadAtStart && options.allowBaseDrift !== true) {
    throw new SchedulerError(
      `executeWave: wave-${wave} baseCommit ${baseCommit} does not match the integration worktree HEAD ${integrationHeadAtStart}. `
      + `Wave-one tasks must branch from the post-planning integration HEAD and wave-two tasks from the fully-integrated wave-one HEAD; `
      + `a mismatched base surfaces only as a whole-wave discard at integration time. Pass allowBaseDrift: true to override deliberately.`,
    );
  }

  // Central design decision, applied here (see the module header). Only
  // engaged when the caller opts in — scheduler.mjs tests that only care
  // about wave semantics do not need a run ledger at all.
  if (operationTracking) {
    await beginTrackedOperation({
      updateRunFn: operationTracking.updateRunFn,
      eventType: operationTracking.eventType,
      kind: operationTracking.kind ?? `wave-${wave}`,
      buildEventExtras: operationTracking.buildEventExtras,
      // Wave launches have no single child pid to record (see the module
      // header) — the host's own process IS the tracked operation.
      spawnChild: () => ({ pid: process.pid }),
    });
  }

  // Item 3's hard cap: an omitted `concurrency` no longer means
  // "tasks.length", and an over-cap request is clamped rather than honored.
  const effectiveConcurrency = clampConcurrency(concurrency, tasks.length);

  const outcomes = await runPool(tasks, effectiveConcurrency, (task) => runOneTaskAndCommit(task, {
    repoInfo, runId, wave, baseCommit, worktreePaths, runWorker, approvals, logsDir,
    verificationTimeoutMs, resumeExactSourceTaskId: resumeExactMap[task.id] ?? null,
  }));

  const taskResults = outcomes.map((o, i) => (o.ok
    ? o.value
    : taskResult(tasks[i].id, "BLOCKED", { reason: `internal-error:${o.error?.message ?? "unknown"}`, receipt: buildTaskReceipt({ taskId: tasks[i].id }) })));

  const readyResults = taskResults
    .filter((r) => r.status === "READY")
    .sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const failedResults = taskResults.filter((r) => r.status !== "READY");

  const preWaveHead = readHead(integrationWorktreePath);
  const readyTaskIds = readyResults.map((r) => r.taskId);

  // THE WAVE-LEVEL ALL-OR-NOTHING GATE (see the header above).
  //
  // Placed BEFORE candidate creation on purpose: when a task has failed
  // there is nothing to compose, so the correct behavior is to never build a
  // candidate rather than to build one and abort it. That also keeps this
  // path structurally distinct from the candidate-conflict path below, which
  // genuinely does have a candidate to clean up.
  //
  // Note what is NOT done here: the successful tasks keep their "READY"
  // status and their commits. Integration is withheld; the work is not
  // discarded, retro-marked as failed, or deleted. `readyTaskIds` tells a
  // caller exactly which commits are sitting on task branches, available to
  // a later wave or a recovery pass without re-spending a worker.
  if (failedResults.length > 0) {
    return {
      wave,
      taskResults,
      integratedTaskIds: [],
      readyTaskIds,
      failedTaskIds: failedResults.map((r) => r.taskId),
      integrationHead: preWaveHead,
      published: false,
      conflict: null,
      waveOutcome: "BLOCKED_BY_TASK_FAILURE",
    };
  }

  // Unreachable in practice — assertParallelSafe rejects an empty task array,
  // so with zero failures there is always at least one ready task — but kept
  // as an explicit, typed outcome rather than falling through to candidate
  // creation with nothing to pick.
  if (readyResults.length === 0) {
    return {
      wave, taskResults, integratedTaskIds: [], readyTaskIds: [], failedTaskIds: [],
      integrationHead: preWaveHead, published: false, conflict: null, waveOutcome: "NO_TASKS",
    };
  }

  // TASK RESULTS ARE NEVER LOST TO AN INTEGRATION-PHASE THROW.
  //
  // Candidate creation and publication were previously unguarded, so ANY
  // throw — a ledger collision left by a prior crashed wave, the
  // expectedPreHead drift check, a failed `worktree remove` even AFTER a
  // successful merge — propagated out of executeWave and discarded the
  // entire taskResults array with it. Commits survive on their task
  // branches, but reports, usage, thread IDs, verification results, and log
  // paths do not, and none of that is re-derivable from git. Everything from
  // here on therefore returns a result carrying taskResults rather than
  // throwing.
  const integrationFailure = (reason, err, extra = {}) => ({
    wave,
    taskResults,
    integratedTaskIds: [],
    readyTaskIds,
    failedTaskIds: [],
    integrationHead: preWaveHead,
    published: false,
    conflict: null,
    waveOutcome: "BLOCKED_BY_INTEGRATION_ERROR",
    integrationError: { reason, message: err?.message ?? String(err) },
    ...extra,
  });

  let candidate;
  try {
    candidate = createCandidateIntegration({ repoInfo, runId, worktreePaths, wave, integrationHead: preWaveHead });
  } catch (err) {
    return integrationFailure("candidate-creation-failed", err);
  }

  const integratedTaskIds = [];
  let conflict = null;

  try {
    for (const r of readyResults) {
      const pick = integrateCandidateCommit({ candidate, commit: r.commit });
      if (!pick.ok) {
        conflict = { taskId: r.taskId, commit: r.commit, stderr: pick.stderr };
        break;
      }
      // An empty pick means this commit's content was ALREADY present on the
      // integration branch (a recovery re-entry, or a content-equivalent
      // change). That is a success, not a conflict — it still counts as
      // integrated, and the wave proceeds.
      integratedTaskIds.push(r.taskId);
    }
  } catch (err) {
    // A throw mid-cherry-pick leaves the candidate in an unknown state; try
    // to clean it up so the next attempt is not blocked by the idempotency
    // gate, but never let cleanup failure mask the original error.
    try {
      abortCandidateIntegration({ repoInfo, candidate, reason: `exception during candidate integration: ${err.message}` });
    } catch { /* cleanup is best-effort — the original failure is what matters */ }
    return integrationFailure("candidate-integration-threw", err);
  }

  if (conflict) {
    const logPath = join(logsDir, `candidate-w${wave}-conflict.log`);
    try {
      abortCandidateIntegration({ repoInfo, candidate, logPath, reason: `cherry-pick conflict on task "${conflict.taskId}" (commit ${conflict.commit})` });
    } catch (err) {
      return integrationFailure("candidate-abort-failed", err, { conflict, candidateLogPath: logPath });
    }

    // Every READY task's commit — including the ones that cherry-picked
    // successfully into the now-discarded candidate — did not, in fact,
    // integrate. This is the byte-for-byte-unchanged proof surfaced at the
    // task-result level: nothing here is marked integrated.
    const readyIds = new Set(readyResults.map((r) => r.taskId));
    const finalTaskResults = taskResults.map((r) => (readyIds.has(r.taskId)
      ? { ...r, status: "BLOCKED", reason: r.taskId === conflict.taskId ? "candidate-cherry-pick-conflict" : "candidate-integration-aborted-by-sibling-conflict" }
      : r));

    return {
      wave,
      taskResults: finalTaskResults,
      integratedTaskIds: [],
      // The commits still exist on their task branches here too — the
      // candidate was discarded, not the work. Reported from the pre-conflict
      // ready set so a recovery pass can still find them.
      readyTaskIds,
      failedTaskIds: [],
      integrationHead: preWaveHead,
      published: false,
      conflict,
      // Deliberately a DIFFERENT outcome from BLOCKED_BY_TASK_FAILURE: every
      // task succeeded, but their commits could not be composed.
      waveOutcome: "BLOCKED_BY_CANDIDATE_CONFLICT",
      candidateLogPath: logPath,
    };
  }

  let publish;
  try {
    publish = publishCandidateIntegration({ repoInfo, integrationWorktreePath, candidate, expectedPreHead: preWaveHead });
  } catch (err) {
    // THE PRE-CHECK PATH LEAKS IF NOT CLEANED UP. When publication fails
    // BEFORE the merge (the expectedPreHead drift check, or the clean-status
    // check), the candidate worktree, branch, and ledger entry all survive —
    // and the next attempt at this same wave then fails the idempotency
    // gate on a collision it can't explain. Clean up so a retry starts
    // fresh. Whether the merge itself already landed is determined by
    // comparing HEAD, not assumed: if it did, the candidate is now an
    // ancestor and removing it is still correct.
    try {
      abortCandidateIntegration({ repoInfo, candidate, reason: `publication failed: ${err.message}` });
    } catch { /* best-effort cleanup */ }

    // A post-merge failure (e.g. `worktree remove` failing after the merge
    // already succeeded) must NOT be reported as an unpublished wave — the
    // integration branch genuinely moved. Re-read HEAD and report honestly.
    let headNow = preWaveHead;
    try {
      headNow = readHead(integrationWorktreePath);
    } catch { /* fall back to preWaveHead */ }

    if (headNow !== preWaveHead) {
      return {
        wave,
        taskResults,
        integratedTaskIds,
        readyTaskIds,
        failedTaskIds: [],
        integrationHead: headNow,
        published: true,
        conflict: null,
        // The wave genuinely published; only cleanup failed.
        waveOutcome: "PUBLISHED",
        integrationError: { reason: "post-merge-cleanup-failed", message: err.message },
      };
    }
    return integrationFailure("publish-failed", err);
  }

  return {
    wave,
    taskResults,
    integratedTaskIds,
    readyTaskIds,
    failedTaskIds: [],
    integrationHead: publish.head,
    published: true,
    conflict: null,
    waveOutcome: "PUBLISHED",
  };
}

// --------------------------------------------------------------------------
// effectiveSessionPolicy / buildCodexWorker — carry-forwards #6-#9 from the
// Task 8 review.
//
// executeWave's `runWorker` is an injected dependency ON PURPOSE — every
// wave-semantics test above proves ownership/verification/atomicity with a
// trivial fake, exactly the way Task 8's own suite drives a fake `codex`
// binary rather than asserting through a live network call. But leaving
// `runWorker` a fully opaque callback would mean nothing in Task 9 ever
// actually exercises codex.mjs's exported surface, and four carry-forwards
// are specifically about consuming that surface correctly:
//
//   #6  query allowlists through isRetryable()/isSupportedModel()/
//       isSupportedEffort() — never reconstruct a Set from the frozen
//       arrays.
//   #7  branch on checkCodexPrerequisites().resumeSupported and fall back
//       to session_policy "fresh" when false — runCodex will build a
//       resume argv regardless of what preflight found.
//   #8  a fresh outputPath per attempt — never reused across a retry or
//       correction.
//   #9  never mutate the frozen requiredSkills array; missingSkills is a
//       fresh per-call array a caller may treat as its own.
//
// `buildCodexWorker` is the real, carry-forward-compliant `runWorker`
// implementation, built once from a single prior `checkCodexPrerequisites()`
// result (never re-probed per task — that would be one spawn per task just
// to ask the same question). Task 10 uses this, unmodified, as
// `executeWave`'s `options.runWorker` for real dispatch; it is exported and
// tested here specifically so the carry-forwards are enforced inside Task 9,
// not left as an unverified assumption about whatever Task 10 eventually
// writes.
// --------------------------------------------------------------------------

// A wave-two task's `session_policy` is ONLY ever honored as "resume-exact"
// when the run's own preflight already proved resume is supported; anything
// else — no session_policy at all (a wave-one task), an explicit "fresh", or
// resume genuinely unsupported — resolves to "fresh". This is a pure
// function so the fallback rule is independently testable without spawning
// anything.
export function effectiveSessionPolicy(task, preflight) {
  if (task?.session_policy !== "resume-exact") return "fresh";
  if (!preflight || preflight.resumeSupported !== true) return "fresh";
  return "resume-exact";
}

export function buildCodexWorker(options) {
  const {
    schemaPath, buildPrompt, logsDir, model, preflight,
    resumeThreadIdFor, codexBin, spawnImpl, env,
  } = options ?? {};

  if (typeof buildPrompt !== "function") {
    throw new SchedulerError("buildCodexWorker: options.buildPrompt(task, ctx) -> prompt string is required");
  }
  if (typeof schemaPath !== "string" || schemaPath.length === 0) {
    throw new SchedulerError("buildCodexWorker: options.schemaPath is required");
  }
  if (typeof logsDir !== "string" || logsDir.length === 0) {
    throw new SchedulerError("buildCodexWorker: options.logsDir is required");
  }
  if (!preflight || typeof preflight !== "object") {
    throw new SchedulerError("buildCodexWorker: options.preflight (a prior checkCodexPrerequisites() result) is required — resume support is decided once per run, never re-probed per task");
  }
  if (!isSupportedModel(model)) {
    throw new SchedulerError(`buildCodexWorker: options.model ${JSON.stringify(model)} is not in codex.mjs's SUPPORTED_MODELS — query the allowlist only through isSupportedModel()`);
  }

  const attemptCounters = new Map();

  return async function runWorker(task, ctx) {
    if (!isSupportedEffort(task.effort)) {
      throw new SchedulerError(`buildCodexWorker: task "${task.id}" effort ${JSON.stringify(task.effort)} is not in codex.mjs's SUPPORTED_EFFORTS`);
    }

    const attempt = (attemptCounters.get(task.id) ?? 0) + 1;
    attemptCounters.set(task.id, attempt);

    // carry-forward #8 — a FRESH outputPath every attempt, keyed by task id,
    // attempt number, and a random suffix, so nothing is ever reused across
    // a retry or a wave-two correction of the same task id.
    mkdirSync(logsDir, { recursive: true });
    const outputPath = join(logsDir, `${task.id}-attempt-${attempt}-${randomBytes(4).toString("hex")}.output.json`);
    const logPath = join(logsDir, `${task.id}-attempt-${attempt}.log`);

    // carry-forward #7 — the branch. `runCodex` will happily build a resume
    // argv whenever `resumeThreadId` is non-null, regardless of what
    // preflight found; this is the ONE place that is allowed to produce a
    // non-null resumeThreadId, and it only does so when the resolved policy
    // says "resume-exact".
    const policy = effectiveSessionPolicy(task, preflight);
    const resumeThreadId = policy === "resume-exact" && typeof resumeThreadIdFor === "function"
      ? resumeThreadIdFor(task)
      : null;

    const prompt = buildPrompt(task, ctx);

    const result = await runCodex({
      cwd: ctx.worktreePath,
      prompt,
      schemaPath,
      outputPath,
      logPath,
      model,
      effort: task.effort,
      sandbox: "workspace-write",
      resumeThreadId,
      codexBin,
      spawnImpl,
      env,
    });

    let report = null;
    if (result.finalOutputPath) {
      try {
        report = JSON.parse(readFileSync(result.finalOutputPath, "utf8"));
      } catch {
        report = null; // malformed output is surfaced as a MISSING report, never trusted as-is
      }
    }

    return {
      processExitCode: result.exitCode,
      threadId: result.threadId,
      usage: result.usage,
      failureCategory: result.failureCategory,
      // carry-forward #6 — the ONLY supported membership test.
      retryable: result.failureCategory ? isRetryable(result.failureCategory) : false,
      effectiveSessionPolicy: policy,
      report,
      logPath: result.logPath,
    };
  };
}
