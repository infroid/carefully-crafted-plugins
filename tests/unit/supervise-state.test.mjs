// Unit tests for plugins/contexthub/scripts/supervise/state.mjs
// Run with: node --test tests/unit/supervise-state.test.mjs
//
// Two things this suite exists to prove, exhaustively rather than by
// sampling:
//
//   1. Every legal (phase, event) transition behaves exactly as specified,
//      and every OTHER (phase, event) pair — the full cross product minus
//      the legal set — throws ContractError. "Exhaustive" means literally
//      iterating every Phase x every event type used anywhere in this
//      suite, not spot-checking a handful.
//
//   2. A third execution wave cannot be created by any event, from any
//      phase, ever — proven by sweeping every (phase, event) pair and
//      asserting none of them (other than the one designated edge) can ever
//      produce phase WAVE_2_RUNNING.
//
// The second half of the file exercises the durable/atomic persistence
// layer: real temp directories standing in for a git common-dir, real
// fs operations, real (short-lived) child processes for live/stale lock
// detection.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { ContractError } from "../../plugins/contexthub/scripts/supervise/contracts.mjs";
import {
  Phase,
  createRun,
  reduceRun,
  getRunPaths,
  loadRun,
  updateRun,
  withRunLock,
} from "../../plugins/contexthub/scripts/supervise/state.mjs";

function assertThrowsContract(fn, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ContractError, `expected ContractError, got ${err}`);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

function tmpRepoInfo() {
  return { gitCommonDir: mkdtempSync(join(tmpdir(), "supervise-state-test-")) };
}

const iso = () => new Date().toISOString();
const op = (kind = "test") => ({ pid: process.pid, startedAt: iso(), kind });
const reconciled = () => ({ processes: true, receipts: true, worktrees: true, integrationHead: true });

function freshRun(overrides = {}) {
  // A minimal, well-formed run record — not persisted to disk. Used for
  // reduceRun unit tests that do not need real filesystem state.
  return {
    runId: "20260718T153000Z-a1b2c3d4",
    revision: 1,
    phase: Phase.INITIALIZED,
    createdAt: iso(),
    updatedAt: iso(),
    operation: null,
    blockedFrom: null,
    blockEvidence: null,
    correctionWaveUsed: false,
    finish: null,
    approvals: {},
    history: [],
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Exhaustive transition matrix
// --------------------------------------------------------------------------

// Every event type this machine ever accepts, with a payload builder that
// produces a *minimally valid* payload for that event type in isolation
// (some are only valid from specific phases/run states — the exhaustive
// sweep below cares only about which (phase, type) pairs are wired up in
// the transition table, not deep payload semantics, which is covered by the
// "Individual transition semantics" section further down).
const EVENT_PAYLOAD = {
  START_GRADING: () => ({ operation: op("grading") }),
  GRADING_COMPLETE: () => ({ complexityRef: "complexity.json" }),
  RECOVER_INTERRUPTED: () => ({ reconciliation: reconciled(), operation: op("relaunch") }),
  ACCEPT_PLAN: () => ({ baseCommit: "0123456789abcdef0123456789abcdef01234567", approvalIds: [] }),
  DECIDE_APPROVAL: () => ({ id: "approval-01", decision: "APPROVED" }),
  RUN_WAVE_1: () => ({ operation: op("wave-1") }),
  WAVE_1_COMPLETE: () => ({ checkpointRef: "checkpoint-1.json", integrationHead: "a".repeat(40) }),
  ACCEPT_REVIEW: () => ({ reviewRef: "review.json", hasGaps: false }),
  RUN_WAVE_2: () => ({ operation: op("wave-2") }),
  WAVE_2_COMPLETE: () => ({ checkpointRef: "checkpoint-2.json" }),
  ACCEPT_FINAL_REVIEW: () => ({ finalReviewRef: "final-review.json", allSatisfied: true }),
  START_VERIFY: () => ({ operation: op("verify") }),
  VERIFY_COMPLETE: () => ({ success: true, resultsRef: "final.json" }),
  CHOOSE_FINISH: () => ({ choice: "keep" }),
  COMPLETE_FINISH: () => ({ success: true, evidenceRef: "finish-evidence.json" }),
  CLEANUP_DISCARD: () => ({ evidenceRef: "cleanup.json" }),
  CLEANUP_POST_COMPLETE: () => ({ evidenceRef: "cleanup.json" }),
  BLOCK: () => ({ evidenceBytes: "something changed", reason: "manual block" }),
  RECOVER_FROM_BLOCKED: () => ({ priorPhase: Phase.GRADING, changedConditionBytes: "new evidence" }),
};
const ALL_EVENT_TYPES = Object.keys(EVENT_PAYLOAD);
const ALL_PHASES = Object.values(Phase);

// The complete, literal set of legal (phase, event) edges this machine
// implements. Anything NOT in this set must throw — proven below by sweeping
// the full cross product.
const LEGAL_EDGES = new Set([
  `${Phase.INITIALIZED}:START_GRADING`,
  `${Phase.GRADING}:GRADING_COMPLETE`,
  `${Phase.GRADING}:RECOVER_INTERRUPTED`,
  `${Phase.GRADED}:ACCEPT_PLAN`,
  `${Phase.APPROVAL_PENDING}:DECIDE_APPROVAL`,
  `${Phase.PLANNED}:RUN_WAVE_1`,
  `${Phase.WAVE_1_RUNNING}:WAVE_1_COMPLETE`,
  `${Phase.WAVE_1_RUNNING}:RECOVER_INTERRUPTED`,
  `${Phase.WAVE_1_COMPLETE}:ACCEPT_REVIEW`,
  `${Phase.REVIEWED}:RUN_WAVE_2`,
  `${Phase.WAVE_2_RUNNING}:WAVE_2_COMPLETE`,
  `${Phase.WAVE_2_RUNNING}:RECOVER_INTERRUPTED`,
  `${Phase.WAVE_2_COMPLETE}:ACCEPT_FINAL_REVIEW`,
  `${Phase.CORRECTIONS_REVIEWED}:START_VERIFY`,
  `${Phase.VERIFYING}:VERIFY_COMPLETE`,
  `${Phase.VERIFYING}:RECOVER_INTERRUPTED`,
  `${Phase.FINISH_PENDING}:CHOOSE_FINISH`,
  `${Phase.FINISH_ACTION_PENDING}:COMPLETE_FINISH`,
  `${Phase.FINISH_ACTION_PENDING}:CLEANUP_DISCARD`,
  `${Phase.COMPLETE}:CLEANUP_POST_COMPLETE`,
  `${Phase.BLOCKED}:RECOVER_FROM_BLOCKED`,
  // Generic BLOCK from every non-terminal, non-BLOCKED phase.
  ...ALL_PHASES.filter((p) => p !== Phase.COMPLETE && p !== Phase.BLOCKED).map((p) => `${p}:BLOCK`),
]);

describe("reduceRun — exhaustive transition matrix", () => {
  for (const phase of ALL_PHASES) {
    for (const type of ALL_EVENT_TYPES) {
      const edge = `${phase}:${type}`;
      const legal = LEGAL_EDGES.has(edge);
      test(`${edge} is ${legal ? "LEGAL" : "rejected"}`, () => {
        // Build a run in `phase` with just enough state for the handler to
        // evaluate its guards without throwing on unrelated missing fields.
        // CLEANUP_DISCARD and COMPLETE_FINISH share the FINISH_ACTION_PENDING
        // phase but require opposite `finish.choice` values, so the fixture
        // is keyed off the specific event under test, not just the phase.
        const finishChoice = type === "CLEANUP_DISCARD" ? "discard" : "keep";
        const run = freshRun({
          phase,
          approvals: phase === Phase.APPROVAL_PENDING ? { "approval-01": "PENDING" } : {},
          finish: phase === Phase.FINISH_ACTION_PENDING ? { choice: finishChoice, target: null, decidedAt: iso(), attempts: 0 } : null,
          blockedFrom: phase === Phase.BLOCKED ? Phase.GRADING : null,
          blockEvidence: phase === Phase.BLOCKED ? { bytesHash: "deadbeef", reason: "x", recordedAt: iso() } : null,
        });
        const event = { type, ...EVENT_PAYLOAD[type]() };
        if (legal) {
          const next = reduceRun(run, event);
          assert.equal(typeof next.phase, "string");
          assert.ok(next.phase in Phase);
          assert.equal(next.revision, run.revision + 1);
        } else {
          assertThrowsContract(() => reduceRun(run, event));
        }
      });
    }
  }

  test("no (phase, event) pair EXCEPT REVIEWED:RUN_WAVE_2 can ever ENTER WAVE_2_RUNNING from a different phase — a third wave is structurally unrepresentable", () => {
    // WAVE_2_RUNNING:RECOVER_INTERRUPTED is a legitimate self-loop (it
    // resumes the *same* already-running wave two after a crash — input
    // phase already equals output phase, so it creates nothing new). Every
    // other (phase, event) pair is checked here for the one property that
    // actually matters: can it make phase become WAVE_2_RUNNING when it
    // wasn't already? That is the operational definition of "starting a new
    // wave", and only one edge in the whole table may ever do it.
    let edgesEnteringWave2Running = 0;
    for (const phase of ALL_PHASES) {
      for (const type of ALL_EVENT_TYPES) {
        if (`${phase}:${type}` === `${Phase.REVIEWED}:RUN_WAVE_2`) continue;
        if (phase === Phase.WAVE_2_RUNNING) continue; // self-loop cases handled below
        const finishChoice = type === "CLEANUP_DISCARD" ? "discard" : "keep";
        const run = freshRun({
          phase,
          approvals: phase === Phase.APPROVAL_PENDING ? { "approval-01": "PENDING" } : {},
          finish: phase === Phase.FINISH_ACTION_PENDING ? { choice: finishChoice, target: null, decidedAt: iso(), attempts: 0 } : null,
          blockedFrom: phase === Phase.BLOCKED ? Phase.WAVE_2_COMPLETE : null,
          blockEvidence: phase === Phase.BLOCKED ? { bytesHash: "deadbeef", reason: "x", recordedAt: iso() } : null,
        });
        try {
          const next = reduceRun(run, { type, ...EVENT_PAYLOAD[type]() });
          if (next.phase === Phase.WAVE_2_RUNNING) edgesEnteringWave2Running++;
        } catch {
          // expected for illegal edges
        }
      }
    }
    assert.equal(edgesEnteringWave2Running, 0);
  });

  test("WAVE_2_RUNNING:RECOVER_INTERRUPTED only ever resumes the SAME wave two, never a new one", () => {
    const run = freshRun({ phase: Phase.WAVE_2_RUNNING, correctionWaveUsed: true, operation: op("original") });
    const next = reduceRun(run, { type: "RECOVER_INTERRUPTED", reconciliation: reconciled(), operation: op("relaunch") });
    assert.equal(next.phase, Phase.WAVE_2_RUNNING);
    assert.equal(next.correctionWaveUsed, true); // never reset, never re-enabled
  });

  test("REVIEWED:RUN_WAVE_2 can never fire twice for the same run (correctionWaveUsed guard, defense in depth)", () => {
    const run = freshRun({ phase: Phase.REVIEWED, correctionWaveUsed: true });
    assertThrowsContract(() => reduceRun(run, { type: "RUN_WAVE_2", ...EVENT_PAYLOAD.RUN_WAVE_2() }), /third wave/);
  });
});

// --------------------------------------------------------------------------
// Individual transition semantics
// --------------------------------------------------------------------------

describe("reduceRun — individual transition semantics", () => {
  test("review cannot occur before wave one completes", () => {
    for (const phase of [Phase.PLANNED, Phase.WAVE_1_RUNNING, Phase.GRADED]) {
      const run = freshRun({ phase });
      assertThrowsContract(() => reduceRun(run, { type: "ACCEPT_REVIEW", ...EVENT_PAYLOAD.ACCEPT_REVIEW() }));
    }
  });

  test("wave one cannot run twice", () => {
    const run = freshRun({ phase: Phase.WAVE_1_COMPLETE });
    assertThrowsContract(() => reduceRun(run, { type: "RUN_WAVE_1", ...EVENT_PAYLOAD.RUN_WAVE_1() }));
  });

  test("a no-gap review transitions to VERIFYING", () => {
    const run = freshRun({ phase: Phase.WAVE_1_COMPLETE });
    const next = reduceRun(run, { type: "ACCEPT_REVIEW", reviewRef: "review.json", hasGaps: false });
    assert.equal(next.phase, Phase.VERIFYING);
  });

  test("a no-gap review rejects a correction graph reference", () => {
    const run = freshRun({ phase: Phase.WAVE_1_COMPLETE });
    assertThrowsContract(() => reduceRun(run, { type: "ACCEPT_REVIEW", reviewRef: "review.json", hasGaps: false, correctionGraphRef: "correction-graph.json" }));
  });

  test("a gap review plus a valid correction graph permits exactly one WAVE_2_RUNNING transition", () => {
    let run = freshRun({ phase: Phase.WAVE_1_COMPLETE });
    run = reduceRun(run, { type: "ACCEPT_REVIEW", reviewRef: "review.json", hasGaps: true, correctionGraphRef: "correction-graph.json" });
    assert.equal(run.phase, Phase.REVIEWED);
    run = reduceRun(run, { type: "RUN_WAVE_2", ...EVENT_PAYLOAD.RUN_WAVE_2() });
    assert.equal(run.phase, Phase.WAVE_2_RUNNING);
    assert.equal(run.correctionWaveUsed, true);
    // A second attempt from the now-current phase (WAVE_2_RUNNING) is not
    // even a wired edge, so it throws for that reason too — but the
    // dedicated correctionWaveUsed test above proves the deeper guard.
    assertThrowsContract(() => reduceRun(run, { type: "RUN_WAVE_2", ...EVENT_PAYLOAD.RUN_WAVE_2() }));
  });

  test("a gap review without a correction graph reference is rejected", () => {
    const run = freshRun({ phase: Phase.WAVE_1_COMPLETE });
    assertThrowsContract(() => reduceRun(run, { type: "ACCEPT_REVIEW", reviewRef: "review.json", hasGaps: true }), /correctionGraphRef/);
  });

  test("WAVE_2_COMPLETE requires a post-correction review (ACCEPT_FINAL_REVIEW) before VERIFYING", () => {
    const run = freshRun({ phase: Phase.WAVE_2_COMPLETE });
    assertThrowsContract(() => reduceRun(run, { type: "START_VERIFY", ...EVENT_PAYLOAD.START_VERIFY() }));
    const reviewed = reduceRun(run, { type: "ACCEPT_FINAL_REVIEW", finalReviewRef: "final-review.json", allSatisfied: true });
    assert.equal(reviewed.phase, Phase.CORRECTIONS_REVIEWED);
    const verifying = reduceRun(reviewed, { type: "START_VERIFY", ...EVENT_PAYLOAD.START_VERIFY() });
    assert.equal(verifying.phase, Phase.VERIFYING);
  });

  test("a post-correction blocked criterion transitions to BLOCKED and never wave three", () => {
    const run = freshRun({ phase: Phase.WAVE_2_COMPLETE });
    const blocked = reduceRun(run, {
      type: "ACCEPT_FINAL_REVIEW", finalReviewRef: "final-review.json", allSatisfied: false,
      evidenceBytes: "AC-06 is BLOCKED", reason: "AC-06 could not be satisfied",
    });
    assert.equal(blocked.phase, Phase.BLOCKED);
    assert.equal(blocked.blockedFrom, Phase.WAVE_2_COMPLETE);
    // No transition out of BLOCKED targets anything wave-two/three related
    // except recovery back to the named prior phase.
    assertThrowsContract(() => reduceRun(blocked, { type: "RUN_WAVE_2", ...EVENT_PAYLOAD.RUN_WAVE_2() }));
  });

  test("final verification failure transitions to BLOCKED", () => {
    const run = freshRun({ phase: Phase.VERIFYING });
    const blocked = reduceRun(run, { type: "VERIFY_COMPLETE", success: false, evidenceBytes: "verification failed: 2 tests red" });
    assert.equal(blocked.phase, Phase.BLOCKED);
    assert.equal(blocked.blockedFrom, Phase.VERIFYING);
  });

  test("final verification success transitions to FINISH_PENDING", () => {
    const run = freshRun({ phase: Phase.VERIFYING });
    const next = reduceRun(run, { type: "VERIFY_COMPLETE", success: true, resultsRef: "final.json" });
    assert.equal(next.phase, Phase.FINISH_PENDING);
  });

  test("FINISH_PENDING records an exact choice before any finish action", () => {
    const run = freshRun({ phase: Phase.FINISH_PENDING });
    const next = reduceRun(run, { type: "CHOOSE_FINISH", choice: "merge", target: "main" });
    assert.equal(next.phase, Phase.FINISH_ACTION_PENDING);
    assert.equal(next.finish.choice, "merge");
    assert.equal(next.finish.target, "main");
  });

  test("choose-finish rejects an invalid choice", () => {
    const run = freshRun({ phase: Phase.FINISH_PENDING });
    assertThrowsContract(() => reduceRun(run, { type: "CHOOSE_FINISH", choice: "delete-everything" }));
  });

  test("a failed merge/push/PR remains FINISH_ACTION_PENDING and cannot claim COMPLETE", () => {
    let run = freshRun({ phase: Phase.FINISH_PENDING });
    run = reduceRun(run, { type: "CHOOSE_FINISH", choice: "push" });
    const afterFailure = reduceRun(run, { type: "COMPLETE_FINISH", success: false, evidenceRef: "finish-evidence.json" });
    assert.equal(afterFailure.phase, Phase.FINISH_ACTION_PENDING);
    assert.equal(afterFailure.finish.attempts, 1);
    assert.ok(!("completedAt" in (afterFailure.finish ?? {})) || afterFailure.finish.completedAt === undefined);
  });

  test("keep completion requires evidence and reaches COMPLETE", () => {
    let run = freshRun({ phase: Phase.FINISH_PENDING });
    run = reduceRun(run, { type: "CHOOSE_FINISH", choice: "keep" });
    const complete = reduceRun(run, { type: "COMPLETE_FINISH", success: true, evidenceRef: "finish-evidence.json" });
    assert.equal(complete.phase, Phase.COMPLETE);
    assert.equal(complete.finish.evidenceRef, "finish-evidence.json");
  });

  test("complete-finish is never valid for choice discard", () => {
    let run = freshRun({ phase: Phase.FINISH_PENDING });
    run = reduceRun(run, { type: "CHOOSE_FINISH", choice: "discard" });
    assertThrowsContract(() => reduceRun(run, { type: "COMPLETE_FINISH", success: true, evidenceRef: "x" }), /discard/);
  });

  test("discard completion requires CLEANUP_DISCARD, from FINISH_ACTION_PENDING, and reaches COMPLETE", () => {
    let run = freshRun({ phase: Phase.FINISH_PENDING });
    run = reduceRun(run, { type: "CHOOSE_FINISH", choice: "discard" });
    const complete = reduceRun(run, { type: "CLEANUP_DISCARD", evidenceRef: "cleanup.json" });
    assert.equal(complete.phase, Phase.COMPLETE);
    assert.equal(complete.cleanup.mode, "discard");
  });

  test("CLEANUP_DISCARD is only valid when the choice was discard", () => {
    let run = freshRun({ phase: Phase.FINISH_PENDING });
    run = reduceRun(run, { type: "CHOOSE_FINISH", choice: "keep" });
    assertThrowsContract(() => reduceRun(run, { type: "CLEANUP_DISCARD", evidenceRef: "cleanup.json" }), /discard/);
  });

  test("COMPLETE is terminal — nothing transitions out of it except recorded post-completion cleanup, which stays COMPLETE", () => {
    let run = freshRun({ phase: Phase.FINISH_PENDING });
    run = reduceRun(run, { type: "CHOOSE_FINISH", choice: "keep" });
    run = reduceRun(run, { type: "COMPLETE_FINISH", success: true, evidenceRef: "finish-evidence.json" });
    assert.equal(run.phase, Phase.COMPLETE);
    const afterCleanup = reduceRun(run, { type: "CLEANUP_POST_COMPLETE", evidenceRef: "cleanup.json" });
    assert.equal(afterCleanup.phase, Phase.COMPLETE);
    for (const type of ALL_EVENT_TYPES) {
      if (type === "CLEANUP_POST_COMPLETE") continue;
      assertThrowsContract(() => reduceRun(run, { type, ...EVENT_PAYLOAD[type]() }));
    }
  });

  test("a rejected approval invalidates the task graph and returns to GRADED for replanning", () => {
    let run = freshRun({ phase: Phase.GRADED });
    run = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: ["approval-01", "approval-02"] });
    assert.equal(run.phase, Phase.APPROVAL_PENDING);
    const back = reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-01", decision: "REJECTED" });
    assert.equal(back.phase, Phase.GRADED);
    assert.deepEqual(back.approvals, {});
    assert.equal(back.baseCommit, null);
  });

  test("an empty approvalIds set skips APPROVAL_PENDING and goes straight to PLANNED", () => {
    const run = freshRun({ phase: Phase.GRADED });
    const next = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: [] });
    assert.equal(next.phase, Phase.PLANNED);
  });

  test("the final approval decision moves APPROVAL_PENDING to PLANNED", () => {
    let run = freshRun({ phase: Phase.GRADED });
    run = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: ["approval-01", "approval-02"] });
    run = reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-01", decision: "APPROVED" });
    assert.equal(run.phase, Phase.APPROVAL_PENDING);
    run = reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-02", decision: "APPROVED" });
    assert.equal(run.phase, Phase.PLANNED);
  });

  test("repeated identical approval decisions are idempotent", () => {
    let run = freshRun({ phase: Phase.GRADED });
    run = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: ["approval-01", "approval-02"] });
    run = reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-01", decision: "APPROVED" });
    const repeated = reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-01", decision: "APPROVED" });
    assert.equal(repeated.phase, Phase.APPROVAL_PENDING);
    assert.deepEqual(repeated.approvals, { "approval-01": "APPROVED", "approval-02": "PENDING" });
  });

  test("conflicting approval decisions fail", () => {
    let run = freshRun({ phase: Phase.GRADED });
    run = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: ["approval-01", "approval-02"] });
    run = reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-01", decision: "APPROVED" });
    assertThrowsContract(() => reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-01", decision: "REJECTED" }), /conflicting/);
  });

  test("deciding an unknown approval id fails", () => {
    let run = freshRun({ phase: Phase.GRADED });
    run = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: ["approval-01"] });
    assertThrowsContract(() => reduceRun(run, { type: "DECIDE_APPROVAL", id: "approval-02", decision: "APPROVED" }), /unknown/);
  });

  test("BLOCKED recovery names the prior phase and a changed-condition artifact whose bytes differ from prior evidence", () => {
    const run = freshRun({
      phase: Phase.BLOCKED,
      blockedFrom: Phase.VERIFYING,
      blockEvidence: { bytesHash: createHash("sha256").update("original failure evidence").digest("hex"), reason: "x", recordedAt: iso() },
    });
    // Wrong prior phase named.
    assertThrowsContract(() => reduceRun(run, { type: "RECOVER_FROM_BLOCKED", priorPhase: Phase.GRADING, changedConditionBytes: "fixed now" }), /priorPhase/);
    // Byte-identical evidence is refused.
    assertThrowsContract(() => reduceRun(run, { type: "RECOVER_FROM_BLOCKED", priorPhase: Phase.VERIFYING, changedConditionBytes: "original failure evidence" }), /byte-identical/);
    // Genuinely different bytes succeed and restore the named phase.
    const recovered = reduceRun(run, { type: "RECOVER_FROM_BLOCKED", priorPhase: Phase.VERIFYING, changedConditionBytes: "tests now pass" });
    assert.equal(recovered.phase, Phase.VERIFYING);
    assert.equal(recovered.blockedFrom, null);
    assert.equal(recovered.blockEvidence, null);
  });

  test("interrupted GRADING recovers only after reconciling processes, receipts, worktrees, and integration HEAD", () => {
    const run = freshRun({ phase: Phase.GRADING, operation: op("grading") });
    for (const key of ["processes", "receipts", "worktrees", "integrationHead"]) {
      const partial = { ...reconciled(), [key]: false };
      assertThrowsContract(() => reduceRun(run, { type: "RECOVER_INTERRUPTED", reconciliation: partial, operation: op("relaunch") }));
    }
    const recovered = reduceRun(run, { type: "RECOVER_INTERRUPTED", reconciliation: reconciled(), operation: op("relaunch") });
    assert.equal(recovered.phase, Phase.GRADING);
    assert.equal(recovered.operation.kind, "relaunch");
  });

  for (const phase of [Phase.WAVE_1_RUNNING, Phase.WAVE_2_RUNNING, Phase.VERIFYING]) {
    test(`interrupted ${phase} recovers only after full reconciliation`, () => {
      const run = freshRun({ phase, operation: op("original") });
      assertThrowsContract(() => reduceRun(run, { type: "RECOVER_INTERRUPTED", reconciliation: { processes: true }, operation: op("relaunch") }));
      const recovered = reduceRun(run, { type: "RECOVER_INTERRUPTED", reconciliation: reconciled(), operation: op("relaunch") });
      assert.equal(recovered.phase, phase);
    });
  }

  test("stale revision updates fail", () => {
    const run = freshRun({ phase: Phase.GRADED, revision: 5 });
    assertThrowsContract(
      () => reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: [], expectedRevision: 4 }),
      /stale revision/,
    );
    // The correct revision succeeds.
    const next = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: [], expectedRevision: 5 });
    assert.equal(next.revision, 6);
  });

  test("revision is monotonically increasing across a chain of transitions", () => {
    let run = freshRun({ phase: Phase.GRADED, revision: 1 });
    run = reduceRun(run, { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: [] });
    run = reduceRun(run, { type: "RUN_WAVE_1", ...EVENT_PAYLOAD.RUN_WAVE_1() });
    run = reduceRun(run, { type: "WAVE_1_COMPLETE", ...EVENT_PAYLOAD.WAVE_1_COMPLETE() });
    assert.deepEqual(run.history.map((h) => h.revision), [2, 3, 4]);
    assert.equal(run.revision, 4);
  });

  test("history is bounded to the last 50 entries", () => {
    let run = freshRun({ phase: Phase.GRADING });
    for (let i = 0; i < 60; i++) {
      run = reduceRun(run, { type: "BLOCK", evidenceBytes: `evidence-${i}` });
      assert.equal(run.phase, Phase.BLOCKED);
      // Reset directly to a non-terminal phase (white-box manipulation, not
      // a real recovery flow) purely to keep generating history entries.
      run = { ...run, phase: Phase.GRADING, blockedFrom: null, blockEvidence: null };
    }
    assert.ok(run.history.length <= 50, `history grew to ${run.history.length} entries`);
  });
});

// --------------------------------------------------------------------------
// createRun / getRunPaths / loadRun
// --------------------------------------------------------------------------

describe("getRunPaths / createRun / loadRun", () => {
  test("getRunPaths resolves beneath <git-common-dir>/carefully-crafted/supervise/<run-id>/", () => {
    const repoInfo = tmpRepoInfo();
    const paths = getRunPaths(repoInfo, "20260718T153000Z-a1b2c3d4");
    assert.equal(paths.dir, join(repoInfo.gitCommonDir, "carefully-crafted", "supervise", "20260718T153000Z-a1b2c3d4"));
    assert.equal(paths.runFile, join(paths.dir, "run.json"));
    for (const key of ["preflight", "request", "complexity", "plan", "taskGraph", "approvals", "review", "correctionGraph", "finalReview", "checkpoint1", "checkpoint2", "final", "finishChoice", "finishEvidence", "cleanup"]) {
      assert.ok(typeof paths[key] === "string" && paths[key].startsWith(paths.dir));
    }
    for (const key of ["changedConditionsDir", "ordersDir", "reportsDir", "receiptsDir", "logsDir"]) {
      assert.ok(paths[key].startsWith(paths.dir));
    }
  });

  test("getRunPaths rejects a malformed run id", () => {
    assertThrowsContract(() => getRunPaths(tmpRepoInfo(), "not-a-run-id"));
  });

  test("createRun generates a run id matching YYYYMMDDTHHMMSSZ-xxxxxxxx", () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    assert.match(run.runId, /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/);
    assert.equal(run.phase, Phase.INITIALIZED);
    assert.equal(run.revision, 1);
  });

  test("createRun writes run.json readable via loadRun", () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const loaded = loadRun(repoInfo, run.runId);
    assert.deepEqual(loaded, run);
  });

  test("createRun creates the ledger directory owner-only (mode 0700) where POSIX modes are supported", () => {
    if (process.platform === "win32") return;
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    const mode = statSync(paths.dir).mode & 0o777;
    assert.equal(mode, 0o700);
  });

  test("createRun creates run.json with mode 0600 where POSIX modes are supported", () => {
    if (process.platform === "win32") return;
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    const mode = statSync(paths.runFile).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test("createRun creates the changed-conditions/orders/reports/receipts/logs subdirectories", () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    for (const dir of [paths.changedConditionsDir, paths.ordersDir, paths.reportsDir, paths.receiptsDir, paths.logsDir]) {
      assert.ok(existsSync(dir), `expected ${dir} to exist`);
    }
  });

  test("createRun never opens or overwrites an existing run: a forced ID collision produces a different run id", () => {
    const repoInfo = tmpRepoInfo();
    const fixedNow = new Date("2026-07-18T15:30:00.000Z");
    // Pre-create every possible directory for this timestamp's basic prefix
    // is impractical (2^32 suffixes), so instead prove the *mechanism*:
    // create one run at a fixed `now`, then create a second run at the
    // exact same `now` and assert it did not collide with (silently reuse)
    // the first run's ledger — the run IDs differ despite an identical
    // timestamp component, and both ledgers independently load back their
    // own content.
    const first = createRun({ repoInfo, now: fixedNow });
    const second = createRun({ repoInfo, now: fixedNow });
    assert.notEqual(first.runId, second.runId);
    assert.equal(loadRun(repoInfo, first.runId).runId, first.runId);
    assert.equal(loadRun(repoInfo, second.runId).runId, second.runId);
  });

  test("loadRun throws a ContractError for a missing run", () => {
    const repoInfo = tmpRepoInfo();
    assertThrowsContract(() => loadRun(repoInfo, "20260718T153000Z-ffffffff"));
  });

  test("loadRun throws a ContractError for a corrupt run.json", () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    writeFileSync(paths.runFile, "{not valid json", "utf8");
    assertThrowsContract(() => loadRun(repoInfo, run.runId));
  });
});

// --------------------------------------------------------------------------
// Atomicity
// --------------------------------------------------------------------------

describe("updateRun — atomicity", () => {
  test("updateRun persists a reduced run and leaves no leftover temp files", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    await updateRun(repoInfo, run.runId, { type: "START_GRADING", operation: op("grading") });
    const paths = getRunPaths(repoInfo, run.runId);
    const entries = readdirSync(paths.dir);
    assert.ok(!entries.some((e) => e.startsWith(".run.json.tmp-")), `leftover temp files: ${entries}`);
    const persisted = loadRun(repoInfo, run.runId);
    assert.equal(persisted.phase, Phase.GRADING);
  });

  test("updateRun's on-disk result always parses as complete, well-formed JSON (no torn writes observable)", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    let current = run;
    const events = [
      { type: "START_GRADING", operation: op("grading") },
      { type: "GRADING_COMPLETE", complexityRef: "complexity.json" },
      { type: "ACCEPT_PLAN", baseCommit: "a".repeat(40), approvalIds: [] },
      { type: "RUN_WAVE_1", operation: op("wave-1") },
    ];
    for (const event of events) {
      current = await updateRun(repoInfo, run.runId, event);
      const paths = getRunPaths(repoInfo, run.runId);
      const text = readFileSync(paths.runFile, "utf8");
      const parsed = JSON.parse(text); // throws on any torn/partial write
      assert.equal(parsed.phase, current.phase);
    }
    assert.equal(current.phase, Phase.WAVE_1_RUNNING);
  });

  test("updateRun rejects an event that has no legal transition from the run's current phase", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    await assert.rejects(
      () => updateRun(repoInfo, run.runId, { type: "WAVE_1_COMPLETE", checkpointRef: "x", integrationHead: "a".repeat(40) }),
      ContractError,
    );
    // The run was not mutated by the rejected attempt.
    assert.equal(loadRun(repoInfo, run.runId).phase, Phase.INITIALIZED);
  });
});

// --------------------------------------------------------------------------
// Locking: live rejection, stale recovery
// --------------------------------------------------------------------------

describe("withRunLock", () => {
  test("throws when no run ledger directory exists", async () => {
    const repoInfo = tmpRepoInfo();
    await assert.rejects(() => withRunLock(repoInfo, "20260718T153000Z-ffffffff", async () => {}), ContractError);
  });

  test("acquires, runs fn, releases, and removes the lock directory", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    let ranInsideLock = false;
    const result = await withRunLock(repoInfo, run.runId, async () => {
      ranInsideLock = existsSync(paths.lockDir);
      return 42;
    });
    assert.equal(ranInsideLock, true);
    assert.equal(result, 42);
    assert.equal(existsSync(paths.lockDir), false);
  });

  test("releases the lock even when fn throws", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    await assert.rejects(() => withRunLock(repoInfo, run.runId, async () => {
      throw new Error("boom");
    }));
    assert.equal(existsSync(paths.lockDir), false);
  });

  test("rejects a live lock (recorded pid is this test's own process, definitely alive)", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    await assert.rejects(() => withRunLock(repoInfo, run.runId, async () => {}), ContractError);
  });

  test("rejects a lock whose recorded process is absent but too young to be trusted stale", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    // A definitely-nonexistent PID, but recorded as acquired just now.
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: 2147483647, acquiredAt: new Date().toISOString() }));
    await assert.rejects(() => withRunLock(repoInfo, run.runId, async () => {}), ContractError);
  });

  test("rejects a lock with unverifiable (missing/corrupt) metadata — fails closed", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    // No info.json at all.
    await assert.rejects(() => withRunLock(repoInfo, run.runId, async () => {}), ContractError);
  });

  test("recovers a stale lock: recorded process absent AND age past the documented timeout", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago > 5-minute timeout
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: 2147483647, acquiredAt: longAgo }));
    let ran = false;
    await withRunLock(repoInfo, run.runId, async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  test("never infers success from a vanished PID alone: absent process + fresh age is still rejected, not silently recovered", async () => {
    // This is the same scenario as the "too young" test above, phrased as a
    // direct proof of the brief's specific requirement: a dead PID by
    // itself is not sufficient evidence of safe recovery.
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: 2147483647, acquiredAt: new Date().toISOString() }));
    await assert.rejects(() => withRunLock(repoInfo, run.runId, async () => {}), ContractError);
  });

  test("a genuinely-exited child process's lock is recoverable once its age passes the timeout", async () => {
    // Spawn and wait for a real, short-lived child so its pid is
    // authoritatively dead (not just "probably" via a magic number).
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(child.status, 0);
    const deadPid = child.pid;

    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: deadPid, acquiredAt: longAgo }));

    let ran = false;
    await withRunLock(repoInfo, run.runId, async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  test("updateRun refuses to proceed under a live lock held by another logical writer", async () => {
    const repoInfo = tmpRepoInfo();
    const run = createRun({ repoInfo });
    const paths = getRunPaths(repoInfo, run.runId);
    mkdirSync(paths.lockDir, { mode: 0o700 });
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    await assert.rejects(() => updateRun(repoInfo, run.runId, { type: "START_GRADING", operation: op("grading") }), ContractError);
    // The run was not mutated.
    rmSync(paths.lockDir, { recursive: true, force: true });
    assert.equal(loadRun(repoInfo, run.runId).phase, Phase.INITIALIZED);
  });
});
