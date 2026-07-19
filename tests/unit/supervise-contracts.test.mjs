// Unit tests for plugins/contexthub/scripts/supervise/contracts.mjs
// Run with: node --test tests/unit/supervise-contracts.test.mjs
//
// Every validator here sits on a trust boundary: Codex worker self-reports,
// Claude's own review passes, and the machine task/correction graphs are all
// model-authored artifacts the host must not trust at face value. These
// tests therefore favor "start from a known-valid fixture, mutate exactly
// one thing, assert the specific rejection" over loose fuzzing, so every
// rule in the brief has a directly traceable test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ContractError,
  validateComplexity,
  validateTaskGraph,
  validateCorrectionGraph,
  validateClaudeReview,
  validateWorkerReport,
  validateApprovalFlag,
  validateVerificationCommand,
  validateIdentifier,
  normalizeRepoPath,
  pathsOverlap,
} from "../../plugins/contexthub/scripts/supervise/contracts.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));

function assertThrowsContract(fn, messagePattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ContractError, `expected ContractError, got ${err}`);
    if (messagePattern) assert.match(err.message, messagePattern);
    return true;
  });
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

function validComplexity() {
  return {
    score: 3,
    confidence: 0.82,
    dimensions: { scope: 3, uncertainty: 2, coupling: 3, risk: 2, verification: 3 },
    reasons: ["Touches three components", "Needs integration tests"],
    risk_flags: [],
    unknowns: [],
    suggested_parallelism: 2,
    relevant_paths: ["plugins/codex/scripts/codex-invoke.mjs"],
    verification_hints: ["node --test tests/unit/codex-invoke.test.mjs"],
  };
}

function validWorkerReport() {
  return {
    status: "DONE",
    summary: "Added max effort support and regression tests.",
    acceptance: [{ id: "AC-06", status: "PASS", evidence: "tests/unit/codex-invoke.test.mjs" }],
    verification: [{ id: "codex-unit", status: "PASS", summary: "18 tests passed" }],
    concerns: [],
    blockers: [],
  };
}

function validApprovalFlag() {
  return {
    id: "approval-01",
    category: "network",
    description: "The integration test contacts the local test service.",
    status: "PENDING",
    prompt: "Allow the declared local-network integration check?",
    evidence_paths: [],
    created_at: "2026-07-18T15:30:00Z",
    decided_at: null,
  };
}

function validVerificationCommand() {
  return {
    id: "codex-unit",
    argv: ["node", "--test", "tests/unit/codex-invoke.test.mjs"],
    cwd: ".",
    requires_approval_ids: [],
  };
}

const SHA1_BASE = "0123456789abcdef0123456789abcdef01234567";
const SHA1_HEAD2 = "fedcba9876543210fedcba9876543210fedcba98";

function validTaskGraph() {
  return {
    version: 1,
    run_id: "20260718T153000Z-a1b2c3d4",
    base_commit: SHA1_BASE,
    complexity_review: { grader_score: 3, claude_score: 4, override_reason: "A persisted public format changes." },
    acceptance: [{ id: "AC-06", text: "Official reasoning efforts are enforced." }],
    approval_flags: [validApprovalFlag()],
    final_verification: [validVerificationCommand()],
    tasks: [
      {
        id: "t1",
        wave: 1,
        objective: "Update effort validation with tests.",
        depends_on: [],
        read_paths: ["plugins/codex/", "tests/unit/codex-invoke.test.mjs"],
        write_paths: ["plugins/codex/scripts/codex-invoke.mjs", "tests/unit/codex-invoke.test.mjs"],
        acceptance_ids: ["AC-06"],
        verify: [validVerificationCommand()],
        effort: "xhigh",
        risk: "high",
      },
    ],
  };
}

function validCorrectionGraph() {
  return {
    version: 1,
    run_id: "20260718T153000Z-a1b2c3d4",
    wave: 2,
    base_commit: SHA1_HEAD2,
    source_review: "review.json",
    tasks: [
      {
        id: "c1",
        objective: "Fix the gap identified in review.",
        depends_on: [],
        read_paths: ["plugins/codex/"],
        write_paths: ["plugins/codex/scripts/codex-invoke.mjs"],
        acceptance_ids: ["AC-06"],
        verify: [validVerificationCommand()],
        effort: "high",
        risk: "medium",
        source_task_id: "t1",
        session_policy: "fresh",
      },
    ],
  };
}

function validClaudeReview() {
  return {
    acceptance: [
      { id: "AC-06", status: "SATISFIED", evidence_paths: ["receipts/t1.json"], reason: "The wrapper tests cover every supported effort." },
    ],
    summary: "Wave one satisfies every required criterion.",
  };
}

// --------------------------------------------------------------------------
// validateComplexity
// --------------------------------------------------------------------------

describe("validateComplexity", () => {
  test("accepts the brief's worked example", () => {
    const v = validComplexity();
    assert.equal(validateComplexity(v), v);
  });

  test("rejects a non-object", () => {
    assertThrowsContract(() => validateComplexity("nope"));
    assertThrowsContract(() => validateComplexity(null));
    assertThrowsContract(() => validateComplexity([1, 2]));
  });

  test("rejects unknown top-level fields", () => {
    const v = validComplexity();
    v.extra = "nope";
    assertThrowsContract(() => validateComplexity(v), /unknown field/);
  });

  test("rejects a missing required field", () => {
    const v = validComplexity();
    delete v.confidence;
    assertThrowsContract(() => validateComplexity(v), /missing required field/);
  });

  for (const bad of [0, 6, 1.5, "3", null]) {
    test(`rejects score = ${JSON.stringify(bad)}`, () => {
      const v = validComplexity();
      v.score = bad;
      assertThrowsContract(() => validateComplexity(v));
    });
  }

  for (const bad of [-0.01, 1.01, "0.5", null]) {
    test(`rejects confidence = ${JSON.stringify(bad)}`, () => {
      const v = validComplexity();
      v.confidence = bad;
      assertThrowsContract(() => validateComplexity(v));
    });
  }

  test("accepts confidence at the boundaries 0 and 1", () => {
    const a = validComplexity();
    a.confidence = 0;
    assert.equal(validateComplexity(a).confidence, 0);
    const b = validComplexity();
    b.confidence = 1;
    assert.equal(validateComplexity(b).confidence, 1);
  });

  test("rejects an unknown dimensions field", () => {
    const v = validComplexity();
    v.dimensions.extra = 1;
    assertThrowsContract(() => validateComplexity(v), /unknown field/);
  });

  test("rejects a dimension out of 1-5", () => {
    const v = validComplexity();
    v.dimensions.scope = 6;
    assertThrowsContract(() => validateComplexity(v));
  });

  test("rejects more than 5 reasons", () => {
    const v = validComplexity();
    v.reasons = Array(6).fill("x");
    assertThrowsContract(() => validateComplexity(v), /max 5/);
  });

  test("rejects more than 8 risk_flags", () => {
    const v = validComplexity();
    v.risk_flags = Array(9).fill("x");
    assertThrowsContract(() => validateComplexity(v), /max 8/);
  });

  test("rejects more than 8 unknowns", () => {
    const v = validComplexity();
    v.unknowns = Array(9).fill("x");
    assertThrowsContract(() => validateComplexity(v), /max 8/);
  });

  test("rejects a string longer than 240 characters", () => {
    const v = validComplexity();
    v.reasons = ["x".repeat(241)];
    assertThrowsContract(() => validateComplexity(v));
  });

  test("accepts a string at exactly 240 characters", () => {
    const v = validComplexity();
    v.reasons = ["x".repeat(240)];
    assert.ok(validateComplexity(v));
  });

  for (const bad of [0, 4, 1.5]) {
    test(`rejects suggested_parallelism = ${bad}`, () => {
      const v = validComplexity();
      v.suggested_parallelism = bad;
      assertThrowsContract(() => validateComplexity(v));
    });
  }

  test("rejects more than 12 relevant_paths", () => {
    const v = validComplexity();
    v.relevant_paths = Array(13).fill("a");
    assertThrowsContract(() => validateComplexity(v), /max 12/);
  });

  test("rejects an absolute relevant_path", () => {
    const v = validComplexity();
    v.relevant_paths = ["/etc/passwd"];
    assertThrowsContract(() => validateComplexity(v));
  });

  test("rejects more than 8 verification_hints", () => {
    const v = validComplexity();
    v.verification_hints = Array(9).fill("x");
    assertThrowsContract(() => validateComplexity(v), /max 8/);
  });

  test("rejects a serialized object over 4096 UTF-8 bytes", () => {
    const v = validComplexity();
    v.reasons = ["x".repeat(240), "y".repeat(240), "z".repeat(240), "w".repeat(240), "q".repeat(240)];
    v.risk_flags = Array(8).fill("r".repeat(240));
    v.unknowns = Array(8).fill("u".repeat(240));
    v.relevant_paths = Array(12).fill("plugins/" + "p".repeat(200));
    v.verification_hints = Array(8).fill("v".repeat(240));
    assertThrowsContract(() => validateComplexity(v), /UTF-8 bytes/);
  });

  test("byte cap is measured on multi-byte UTF-8, not character count", () => {
    const v = validComplexity();
    // Each CJK character is 3 UTF-8 bytes but 1 JS string character, so this
    // is well within the 240-char field caps yet can still blow the 4096
    // overall byte cap if repeated enough. Use a size guaranteed to exceed
    // the byte budget without exceeding any per-field character limit.
    v.reasons = [ "国".repeat(200) ]; // 200 chars, 600 bytes
    v.risk_flags = Array(8).fill("国".repeat(200));
    v.unknowns = Array(8).fill("国".repeat(200));
    assertThrowsContract(() => validateComplexity(v), /UTF-8 bytes/);
  });
});

// --------------------------------------------------------------------------
// validateWorkerReport
// --------------------------------------------------------------------------

describe("validateWorkerReport", () => {
  test("accepts the brief's worked example", () => {
    const v = validWorkerReport();
    assert.equal(validateWorkerReport(v, ["AC-06"]), v);
  });

  test("rejects unknown top-level fields", () => {
    const v = validWorkerReport();
    v.extra = 1;
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /unknown field/);
  });

  test("rejects an unknown status", () => {
    const v = validWorkerReport();
    v.status = "MAYBE_DONE";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]));
  });

  test("rejects a serialized report over 4096 UTF-8 bytes", () => {
    const v = validWorkerReport();
    v.summary = "x".repeat(480);
    v.acceptance = Array.from({ length: 40 }, (_, i) => ({
      id: `AC-${String((i % 90) + 10)}`, status: "PASS", evidence: "e".repeat(240),
    }));
    v.verification = Array.from({ length: 24 }, (_, i) => ({
      id: `verify-${i}`, status: "PASS", summary: "s".repeat(240),
    }));
    assertThrowsContract(() => validateWorkerReport(v, v.acceptance.map((a) => a.id)), /UTF-8 bytes/);
  });

  test("DONE requires every assigned acceptance ID exactly once as PASS", () => {
    const v = validWorkerReport();
    // Missing one of two assigned IDs.
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06", "AC-07"]), /exactly once/);
  });

  test("DONE rejects a duplicated acceptance ID even if all are PASS", () => {
    const v = validWorkerReport();
    v.acceptance.push({ id: "AC-06", status: "PASS", evidence: "again" });
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /duplicate/);
  });

  test("DONE rejects an assigned ID reported as FAIL", () => {
    const v = validWorkerReport();
    v.acceptance[0].status = "FAIL";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /PASS/);
  });

  test("DONE rejects an assigned ID reported as UNCERTAIN", () => {
    const v = validWorkerReport();
    v.acceptance[0].status = "UNCERTAIN";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]));
  });

  test("DONE rejects a declared verification that is not PASS", () => {
    const v = validWorkerReport();
    v.verification[0].status = "FAIL";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /verification/);
  });

  test("DONE rejects a declared verification left NOT_RUN", () => {
    const v = validWorkerReport();
    v.verification[0].status = "NOT_RUN";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]));
  });

  test("DONE rejects any blockers", () => {
    const v = validWorkerReport();
    v.blockers = ["something is wrong"];
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /blockers/);
  });

  test("DONE rejects any concerns (use DONE_WITH_CONCERNS instead)", () => {
    const v = validWorkerReport();
    v.concerns = ["minor style nit"];
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /concerns/);
  });

  test("DONE_WITH_CONCERNS accepts the same acceptance/verification coverage plus concerns", () => {
    const v = validWorkerReport();
    v.status = "DONE_WITH_CONCERNS";
    v.concerns = ["Left a TODO for a follow-up refactor."];
    assert.equal(validateWorkerReport(v, ["AC-06"]).status, "DONE_WITH_CONCERNS");
  });

  test("DONE_WITH_CONCERNS requires at least one concern", () => {
    const v = validWorkerReport();
    v.status = "DONE_WITH_CONCERNS";
    v.concerns = [];
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /at least one concern/);
  });

  test("DONE_WITH_CONCERNS still rejects blockers", () => {
    const v = validWorkerReport();
    v.status = "DONE_WITH_CONCERNS";
    v.concerns = ["noted"];
    v.blockers = ["actually blocked"];
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /blockers/);
  });

  test("DONE_WITH_CONCERNS still requires full acceptance/verification coverage", () => {
    const v = validWorkerReport();
    v.status = "DONE_WITH_CONCERNS";
    v.concerns = ["noted"];
    v.acceptance[0].status = "FAIL";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]));
  });

  test("NEEDS_CONTEXT requires at least one blocker", () => {
    const v = validWorkerReport();
    v.status = "NEEDS_CONTEXT";
    v.acceptance = [];
    v.verification = [];
    v.blockers = [];
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /blocker/);
  });

  test("NEEDS_CONTEXT with a blocker is valid and does not require acceptance coverage", () => {
    const v = validWorkerReport();
    v.status = "NEEDS_CONTEXT";
    v.acceptance = [];
    v.verification = [];
    v.blockers = ["The repository already has uncommitted local changes I cannot safely resolve."];
    assert.equal(validateWorkerReport(v, ["AC-06"]).status, "NEEDS_CONTEXT");
  });

  test("BLOCKED requires at least one blocker", () => {
    const v = validWorkerReport();
    v.status = "BLOCKED";
    v.acceptance = [];
    v.verification = [];
    v.blockers = [];
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]), /blocker/);
  });

  test("BLOCKED with a blocker is valid", () => {
    const v = validWorkerReport();
    v.status = "BLOCKED";
    v.acceptance = [];
    v.verification = [];
    v.blockers = ["Timed out waiting for a dependency install."];
    assert.equal(validateWorkerReport(v, ["AC-06"]).status, "BLOCKED");
  });

  test("rejects a malformed acceptance ID", () => {
    const v = validWorkerReport();
    v.acceptance[0].id = "AC-6";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-6"]));
  });

  test("rejects a malformed verification ID", () => {
    const v = validWorkerReport();
    v.verification[0].id = "Codex_Unit";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]));
  });

  test("rejects internally inconsistent reports without needing repository access (pure function)", () => {
    // No filesystem/git handle is passed anywhere in this call — the
    // function signature itself proves it cannot touch git.
    const v = validWorkerReport();
    v.acceptance[0].status = "FAIL";
    assertThrowsContract(() => validateWorkerReport(v, ["AC-06"]));
  });
});

// --------------------------------------------------------------------------
// validateApprovalFlag
// --------------------------------------------------------------------------

describe("validateApprovalFlag", () => {
  test("accepts the brief's worked example", () => {
    const v = validApprovalFlag();
    assert.equal(validateApprovalFlag(v), v);
  });

  test("rejects a malformed approval ID", () => {
    const v = validApprovalFlag();
    v.id = "approval-1";
    assertThrowsContract(() => validateApprovalFlag(v));
  });

  test("rejects an unknown category", () => {
    const v = validApprovalFlag();
    v.category = "vibes";
    assertThrowsContract(() => validateApprovalFlag(v));
  });

  for (const category of [
    "destructive", "dependency", "network", "credential", "data-migration",
    "security-api-decision", "scope-expansion", "external-action", "product-decision",
  ]) {
    test(`accepts category "${category}"`, () => {
      const v = validApprovalFlag();
      v.category = category;
      assert.equal(validateApprovalFlag(v).category, category);
    });
  }

  test("PENDING requires decided_at to be null", () => {
    const v = validApprovalFlag();
    v.decided_at = "2026-07-18T16:00:00Z";
    assertThrowsContract(() => validateApprovalFlag(v), /decided_at/);
  });

  test("APPROVED requires a decided_at timestamp", () => {
    const v = validApprovalFlag();
    v.status = "APPROVED";
    v.decided_at = null;
    v.evidence_paths = ["approvals/approval-01.json"];
    assertThrowsContract(() => validateApprovalFlag(v));
  });

  test("APPROVED requires at least one evidence path", () => {
    const v = validApprovalFlag();
    v.status = "APPROVED";
    v.decided_at = "2026-07-18T16:00:00Z";
    v.evidence_paths = [];
    assertThrowsContract(() => validateApprovalFlag(v), /evidence/);
  });

  test("REJECTED with evidence and a valid decided_at is accepted", () => {
    const v = validApprovalFlag();
    v.status = "REJECTED";
    v.decided_at = "2026-07-18T16:00:00Z";
    v.evidence_paths = ["approvals/approval-01.json"];
    assert.equal(validateApprovalFlag(v).status, "REJECTED");
  });

  test("rejects decided_at earlier than created_at", () => {
    const v = validApprovalFlag();
    v.status = "APPROVED";
    v.created_at = "2026-07-18T16:00:00Z";
    v.decided_at = "2026-07-18T15:00:00Z";
    v.evidence_paths = ["approvals/approval-01.json"];
    assertThrowsContract(() => validateApprovalFlag(v), /decided_at/);
  });

  test("rejects a non-ISO created_at", () => {
    const v = validApprovalFlag();
    v.created_at = "yesterday";
    assertThrowsContract(() => validateApprovalFlag(v));
  });

  test("rejects an absolute evidence path", () => {
    const v = validApprovalFlag();
    v.status = "APPROVED";
    v.decided_at = "2026-07-18T16:00:00Z";
    v.evidence_paths = ["/etc/passwd"];
    assertThrowsContract(() => validateApprovalFlag(v));
  });
});

// --------------------------------------------------------------------------
// validateVerificationCommand
// --------------------------------------------------------------------------

describe("validateVerificationCommand", () => {
  test("accepts the brief's worked example", () => {
    const v = validVerificationCommand();
    assert.equal(validateVerificationCommand(v, []), v);
  });

  test("rejects an empty argv", () => {
    const v = validVerificationCommand();
    v.argv = [];
    assertThrowsContract(() => validateVerificationCommand(v, []), /argv/);
  });

  for (const shell of ["sh", "bash", "zsh", "/bin/bash", "powershell"]) {
    test(`rejects a shell interpreter as argv[0]: ${shell}`, () => {
      const v = validVerificationCommand();
      v.argv = [shell, "-c", "echo hi"];
      assertThrowsContract(() => validateVerificationCommand(v, []), /shell interpreter/);
    });
  }

  // Final whole-branch review finding: SHELL_INTERPRETERS already lists
  // cmd.exe/powershell.exe/pwsh.exe explicitly, so Windows was in scope --
  // but bash.exe/sh.exe (exactly what Git-for-Windows installs) were
  // ACCEPTED, because basenameOf() never stripped the .exe extension before
  // comparing against the bare "bash"/"sh" entries.
  for (const shell of ["bash.exe", "sh.exe", "BASH.EXE", "C:\\Windows\\System32\\bash.exe"]) {
    test(`rejects the .exe bypass: ${shell}`, () => {
      const v = validVerificationCommand();
      v.argv = [shell, "-c", "echo hi"];
      assertThrowsContract(() => validateVerificationCommand(v, []), /shell interpreter/);
    });
  }

  for (const cmd of [["rm", "-rf", "dist"], ["sudo", "reboot"], ["curl", "http://x"], ["wget", "http://x"]]) {
    test(`rejects unsafe command: ${cmd[0]}`, () => {
      const v = validVerificationCommand();
      v.argv = cmd;
      assertThrowsContract(() => validateVerificationCommand(v, []));
    });
  }

  // --- Critical 1 regression: checking only argv[0] was a total bypass of
  // the shell-interpreter ban. Task 9 executes these arrays with
  // `shell: false`, which does not help when argv[0] is itself an
  // exec-wrapper like `env` or `timeout`. These three argv arrays were all
  // ACCEPTED before the fix.
  const ARGV0_BYPASSES = [
    ["env", "bash", "-c", "rm -rf /"],
    ["timeout", "60", "sh", "-c", "curl x|sh"],
    ["xargs", "rm"],
  ];
  for (const argv of ARGV0_BYPASSES) {
    test(`rejects the argv[0] wrapper bypass: ${JSON.stringify(argv)}`, () => {
      const v = validVerificationCommand();
      v.argv = argv;
      assertThrowsContract(() => validateVerificationCommand(v, []));
    });
  }

  test("rejects a shell interpreter at ANY argv position, not just argv[0]", () => {
    for (const argv of [
      ["make", "test", "&&", "bash"],
      ["node", "--test", "sh"],
      ["make", "/bin/zsh"],
    ]) {
      const v = validVerificationCommand();
      v.argv = argv;
      assertThrowsContract(() => validateVerificationCommand(v, []), /shell interpreter/);
    }
  });

  for (const wrapper of ["env", "timeout", "nice", "nohup", "xargs", "stdbuf"]) {
    test(`rejects command wrapper as argv[0]: ${wrapper}`, () => {
      const v = validVerificationCommand();
      v.argv = [wrapper, "node", "--test"];
      assertThrowsContract(() => validateVerificationCommand(v, []), /wrapper/);
    });
  }

  test("rejects an unsafe command at a non-zero argv position", () => {
    const v = validVerificationCommand();
    v.argv = ["make", "check", "curl"];
    assertThrowsContract(() => validateVerificationCommand(v, []), /not a permitted/);
  });

  for (const sub of ["push", "reset", "clean"]) {
    test(`rejects git ${sub}`, () => {
      const v = validVerificationCommand();
      v.argv = ["git", sub, "--force"];
      assertThrowsContract(() => validateVerificationCommand(v, []), /git/);
    });
  }

  test("allows other git subcommands (e.g. status)", () => {
    const v = validVerificationCommand();
    v.argv = ["git", "status", "--porcelain"];
    assert.ok(validateVerificationCommand(v, []));
  });

  for (const pm of ["npm", "pnpm", "yarn", "pip", "cargo"]) {
    test(`rejects package install via ${pm}`, () => {
      const v = validVerificationCommand();
      v.argv = [pm, "install"];
      assertThrowsContract(() => validateVerificationCommand(v, []), /package/);
    });
  }

  test("allows npm test (non-mutating)", () => {
    const v = validVerificationCommand();
    v.argv = ["npm", "test"];
    assert.ok(validateVerificationCommand(v, []));
  });

  test("rejects a deploy command", () => {
    const v = validVerificationCommand();
    v.argv = ["make", "deploy"];
    assertThrowsContract(() => validateVerificationCommand(v, []), /deploy/);
  });

  test("rejects a cwd that escapes the repository", () => {
    const v = validVerificationCommand();
    v.cwd = "../../etc";
    assertThrowsContract(() => validateVerificationCommand(v, []));
  });

  test("accepts cwd '.' as the repository root", () => {
    const v = validVerificationCommand();
    v.cwd = ".";
    assert.equal(validateVerificationCommand(v, []).cwd, ".");
  });

  test("rejects requires_approval_ids referencing an unknown approval", () => {
    const v = validVerificationCommand();
    v.requires_approval_ids = ["approval-99"];
    assertThrowsContract(() => validateVerificationCommand(v, [validApprovalFlag()]), /unknown approval/);
  });

  test("accepts requires_approval_ids that reference a known approval", () => {
    const v = validVerificationCommand();
    v.requires_approval_ids = ["approval-01"];
    assert.ok(validateVerificationCommand(v, [validApprovalFlag()]));
  });

  test("skips the known-approval cross-check when approvalFlags is omitted", () => {
    const v = validVerificationCommand();
    v.requires_approval_ids = ["approval-01"];
    assert.ok(validateVerificationCommand(v, undefined));
  });
});

// --------------------------------------------------------------------------
// validateIdentifier / normalizeRepoPath / pathsOverlap
// --------------------------------------------------------------------------

describe("validateIdentifier", () => {
  test("accepts a well-formed run ID", () => {
    assert.equal(validateIdentifier("run", "20260718T153000Z-a1b2c3d4"), "20260718T153000Z-a1b2c3d4");
  });

  for (const bad of ["2026718T153000Z-a1b2c3d4", "20260718T153000-a1b2c3d4", "20260718T153000Z-A1B2C3D4", "20260718T153000Z-a1b2c3d"]) {
    test(`rejects a malformed run ID: ${bad}`, () => {
      assertThrowsContract(() => validateIdentifier("run", bad));
    });
  }

  test("accepts a well-formed task ID", () => {
    assert.equal(validateIdentifier("task", "t1"), "t1");
  });

  for (const bad of ["T1", "1task", "task_1", "t" + "x".repeat(32), "t;rm -rf"]) {
    test(`rejects a malformed task ID: ${JSON.stringify(bad)}`, () => {
      assertThrowsContract(() => validateIdentifier("task", bad));
    });
  }

  test("accepts a well-formed acceptance ID", () => {
    assert.equal(validateIdentifier("acceptance", "AC-06"), "AC-06");
    assert.equal(validateIdentifier("acceptance", "AC-123"), "AC-123");
  });

  for (const bad of ["AC-6", "AC-1234", "ac-06", "AC06"]) {
    test(`rejects a malformed acceptance ID: ${bad}`, () => {
      assertThrowsContract(() => validateIdentifier("acceptance", bad));
    });
  }

  test("accepts a well-formed approval ID", () => {
    assert.equal(validateIdentifier("approval", "approval-01"), "approval-01");
  });

  for (const bad of ["approval-1", "approval-1234", "Approval-01"]) {
    test(`rejects a malformed approval ID: ${bad}`, () => {
      assertThrowsContract(() => validateIdentifier("approval", bad));
    });
  }

  test("rejects an unknown identifier kind", () => {
    assertThrowsContract(() => validateIdentifier("branch", "main"), /unknown identifier kind/);
  });
});

describe("normalizeRepoPath", () => {
  test("preserves a plain file path", () => {
    assert.equal(normalizeRepoPath("plugins/codex/scripts/codex-invoke.mjs"), "plugins/codex/scripts/codex-invoke.mjs");
  });

  test("preserves a directory root's trailing slash", () => {
    assert.equal(normalizeRepoPath("plugins/codex/"), "plugins/codex/");
  });

  test("collapses duplicate slashes and a leading ./", () => {
    assert.equal(normalizeRepoPath("./plugins//codex/scripts/x.mjs"), "plugins/codex/scripts/x.mjs");
  });

  test("accepts the repository root '.'", () => {
    assert.equal(normalizeRepoPath("."), ".");
  });

  test("rejects an empty path", () => {
    assertThrowsContract(() => normalizeRepoPath(""));
  });

  test("rejects an absolute path", () => {
    assertThrowsContract(() => normalizeRepoPath("/etc/passwd"), /absolute/);
  });

  test("rejects a home-relative path", () => {
    assertThrowsContract(() => normalizeRepoPath("~/secrets"));
  });

  test("rejects a Windows drive-absolute path", () => {
    assertThrowsContract(() => normalizeRepoPath("C:\\Windows\\System32"));
  });

  test("rejects '..' traversal", () => {
    assertThrowsContract(() => normalizeRepoPath("plugins/../../../etc/passwd"), /\.\./);
  });

  test("rejects a bare '..'", () => {
    assertThrowsContract(() => normalizeRepoPath(".."));
  });

  test("rejects a path referencing .git", () => {
    assertThrowsContract(() => normalizeRepoPath("plugins/.git/config"), /\.git/);
  });

  // --- Important 4 regression: the guard was case-sensitive. This repo runs
  // on macOS and the same applies on Windows, where ".GIT" resolves to the
  // real .git directory — so a task could have claimed write ownership of
  // ".GIT/hooks/pre-commit". All four of these were ACCEPTED before the fix.
  for (const bad of [".GIT/config", ".Git/hooks/pre-commit", "plugins/.GIT", "plugins/.gIt/x"]) {
    test(`rejects a mixed-case .git reference: ${bad}`, () => {
      assertThrowsContract(() => normalizeRepoPath(bad), /\.git/);
    });
  }

  test("does not reject legitimate paths that merely start with .git-like text", () => {
    assert.equal(normalizeRepoPath(".gitignore"), ".gitignore");
    assert.equal(normalizeRepoPath(".github/workflows/ci.yml"), ".github/workflows/ci.yml");
  });

  test("rejects shell metacharacters", () => {
    for (const bad of ["a;rm -rf b", "a$(whoami)", "a`whoami`", "a|b", "a>b", "a<b", "a&b", 'a"b', "a'b"]) {
      assertThrowsContract(() => normalizeRepoPath(bad), null);
    }
  });

  test("rejects glob metacharacters (v6 does not support glob expansion)", () => {
    for (const bad of ["plugins/*.mjs", "plugins/[abc].mjs", "plugins/?.mjs"]) {
      assertThrowsContract(() => normalizeRepoPath(bad));
    }
  });

  test("rejects control characters", () => {
    assertThrowsContract(() => normalizeRepoPath("plugins/\x00evil"));
  });
});

describe("pathsOverlap", () => {
  test("equal paths overlap", () => {
    assert.equal(pathsOverlap("a/b.mjs", "a/b.mjs"), true);
  });

  test("a directory root overlaps a file beneath it", () => {
    assert.equal(pathsOverlap("plugins/codex/", "plugins/codex/scripts/codex-invoke.mjs"), true);
  });

  test("overlap is symmetric", () => {
    assert.equal(pathsOverlap("plugins/codex/scripts/codex-invoke.mjs", "plugins/codex/"), true);
  });

  test("sibling files do not overlap", () => {
    assert.equal(pathsOverlap("plugins/codex/a.mjs", "plugins/codex/b.mjs"), false);
  });

  test("sibling directories with a shared prefix do not overlap", () => {
    assert.equal(pathsOverlap("plugins/codex/", "plugins/codex-extra/"), false);
  });

  test("the repository root overlaps everything", () => {
    assert.equal(pathsOverlap(".", "plugins/codex/a.mjs"), true);
  });
});

// --------------------------------------------------------------------------
// validateTaskGraph
// --------------------------------------------------------------------------

describe("validateTaskGraph", () => {
  const opts = { objectFormat: "sha1" };

  test("accepts the brief's worked example", () => {
    const v = validTaskGraph();
    assert.equal(validateTaskGraph(v, opts), v);
  });

  test("accepts a 64-char sha256 base_commit when objectFormat is sha256", () => {
    const v = validTaskGraph();
    v.base_commit = "a".repeat(64);
    assert.ok(validateTaskGraph(v, { objectFormat: "sha256" }));
  });

  test("rejects a sha1-length commit under objectFormat sha256", () => {
    const v = validTaskGraph();
    assertThrowsContract(() => validateTaskGraph(v, { objectFormat: "sha256" }));
  });

  test("rejects an abbreviated commit id", () => {
    const v = validTaskGraph();
    v.base_commit = SHA1_BASE.slice(0, 12);
    assertThrowsContract(() => validateTaskGraph(v, opts), /object ID/);
  });

  test("rejects an uppercase commit id", () => {
    const v = validTaskGraph();
    v.base_commit = SHA1_BASE.toUpperCase();
    assertThrowsContract(() => validateTaskGraph(v, opts));
  });

  test("rejects version !== 1", () => {
    const v = validTaskGraph();
    v.version = 2;
    assertThrowsContract(() => validateTaskGraph(v, opts), /version/);
  });

  test("rejects a malformed run_id", () => {
    const v = validTaskGraph();
    v.run_id = "not-a-run-id";
    assertThrowsContract(() => validateTaskGraph(v, opts));
  });

  test("rejects a run_id mismatch against options.runId", () => {
    const v = validTaskGraph();
    assertThrowsContract(() => validateTaskGraph(v, { ...opts, runId: "20260101T000000Z-00000000" }), /does not match/);
  });

  test("requires override_reason when claude_score differs from grader_score", () => {
    const v = validTaskGraph();
    v.complexity_review.override_reason = null;
    assertThrowsContract(() => validateTaskGraph(v, opts));
  });

  test("rejects a non-null override_reason when scores match", () => {
    const v = validTaskGraph();
    v.complexity_review.claude_score = v.complexity_review.grader_score;
    assertThrowsContract(() => validateTaskGraph(v, opts), /override_reason must be null/);
  });

  test("accepts a null override_reason when scores match", () => {
    const v = validTaskGraph();
    v.complexity_review.claude_score = v.complexity_review.grader_score;
    v.complexity_review.override_reason = null;
    assert.ok(validateTaskGraph(v, opts));
  });

  test("rejects duplicate acceptance IDs", () => {
    const v = validTaskGraph();
    v.acceptance.push({ id: "AC-06", text: "Duplicate." });
    assertThrowsContract(() => validateTaskGraph(v, opts), /duplicate/);
  });

  test("rejects more than 40 acceptance criteria", () => {
    const v = validTaskGraph();
    v.acceptance = Array.from({ length: 41 }, (_, i) => ({ id: `AC-${10 + i}`, text: "x" }));
    // Every id must still be covered, so give every task every id via a
    // single wave-1 task referencing them all (still under the 40 acceptance
    // cap check itself, which fires first).
    v.tasks[0].acceptance_ids = v.acceptance.map((a) => a.id);
    assertThrowsContract(() => validateTaskGraph(v, opts), /max 40/);
  });

  test("rejects more than 12 tasks in a wave", () => {
    const v = validTaskGraph();
    v.tasks = Array.from({ length: 13 }, (_, i) => ({
      ...clone(v.tasks[0]),
      id: `t${i + 1}`,
      write_paths: [`plugins/codex/scripts/t${i + 1}.mjs`],
    }));
    assertThrowsContract(() => validateTaskGraph(v, opts), /max 12/);
  });

  test("rejects a task with a non-empty depends_on (wave-one tasks start from the same base)", () => {
    const v = validTaskGraph();
    v.tasks.push({
      ...clone(v.tasks[0]),
      id: "t2",
      depends_on: ["t1"],
      write_paths: ["plugins/codex/scripts/other.mjs"],
    });
    assertThrowsContract(() => validateTaskGraph(v, opts), /same-wave dependency is unsound/);
  });

  test("rejects a depends_on referencing an unknown task", () => {
    const v = validTaskGraph();
    v.tasks.push({
      ...clone(v.tasks[0]),
      id: "t2",
      depends_on: ["ghost"],
      write_paths: ["plugins/codex/scripts/other.mjs"],
    });
    assertThrowsContract(() => validateTaskGraph(v, opts), /unknown task/);
  });

  test("rejects a dependency cycle between two valid same-graph tasks", () => {
    const v = validTaskGraph();
    v.tasks[0].depends_on = ["t2"];
    v.tasks.push({
      ...clone(v.tasks[0]),
      id: "t2",
      depends_on: ["t1"],
      write_paths: ["plugins/codex/scripts/other.mjs"],
    });
    assertThrowsContract(() => validateTaskGraph(v, opts), /cycle/);
  });

  test("rejects duplicate task IDs", () => {
    const v = validTaskGraph();
    v.tasks.push({ ...clone(v.tasks[0]), write_paths: ["plugins/codex/scripts/other.mjs"] });
    assertThrowsContract(() => validateTaskGraph(v, opts), /duplicate/);
  });

  test("rejects a task acceptance_ids reference to an unknown criterion", () => {
    const v = validTaskGraph();
    v.tasks[0].acceptance_ids = ["AC-99"];
    assertThrowsContract(() => validateTaskGraph(v, opts), /unknown acceptance criterion/);
  });

  test("rejects an uncovered acceptance criterion", () => {
    const v = validTaskGraph();
    v.acceptance.push({ id: "AC-07", text: "Not covered by any task." });
    assertThrowsContract(() => validateTaskGraph(v, opts), /not covered/);
  });

  test("rejects overlapping parallel write ownership", () => {
    const v = validTaskGraph();
    v.tasks.push({
      ...clone(v.tasks[0]),
      id: "t2",
      write_paths: ["plugins/codex/scripts/codex-invoke.mjs"], // same file as t1
    });
    assertThrowsContract(() => validateTaskGraph(v, opts), /overlapping/);
  });

  test("rejects overlapping write ownership via a directory root", () => {
    const v = validTaskGraph();
    v.tasks[0].write_paths = ["plugins/codex/"];
    v.tasks.push({
      ...clone(v.tasks[0]),
      id: "t2",
      write_paths: ["plugins/codex/scripts/other.mjs"],
    });
    assertThrowsContract(() => validateTaskGraph(v, opts), /overlapping/);
  });

  for (const effort of ["none", "low", "medium"]) {
    test(`rejects worker effort below high: "${effort}"`, () => {
      const v = validTaskGraph();
      v.tasks[0].effort = effort;
      assertThrowsContract(() => validateTaskGraph(v, opts), /high\|xhigh\|max/);
    });
  }

  test('rejects "ultra" as an effort value anywhere', () => {
    const v = validTaskGraph();
    v.tasks[0].effort = "ultra";
    assertThrowsContract(() => validateTaskGraph(v, opts));
  });

  test("max effort requires Claude's score to be 5", () => {
    const v = validTaskGraph();
    v.tasks[0].effort = "max";
    v.complexity_review.claude_score = 4;
    assertThrowsContract(() => validateTaskGraph(v, opts), /requires effort "max"/);
  });

  test("max effort is accepted when Claude's score is 5", () => {
    const v = validTaskGraph();
    v.tasks[0].effort = "max";
    v.complexity_review.claude_score = 5;
    v.complexity_review.override_reason = "Architecture-wide change.";
    assert.ok(validateTaskGraph(v, opts));
  });

  test("rejects more than one max task in a wave", () => {
    const v = validTaskGraph();
    v.complexity_review.claude_score = 5;
    v.complexity_review.override_reason = "Two large changes.";
    v.tasks[0].effort = "max";
    v.acceptance.push({ id: "AC-07", text: "Second criterion." });
    v.tasks.push({
      ...clone(v.tasks[0]),
      id: "t2",
      acceptance_ids: ["AC-07"],
      write_paths: ["plugins/codex/scripts/other.mjs"],
    });
    assertThrowsContract(() => validateTaskGraph(v, opts), /at most one "max"/);
  });

  test("rejects an empty write_paths on a task", () => {
    const v = validTaskGraph();
    v.tasks[0].write_paths = [];
    assertThrowsContract(() => validateTaskGraph(v, opts), /write_paths must not be empty/);
  });

  test("rejects an empty acceptance_ids on a task", () => {
    const v = validTaskGraph();
    v.tasks[0].acceptance_ids = [];
    assertThrowsContract(() => validateTaskGraph(v, opts));
  });

  test("rejects a task.wave that is not 1", () => {
    const v = validTaskGraph();
    v.tasks[0].wave = 2;
    assertThrowsContract(() => validateTaskGraph(v, opts), /must be exactly 1/);
  });

  test("rejects an unknown top-level field", () => {
    const v = validTaskGraph();
    v.extra = 1;
    assertThrowsContract(() => validateTaskGraph(v, opts), /unknown field/);
  });

  test("rejects a serialized graph over 65536 UTF-8 bytes", () => {
    const v = validTaskGraph();
    const longPath = (prefix, i) => `plugins/codex/${prefix}${"p".repeat(970)}-${i}.mjs`;
    v.tasks[0].objective = "x".repeat(480);
    v.tasks[0].read_paths = Array.from({ length: 40 }, (_, i) => longPath("r", i));
    v.tasks[0].write_paths = Array.from({ length: 40 }, (_, i) => longPath("w", i));
    assertThrowsContract(() => validateTaskGraph(v, opts), /UTF-8 bytes/);
  });

  test("an approval flag must be PENDING at plan-acceptance time", () => {
    const v = validTaskGraph();
    v.approval_flags[0].status = "APPROVED";
    v.approval_flags[0].decided_at = "2026-07-18T16:00:00Z";
    v.approval_flags[0].evidence_paths = ["approvals/approval-01.json"];
    assertThrowsContract(() => validateTaskGraph(v, opts), /PENDING/);
  });

  test("final_verification requires_approval_ids must reference a known approval", () => {
    const v = validTaskGraph();
    v.final_verification[0].requires_approval_ids = ["approval-99"];
    assertThrowsContract(() => validateTaskGraph(v, opts), /unknown approval/);
  });
});

// --------------------------------------------------------------------------
// validateCorrectionGraph
// --------------------------------------------------------------------------

describe("validateCorrectionGraph", () => {
  const opts = { objectFormat: "sha1" };

  test("accepts a well-formed correction graph", () => {
    const v = validCorrectionGraph();
    assert.equal(validateCorrectionGraph(v, opts), v);
  });

  test("rejects wave !== 2 (a third wave cannot be expressed even by typo)", () => {
    for (const bad of [1, 3, 0, "2", null]) {
      const v = validCorrectionGraph();
      v.wave = bad;
      assertThrowsContract(() => validateCorrectionGraph(v, opts), /wave must be exactly 2/);
    }
  });

  test("rejects source_review other than the literal 'review.json'", () => {
    const v = validCorrectionGraph();
    v.source_review = "review-2.json";
    assertThrowsContract(() => validateCorrectionGraph(v, opts));
  });

  test("rejects base_commit that does not match the expected integration HEAD", () => {
    const v = validCorrectionGraph();
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, expectedBaseCommit: SHA1_BASE }), /must exactly equal/);
  });

  test("accepts base_commit that matches the expected integration HEAD", () => {
    const v = validCorrectionGraph();
    assert.ok(validateCorrectionGraph(v, { ...opts, expectedBaseCommit: SHA1_HEAD2 }));
  });

  test("rejects a non-empty depends_on on a correction task", () => {
    const v = validCorrectionGraph();
    v.tasks.push({ ...clone(v.tasks[0]), id: "c2", depends_on: ["c1"], write_paths: ["plugins/other.mjs"] });
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /same-wave dependency is unsound/);
  });

  test("rejects a correction task missing source_task_id/session_policy fields", () => {
    const v = validCorrectionGraph();
    delete v.tasks[0].session_policy;
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /missing required field/);
  });

  test("session_policy resume-exact requires a non-null source_task_id", () => {
    const v = validCorrectionGraph();
    v.tasks[0].session_policy = "resume-exact";
    v.tasks[0].source_task_id = null;
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /resume-exact/);
  });

  test("session_policy resume-exact validates effort/ownership against wave-one tasks when supplied", () => {
    const v = validCorrectionGraph();
    v.tasks[0].session_policy = "resume-exact";
    v.tasks[0].effort = "xhigh";
    const waveOneTasksById = { t1: { effort: "high", write_paths: ["plugins/codex/scripts/codex-invoke.mjs"] } };
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, waveOneTasksById }), /unchanged effort/);
  });

  test("session_policy resume-exact rejects write_paths outside the source task's ownership", () => {
    const v = validCorrectionGraph();
    v.tasks[0].session_policy = "resume-exact";
    v.tasks[0].effort = "high";
    v.tasks[0].write_paths = ["plugins/codex/scripts/other.mjs"];
    const waveOneTasksById = { t1: { effort: "high", write_paths: ["plugins/codex/scripts/codex-invoke.mjs"] } };
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, waveOneTasksById }), /subset/);
  });

  test("session_policy resume-exact accepts a matching effort/ownership subset", () => {
    const v = validCorrectionGraph();
    v.tasks[0].session_policy = "resume-exact";
    v.tasks[0].effort = "high";
    v.tasks[0].write_paths = ["plugins/codex/scripts/codex-invoke.mjs"];
    const waveOneTasksById = { t1: { effort: "high", write_paths: ["plugins/codex/scripts/codex-invoke.mjs"] } };
    assert.ok(validateCorrectionGraph(v, { ...opts, waveOneTasksById }));
  });

  test("session_policy fresh allows a null source_task_id for cross-task corrections", () => {
    const v = validCorrectionGraph();
    v.tasks[0].session_policy = "fresh";
    v.tasks[0].source_task_id = null;
    assert.ok(validateCorrectionGraph(v, opts));
  });

  test("rejects an acceptance_ids reference outside the known plan (unrelated scope)", () => {
    const v = validCorrectionGraph();
    v.tasks[0].acceptance_ids = ["AC-99"];
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, acceptanceIds: ["AC-06"] }), /unrelated scope/);
  });

  test("requires every correction task to target at least one non-satisfied ID", () => {
    const v = validCorrectionGraph();
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, nonSatisfiedAcceptanceIds: ["AC-07"] }), /non-satisfied/);
  });

  test("accepts a correction task that targets a non-satisfied ID", () => {
    const v = validCorrectionGraph();
    assert.ok(validateCorrectionGraph(v, { ...opts, nonSatisfiedAcceptanceIds: ["AC-06"] }));
  });

  test("rejects when a non-satisfied ID is not covered by any correction task", () => {
    const v = validCorrectionGraph();
    assertThrowsContract(
      () => validateCorrectionGraph(v, { ...opts, nonSatisfiedAcceptanceIds: ["AC-06", "AC-07"] }),
      /does not cover/,
    );
  });

  test("rejects more than one max task and enforces the claude-score-5 gate", () => {
    const v = validCorrectionGraph();
    v.tasks[0].effort = "max";
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, claudeScore: 4 }), /requires effort "max"/);
  });

  // --- Important 3 regression: the max-effort gate was default-OPEN here.
  // validateTaskGraph always derives claudeScore from the graph's own
  // complexity_review, but a correction graph has no complexity_review, so
  // an omitted options.claudeScore silently WAIVED the gate. Verified
  // accepted before the fix.
  test("rejects a max-effort correction task when no claudeScore is supplied (default-closed)", () => {
    const v = validCorrectionGraph();
    v.tasks[0].effort = "max";
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /no score was supplied/);
  });

  test("accepts a max-effort correction task only when claudeScore is explicitly 5", () => {
    const v = validCorrectionGraph();
    v.tasks[0].effort = "max";
    assert.ok(validateCorrectionGraph(v, { ...opts, claudeScore: 5 }));
  });

  test("a null claudeScore does not waive the max-effort gate either", () => {
    const v = validCorrectionGraph();
    v.tasks[0].effort = "max";
    assertThrowsContract(() => validateCorrectionGraph(v, { ...opts, claudeScore: null }), /no score was supplied/);
  });

  test("non-max correction tasks are unaffected by an omitted claudeScore", () => {
    const v = validCorrectionGraph();
    v.tasks[0].effort = "xhigh";
    assert.ok(validateCorrectionGraph(v, opts));
  });

  test("rejects overlapping write ownership between correction tasks", () => {
    const v = validCorrectionGraph();
    v.tasks.push({ ...clone(v.tasks[0]), id: "c2" }); // same write_paths as c1
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /overlapping/);
  });

  test("a correction task's verify cannot reference an approval by default (corrections carry no approval_flags of their own)", () => {
    const v = validCorrectionGraph();
    v.tasks[0].verify[0].requires_approval_ids = ["approval-01"];
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /unknown approval/);
  });

  test("a correction task's verify may reference an approval from the original plan when threaded through options.approvalFlags", () => {
    const v = validCorrectionGraph();
    v.tasks[0].verify[0].requires_approval_ids = ["approval-01"];
    assert.ok(validateCorrectionGraph(v, { ...opts, approvalFlags: [validApprovalFlag()] }));
  });

  test("rejects a serialized correction graph over 65536 UTF-8 bytes", () => {
    const v = validCorrectionGraph();
    const longPath = (prefix, i) => `plugins/codex/${prefix}${"p".repeat(970)}-${i}.mjs`;
    v.tasks[0].objective = "x".repeat(480);
    v.tasks[0].read_paths = Array.from({ length: 40 }, (_, i) => longPath("r", i));
    v.tasks[0].write_paths = Array.from({ length: 40 }, (_, i) => longPath("w", i));
    assertThrowsContract(() => validateCorrectionGraph(v, opts), /UTF-8 bytes/);
  });

  test("no field on a correction task can be smuggled into a review shape", () => {
    // Structural proof, not a policy claim: validateClaudeReview's item shape
    // has exactly {id, status, evidence_paths, reason}. A correction task's
    // distinguishing fields (source_task_id, session_policy) are not among
    // them, so assertExactShape rejects them outright if attempted.
    const reviewItem = { id: "AC-06", status: "SATISFIED", evidence_paths: [], reason: "ok", source_task_id: "t1", session_policy: "fresh" };
    assertThrowsContract(
      () => validateClaudeReview({ acceptance: [reviewItem], summary: "x" }, { acceptanceIds: ["AC-06"], stage: "wave-one" }),
      /unknown field/,
    );
  });
});

// --------------------------------------------------------------------------
// validateClaudeReview
// --------------------------------------------------------------------------

describe("validateClaudeReview", () => {
  test("accepts the brief's worked example for stage wave-one", () => {
    const v = validClaudeReview();
    assert.equal(validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }), v);
  });

  test("rejects an unknown stage", () => {
    const v = validClaudeReview();
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-three" }), /stage/);
  });

  test("wave-one allows SATISFIED|GAP|UNCERTAIN", () => {
    for (const status of ["SATISFIED", "GAP", "UNCERTAIN"]) {
      const v = validClaudeReview();
      v.acceptance[0].status = status;
      assert.equal(validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }).acceptance[0].status, status);
    }
  });

  test("wave-one rejects BLOCKED (that status only exists post-correction)", () => {
    const v = validClaudeReview();
    v.acceptance[0].status = "BLOCKED";
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }));
  });

  test("post-correction allows only SATISFIED|BLOCKED", () => {
    for (const status of ["SATISFIED", "BLOCKED"]) {
      const v = validClaudeReview();
      v.acceptance[0].status = status;
      assert.equal(validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "post-correction" }).acceptance[0].status, status);
    }
  });

  test("post-correction rejects GAP/UNCERTAIN", () => {
    for (const status of ["GAP", "UNCERTAIN"]) {
      const v = validClaudeReview();
      v.acceptance[0].status = status;
      assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "post-correction" }));
    }
  });

  test("requires every plan acceptance ID to appear exactly once", () => {
    const v = validClaudeReview();
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06", "AC-07"], stage: "wave-one" }), /exactly once/);
  });

  test("rejects a duplicated acceptance ID in the review", () => {
    const v = validClaudeReview();
    v.acceptance.push(clone(v.acceptance[0]));
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }), /duplicate/);
  });

  test("rejects a review acceptance ID outside the plan's acceptance list", () => {
    const v = validClaudeReview();
    v.acceptance[0].id = "AC-99";
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }));
  });

  test("rejects an unknown item field (e.g. a correction-task field)", () => {
    const v = validClaudeReview();
    v.acceptance[0].source_task_id = "t1";
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }), /unknown field/);
  });

  test("rejects an unknown top-level field", () => {
    const v = validClaudeReview();
    v.wave = 3;
    assertThrowsContract(() => validateClaudeReview(v, { acceptanceIds: ["AC-06"], stage: "wave-one" }), /unknown field/);
  });
});
