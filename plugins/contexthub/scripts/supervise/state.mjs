// state.mjs — the durable, bounded phase machine for /contexthub:supervise,
// plus atomic on-disk persistence with locking.
//
// Two safety properties this file exists to enforce:
//
//   1. The host is authoritative, the model is not. reduceRun is a strict
//      finite-state machine: every (phase, event) pair not explicitly listed
//      in TRANSITIONS throws. There is no "default" transition and no way to
//      construct a phase value outside the frozen Phase enum.
//
//   2. A third execution wave must not be representable. Phase has no
//      WAVE_3_* member. Exactly one edge produces WAVE_2_RUNNING
//      (REVIEWED --RUN_WAVE_2--> WAVE_2_RUNNING) and nothing transitions
//      back into REVIEWED once wave two has run — `correctionWaveUsed` is
//      belt-and-suspenders on top of that structural fact, not the
//      mechanism itself. See tests/unit/supervise-state.test.mjs for the
//      exhaustive proof (every legal edge enumerated, every other pair
//      proven to throw, plus a dedicated sweep proving no edge targets
//      WAVE_2_RUNNING or REVIEWED except that one).
//
// Node 20+ standard library only.

import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync,
  openSync, closeSync, fsyncSync, chmodSync,
} from "node:fs";

import { ContractError, validateIdentifier } from "./contracts.mjs";

export const Phase = Object.freeze({
  INITIALIZED: "INITIALIZED",
  GRADING: "GRADING",
  GRADED: "GRADED",
  APPROVAL_PENDING: "APPROVAL_PENDING",
  PLANNED: "PLANNED",
  WAVE_1_RUNNING: "WAVE_1_RUNNING",
  WAVE_1_COMPLETE: "WAVE_1_COMPLETE",
  REVIEWED: "REVIEWED",
  WAVE_2_RUNNING: "WAVE_2_RUNNING",
  WAVE_2_COMPLETE: "WAVE_2_COMPLETE",
  CORRECTIONS_REVIEWED: "CORRECTIONS_REVIEWED",
  VERIFYING: "VERIFYING",
  FINISH_PENDING: "FINISH_PENDING",
  FINISH_ACTION_PENDING: "FINISH_ACTION_PENDING",
  COMPLETE: "COMPLETE",
  BLOCKED: "BLOCKED",
});

const NON_TERMINAL_PHASES = Object.values(Phase).filter((p) => p !== Phase.COMPLETE && p !== Phase.BLOCKED);

// --------------------------------------------------------------------------
// Small internal validation helpers (state.mjs re-uses ContractError so
// every boundary in this system fails the same way; it does not mint a
// second error class).
// --------------------------------------------------------------------------

function requireString(v, name) {
  if (typeof v !== "string" || v.length === 0) {
    throw new ContractError(`${name} must be a non-empty string`);
  }
  return v;
}

function requireBoolean(v, name) {
  if (typeof v !== "boolean") {
    throw new ContractError(`${name} must be a boolean`);
  }
  return v;
}

// Every child process this system launches (grader, worker, verification
// run) persists {pid, startedAt, kind} as `run.operation` *before* the child
// is spawned (brief, Step 6) — this is what makes `recover` possible without
// ever inferring success from a vanished PID.
function requireOperation(op) {
  if (!op || typeof op !== "object") {
    throw new ContractError("event.operation is required (persist phase + operation metadata before launching a child)");
  }
  if (!Number.isInteger(op.pid) || op.pid <= 0) {
    throw new ContractError("event.operation.pid must be a positive integer");
  }
  if (typeof op.startedAt !== "string" || Number.isNaN(Date.parse(op.startedAt))) {
    throw new ContractError("event.operation.startedAt must be an ISO timestamp");
  }
  if (typeof op.kind !== "string" || op.kind.length === 0) {
    throw new ContractError("event.operation.kind must be a non-empty string");
  }
  return { pid: op.pid, startedAt: op.startedAt, kind: op.kind };
}

// Recovery from an interrupted running phase must never infer success from a
// vanished PID: it requires the caller to have independently reconciled
// processes, receipts, worktrees, and integration HEAD (brief, Step 5/6).
function requireReconciliation(r) {
  if (!r || typeof r !== "object") {
    throw new ContractError("event.reconciliation is required to recover an interrupted phase");
  }
  for (const key of ["processes", "receipts", "worktrees", "integrationHead"]) {
    if (r[key] !== true) {
      throw new ContractError(`event.reconciliation.${key} must be true — recovery requires reconciling processes, receipts, worktrees, and integration HEAD before relaunching`);
    }
  }
  return { processes: true, receipts: true, worktrees: true, integrationHead: true };
}

const hashBytes = (v) => createHash("sha256").update(typeof v === "string" ? v : Buffer.from(v)).digest("hex");

function blockedPatch(run, fromPhase, event, defaultReason) {
  if (event.evidenceBytes === undefined) {
    throw new ContractError("a BLOCKED transition requires event.evidenceBytes (the artifact recording why)");
  }
  return {
    phase: Phase.BLOCKED,
    operation: null,
    blockedFrom: fromPhase,
    blockEvidence: {
      bytesHash: hashBytes(event.evidenceBytes),
      reason: typeof event.reason === "string" && event.reason.length > 0 ? event.reason : defaultReason,
      recordedAt: new Date().toISOString(),
    },
  };
}

// --------------------------------------------------------------------------
// Transition handlers. Each returns a *patch* merged into the next run
// record; every patch always names an explicit `phase` (never inherited
// implicitly), so the transition table below is a complete, literal map of
// every state this machine can ever be in.
// --------------------------------------------------------------------------

function handleStartGrading(run, event) {
  return { phase: Phase.GRADING, operation: requireOperation(event.operation) };
}

function handleGradingComplete(run, event) {
  return { phase: Phase.GRADED, operation: null, complexityRef: requireString(event.complexityRef, "event.complexityRef") };
}

function handleRecoverInterrupted(run, event) {
  requireReconciliation(event.reconciliation);
  return { phase: run.phase, operation: requireOperation(event.operation) };
}

function handleAcceptPlan(run, event) {
  const baseCommit = requireString(event.baseCommit, "event.baseCommit");
  if (!Array.isArray(event.approvalIds)) {
    throw new ContractError("event.approvalIds must be an array (may be empty)");
  }
  event.approvalIds.forEach((id) => validateIdentifier("approval", id));
  const approvals = Object.fromEntries(event.approvalIds.map((id) => [id, "PENDING"]));
  const phase = event.approvalIds.length === 0 ? Phase.PLANNED : Phase.APPROVAL_PENDING;
  return { phase, baseCommit, approvals };
}

function handleDecideApproval(run, event) {
  validateIdentifier("approval", event.id);
  if (event.decision !== "APPROVED" && event.decision !== "REJECTED") {
    throw new ContractError(`event.decision must be "APPROVED" or "REJECTED", got ${JSON.stringify(event.decision)}`);
  }
  const current = run.approvals?.[event.id];
  if (current === undefined) {
    throw new ContractError(`decide-approval: unknown approval id "${event.id}"`);
  }
  // Idempotent repeat of the same decision succeeds harmlessly; a different
  // decision on an already-decided id is a conflict and fails.
  if (current !== "PENDING" && current !== event.decision) {
    throw new ContractError(`decide-approval: approval "${event.id}" was already decided "${current}"; conflicting decision "${event.decision}" is rejected`);
  }

  if (event.decision === "REJECTED") {
    // A single rejection invalidates the whole accepted graph immediately —
    // there is nothing to salvage from a partially-approved plan.
    return { phase: Phase.GRADED, approvals: {}, baseCommit: null };
  }

  const approvals = { ...run.approvals, [event.id]: "APPROVED" };
  const allApproved = Object.values(approvals).every((s) => s === "APPROVED");
  return { phase: allApproved ? Phase.PLANNED : Phase.APPROVAL_PENDING, approvals };
}

function handleRunWave1(run, event) {
  return { phase: Phase.WAVE_1_RUNNING, operation: requireOperation(event.operation) };
}

function handleWave1Complete(run, event) {
  return {
    phase: Phase.WAVE_1_COMPLETE,
    operation: null,
    checkpoint1Ref: requireString(event.checkpointRef, "event.checkpointRef"),
    wave1IntegrationHead: requireString(event.integrationHead, "event.integrationHead"),
  };
}

function handleAcceptReview(run, event) {
  requireString(event.reviewRef, "event.reviewRef");
  requireBoolean(event.hasGaps, "event.hasGaps");
  if (event.hasGaps) {
    return {
      phase: Phase.REVIEWED,
      reviewRef: event.reviewRef,
      correctionGraphRef: requireString(event.correctionGraphRef, "event.correctionGraphRef (required when the review has gaps)"),
    };
  }
  if (event.correctionGraphRef !== undefined) {
    throw new ContractError("event.correctionGraphRef must not be supplied when the review has no gaps — no correction graph is accepted");
  }
  // The no-gap branch enters VERIFYING directly (brief, Step 5: "a no-gap
  // review transitions to VERIFYING"), which makes this edge a child-launch
  // boundary just like START_VERIFY on the corrections path. It therefore
  // requires the same operation metadata: VERIFYING is NEVER entered without
  // a recorded {pid, startedAt, kind}, so VERIFYING:RECOVER_INTERRUPTED
  // always has something concrete to reconcile against and never has to
  // infer success from a vanished PID. See the invariant test
  // "run.operation is non-null on entry to VERIFYING via BOTH paths".
  return {
    phase: Phase.VERIFYING,
    reviewRef: event.reviewRef,
    operation: requireOperation(event.operation),
  };
}

function handleRunWave2(run, event) {
  if (run.correctionWaveUsed) {
    // Defense in depth: structurally unreachable, since REVIEWED can only be
    // entered once per run and nothing transitions back into it (see the
    // module-level comment and the exhaustive third-wave sweep in tests).
    throw new ContractError("a correction wave has already run for this run; a third wave is never permitted");
  }
  return { phase: Phase.WAVE_2_RUNNING, operation: requireOperation(event.operation), correctionWaveUsed: true };
}

function handleWave2Complete(run, event) {
  return { phase: Phase.WAVE_2_COMPLETE, operation: null, checkpoint2Ref: requireString(event.checkpointRef, "event.checkpointRef") };
}

function handleAcceptFinalReview(run, event) {
  requireBoolean(event.allSatisfied, "event.allSatisfied");
  if (event.allSatisfied) {
    return { phase: Phase.CORRECTIONS_REVIEWED, finalReviewRef: requireString(event.finalReviewRef, "event.finalReviewRef") };
  }
  return blockedPatch(run, Phase.WAVE_2_COMPLETE, event, "post-correction review reported a BLOCKED acceptance criterion");
}

function handleStartVerify(run, event) {
  return { phase: Phase.VERIFYING, operation: requireOperation(event.operation) };
}

function handleVerifyComplete(run, event) {
  requireBoolean(event.success, "event.success");
  if (event.success) {
    return { phase: Phase.FINISH_PENDING, operation: null, finalResultsRef: requireString(event.resultsRef, "event.resultsRef") };
  }
  return blockedPatch(run, Phase.VERIFYING, event, "final verification failed");
}

const FINISH_CHOICES = new Set(["keep", "merge", "push", "pr", "discard"]);

function handleChooseFinish(run, event) {
  if (!FINISH_CHOICES.has(event.choice)) {
    throw new ContractError(`event.choice must be one of ${[...FINISH_CHOICES].join("|")}, got ${JSON.stringify(event.choice)}`);
  }
  return {
    phase: Phase.FINISH_ACTION_PENDING,
    finish: { choice: event.choice, target: event.target ?? null, decidedAt: new Date().toISOString(), attempts: 0 },
  };
}

function handleCompleteFinish(run, event) {
  if (!run.finish) throw new ContractError("complete-finish requires a prior choose-finish");
  if (run.finish.choice === "discard") {
    throw new ContractError('complete-finish is not valid for choice "discard" — use CLEANUP_DISCARD instead, from the original repository, without deleting anything from the methodology-skill side');
  }
  requireBoolean(event.success, "event.success");
  const evidenceRef = requireString(event.evidenceRef, "event.evidenceRef");
  if (!event.success) {
    // A failed merge/push/PR remains FINISH_ACTION_PENDING; it can never
    // claim COMPLETE from a failure outcome.
    return {
      phase: Phase.FINISH_ACTION_PENDING,
      finish: { ...run.finish, attempts: (run.finish.attempts ?? 0) + 1, lastFailureRef: evidenceRef },
    };
  }
  return {
    phase: Phase.COMPLETE,
    finish: { ...run.finish, completedAt: new Date().toISOString(), evidenceRef },
  };
}

function handleCleanupDiscard(run, event) {
  if (!run.finish || run.finish.choice !== "discard") {
    throw new ContractError('cleanup --mode discard is only valid when choose-finish selected "discard"');
  }
  const evidenceRef = requireString(event.evidenceRef, "event.evidenceRef");
  return {
    phase: Phase.COMPLETE,
    finish: { ...run.finish, completedAt: new Date().toISOString(), evidenceRef },
    cleanup: { mode: "discard", evidenceRef, at: new Date().toISOString() },
  };
}

function handleCleanupPostComplete(run, event) {
  const evidenceRef = requireString(event.evidenceRef, "event.evidenceRef");
  return { phase: Phase.COMPLETE, cleanup: { mode: "post-complete", evidenceRef, at: new Date().toISOString() } };
}

function handleBlock(run, event) {
  return blockedPatch(run, run.phase, event, "operator-initiated block");
}

function handleRecoverFromBlocked(run, event) {
  if (event.priorPhase !== run.blockedFrom) {
    throw new ContractError(`recover: priorPhase must exactly name the phase this run was blocked from ("${run.blockedFrom}"), got ${JSON.stringify(event.priorPhase)}`);
  }
  if (event.changedConditionBytes === undefined) {
    throw new ContractError("recover: event.changedConditionBytes (the changed-condition artifact) is required");
  }
  const newHash = hashBytes(event.changedConditionBytes);
  if (run.blockEvidence && newHash === run.blockEvidence.bytesHash) {
    throw new ContractError("recover: the changed-condition artifact is byte-identical to the evidence that caused the block — nothing has changed");
  }
  return { phase: run.blockedFrom, operation: null, blockedFrom: null, blockEvidence: null };
}

const k = (phase, type) => `${phase}:${type}`;

const TRANSITIONS = new Map([
  [k(Phase.INITIALIZED, "START_GRADING"), handleStartGrading],
  [k(Phase.GRADING, "GRADING_COMPLETE"), handleGradingComplete],
  [k(Phase.GRADING, "RECOVER_INTERRUPTED"), handleRecoverInterrupted],
  [k(Phase.GRADED, "ACCEPT_PLAN"), handleAcceptPlan],
  [k(Phase.APPROVAL_PENDING, "DECIDE_APPROVAL"), handleDecideApproval],
  [k(Phase.PLANNED, "RUN_WAVE_1"), handleRunWave1],
  [k(Phase.WAVE_1_RUNNING, "WAVE_1_COMPLETE"), handleWave1Complete],
  [k(Phase.WAVE_1_RUNNING, "RECOVER_INTERRUPTED"), handleRecoverInterrupted],
  [k(Phase.WAVE_1_COMPLETE, "ACCEPT_REVIEW"), handleAcceptReview],
  // The one and only edge that can ever produce WAVE_2_RUNNING.
  [k(Phase.REVIEWED, "RUN_WAVE_2"), handleRunWave2],
  [k(Phase.WAVE_2_RUNNING, "WAVE_2_COMPLETE"), handleWave2Complete],
  [k(Phase.WAVE_2_RUNNING, "RECOVER_INTERRUPTED"), handleRecoverInterrupted],
  [k(Phase.WAVE_2_COMPLETE, "ACCEPT_FINAL_REVIEW"), handleAcceptFinalReview],
  [k(Phase.CORRECTIONS_REVIEWED, "START_VERIFY"), handleStartVerify],
  [k(Phase.VERIFYING, "VERIFY_COMPLETE"), handleVerifyComplete],
  [k(Phase.VERIFYING, "RECOVER_INTERRUPTED"), handleRecoverInterrupted],
  [k(Phase.FINISH_PENDING, "CHOOSE_FINISH"), handleChooseFinish],
  [k(Phase.FINISH_ACTION_PENDING, "COMPLETE_FINISH"), handleCompleteFinish],
  [k(Phase.FINISH_ACTION_PENDING, "CLEANUP_DISCARD"), handleCleanupDiscard],
  [k(Phase.COMPLETE, "CLEANUP_POST_COMPLETE"), handleCleanupPostComplete],
  [k(Phase.BLOCKED, "RECOVER_FROM_BLOCKED"), handleRecoverFromBlocked],
  // A generic operator/host block is legal from any non-terminal phase.
  ...NON_TERMINAL_PHASES.map((p) => [k(p, "BLOCK"), handleBlock]),
]);

function isRunLike(run) {
  return !!run && typeof run === "object" && typeof run.phase === "string" && Number.isInteger(run.revision);
}

export function reduceRun(run, event) {
  if (!isRunLike(run)) {
    throw new ContractError("reduceRun: run must be a run record with a string phase and integer revision");
  }
  if (!event || typeof event.type !== "string") {
    throw new ContractError("reduceRun: event.type is required");
  }
  // Stale-revision guard: a caller that read the run at an earlier revision
  // and is now submitting an event against that stale snapshot fails here,
  // rather than silently clobbering whatever happened in between.
  if (event.expectedRevision !== undefined && event.expectedRevision !== run.revision) {
    throw new ContractError(`stale revision: event expected revision ${event.expectedRevision} but run is at revision ${run.revision}`);
  }

  const handler = TRANSITIONS.get(k(run.phase, event.type));
  if (!handler) {
    throw new ContractError(`no transition from phase "${run.phase}" on event "${event.type}"`);
  }

  const patch = handler(run, event);
  if (!patch || typeof patch.phase !== "string" || !(patch.phase in Phase)) {
    throw new ContractError(`internal: transition handler for ${run.phase}:${event.type} returned an invalid patch`);
  }

  const now = new Date().toISOString();
  const nextRevision = run.revision + 1;
  const history = [...(run.history ?? []), { revision: nextRevision, phase: patch.phase, event: event.type, at: now }].slice(-50);

  return { ...run, ...patch, revision: nextRevision, updatedAt: now, history };
}

// --------------------------------------------------------------------------
// Run IDs
// --------------------------------------------------------------------------

// UTC basic timestamp + 4 cryptographically random bytes (brief, Step 6):
// YYYYMMDDTHHMMSSZ-xxxxxxxx.
function generateRunId(now) {
  const basic = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = randomBytes(4).toString("hex");
  return `${basic}-${suffix}`;
}

// --------------------------------------------------------------------------
// Ledger paths
// --------------------------------------------------------------------------

export function getRunPaths(repoInfo, runId) {
  if (!repoInfo || typeof repoInfo.gitCommonDir !== "string" || repoInfo.gitCommonDir.length === 0) {
    throw new ContractError("getRunPaths: repoInfo.gitCommonDir is required");
  }
  validateIdentifier("run", runId);
  const dir = join(repoInfo.gitCommonDir, "carefully-crafted", "supervise", runId);
  return {
    dir,
    lockDir: join(dir, ".lock"),
    runFile: join(dir, "run.json"),
    preflight: join(dir, "preflight.json"),
    request: join(dir, "request.md"),
    complexity: join(dir, "complexity.json"),
    plan: join(dir, "plan.md"),
    taskGraph: join(dir, "task-graph.json"),
    approvals: join(dir, "approvals.json"),
    review: join(dir, "review.json"),
    correctionGraph: join(dir, "correction-graph.json"),
    finalReview: join(dir, "final-review.json"),
    checkpoint1: join(dir, "checkpoint-1.json"),
    checkpoint2: join(dir, "checkpoint-2.json"),
    final: join(dir, "final.json"),
    finishChoice: join(dir, "finish-choice.json"),
    finishEvidence: join(dir, "finish-evidence.json"),
    cleanup: join(dir, "cleanup.json"),
    changedConditionsDir: join(dir, "changed-conditions"),
    ordersDir: join(dir, "orders"),
    reportsDir: join(dir, "reports"),
    receiptsDir: join(dir, "receipts"),
    logsDir: join(dir, "logs"),
  };
}

// --------------------------------------------------------------------------
// Atomic persistence
// --------------------------------------------------------------------------

// write temp -> fsync -> atomic rename -> fsync parent (brief, Step 6). Mode
// 0600 on platforms that support POSIX modes; Node silently ignores the mode
// bits it cannot apply (e.g. Windows), so no platform branch is needed.
function persistRunAtomic(paths, run) {
  const text = JSON.stringify(run, null, 2);
  const tmpPath = join(paths.dir, `.run.json.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmpPath, text, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
  const fileFd = openSync(tmpPath, "r+");
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }
  renameSync(tmpPath, paths.runFile);
  const dirFd = openSync(paths.dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function loadRun(repoInfo, runId) {
  const paths = getRunPaths(repoInfo, runId);
  let text;
  try {
    text = readFileSync(paths.runFile, "utf8");
  } catch (err) {
    throw new ContractError(`loadRun: no run ledger found for "${runId}" at ${paths.runFile} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ContractError(`loadRun: run ledger at ${paths.runFile} is not valid JSON (${err.message})`);
  }
}

const MAX_RUN_ID_ATTEMPTS = 20;

export function createRun(input) {
  if (!input || typeof input !== "object") {
    throw new ContractError("createRun: input must be an object with a repoInfo field");
  }
  const { repoInfo } = input;
  if (!repoInfo || typeof repoInfo.gitCommonDir !== "string" || repoInfo.gitCommonDir.length === 0) {
    throw new ContractError("createRun: input.repoInfo.gitCommonDir is required");
  }
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new ContractError("createRun: input.now must be a valid date if supplied");
  }

  // The shared parent chain is not secret and is created idempotently with
  // default permissions; only the run-specific directory is owner-only.
  mkdirSync(join(repoInfo.gitCommonDir, "carefully-crafted", "supervise"), { recursive: true });

  let runId;
  let paths;
  let created = false;
  for (let attempt = 0; attempt < MAX_RUN_ID_ATTEMPTS && !created; attempt++) {
    runId = generateRunId(now);
    paths = getRunPaths(repoInfo, runId);
    try {
      // Atomic collision check: mkdirSync throws EEXIST if this exact run
      // directory already exists. This never opens or overwrites an
      // existing run — brief, Step 6 — it just tries a fresh runId.
      mkdirSync(paths.dir, { mode: 0o700 });
      created = true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // loop: new random suffix on the next iteration
    }
  }
  if (!created) {
    throw new ContractError(`createRun: could not allocate a unique run ID after ${MAX_RUN_ID_ATTEMPTS} attempts`);
  }

  for (const sub of [paths.changedConditionsDir, paths.ordersDir, paths.reportsDir, paths.receiptsDir, paths.logsDir]) {
    mkdirSync(sub, { mode: 0o700 });
  }

  const createdAt = now.toISOString();
  const run = {
    runId,
    revision: 1,
    phase: Phase.INITIALIZED,
    createdAt,
    updatedAt: createdAt,
    operation: null,
    blockedFrom: null,
    blockEvidence: null,
    correctionWaveUsed: false,
    finish: null,
    history: [{ revision: 1, phase: Phase.INITIALIZED, event: "CREATE_RUN", at: createdAt }],
  };
  persistRunAtomic(paths, run);
  return run;
}

export function updateRun(repoInfo, runId, event) {
  return withRunLock(repoInfo, runId, () => {
    const current = loadRun(repoInfo, runId);
    const next = reduceRun(current, event);
    persistRunAtomic(getRunPaths(repoInfo, runId), next);
    return next;
  });
}

// --------------------------------------------------------------------------
// Locking
// --------------------------------------------------------------------------

// Chosen conservatively: comfortably longer than a single reduceRun +
// persist cycle should ever take, short enough that a genuinely crashed
// process doesn't block recovery indefinitely.
const STALE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false; // definitively gone
    if (err.code === "EPERM") return true; // exists, owned by someone else
    return false; // unknown error: do not assume alive, but also see caller (fail closed elsewhere)
  }
}

// Stale-lock recovery is permitted only when the recorded process is absent
// AND the lock's age exceeds STALE_LOCK_TIMEOUT_MS (brief, Step 6). Any
// other case — including "cannot prove staleness" — fails closed (treated as
// live) so recovery never infers success from a vanished PID.
function evaluateStaleLock(lockInfoPath) {
  let info;
  try {
    info = JSON.parse(readFileSync(lockInfoPath, "utf8"));
  } catch {
    return false;
  }
  if (typeof info.pid !== "number" || typeof info.acquiredAt !== "string") return false;
  if (isProcessAlive(info.pid)) return false;
  const age = Date.now() - Date.parse(info.acquiredAt);
  if (!Number.isFinite(age) || age <= STALE_LOCK_TIMEOUT_MS) return false;
  return true;
}

const LOCK_ACQUIRE_ATTEMPTS = 3;

export async function withRunLock(repoInfo, runId, fn) {
  const paths = getRunPaths(repoInfo, runId);
  if (!existsSync(paths.dir)) {
    throw new ContractError(`withRunLock: no run ledger directory for "${runId}"`);
  }
  const lockInfoPath = join(paths.lockDir, "info.json");

  let acquired = false;
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS && !acquired; attempt++) {
    try {
      mkdirSync(paths.lockDir, { mode: 0o700 });
      acquired = true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!evaluateStaleLock(lockInfoPath)) {
        throw new ContractError(`withRunLock: run "${runId}" is locked by a live (or unverifiable) process; refusing to proceed`);
      }
      // Provably stale: absent process, age past the documented timeout.
      // Safe to reclaim and retry acquisition.
      rmSync(paths.lockDir, { recursive: true, force: true });
    }
  }
  if (!acquired) {
    throw new ContractError(`withRunLock: could not acquire the lock for run "${runId}"`);
  }

  writeFileSync(lockInfoPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { mode: 0o600 });
  try {
    chmodSync(lockInfoPath, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }

  try {
    return await fn();
  } finally {
    rmSync(paths.lockDir, { recursive: true, force: true });
  }
}
