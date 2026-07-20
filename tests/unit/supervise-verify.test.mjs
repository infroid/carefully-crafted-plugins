// Unit tests for plugins/contexthub/scripts/supervise/verify.mjs
// Run with: node --test tests/unit/supervise-verify.test.mjs
//
// TIMING POLICY (mirrors tests/unit/supervise-codex.test.mjs): every test
// here spawns a real child process. Tests asserting a command COMPLETES use
// a generous timeoutMs backstop (the process exits on its own — the bound
// only guards against a genuine hang, so it costs no real wall time on the
// happy path). The one test asserting a TIMEOUT actually fires uses a small
// bound against a process that sleeps far longer than it, so it is immune
// to slow process startup under load (a slow child only makes the timeout
// MORE certain, never less).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VerifyError,
  MAX_VERIFY_TIMEOUT_MS,
  validateExecutionCwd,
  runVerificationCommand,
  runVerificationSet,
} from "../../plugins/contexthub/scripts/supervise/verify.mjs";
import { ContractError } from "../../plugins/contexthub/scripts/supervise/contracts.mjs";

const GENEROUS_TIMEOUT_MS = 30_000;
const SMALL_TIMEOUT_MS = 300;

function tmpWorktree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sup-verify-")));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "file.txt"), "hello\n");
  return dir;
}

function cmd(overrides = {}) {
  return { id: "cmd", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [], ...overrides };
}

// --------------------------------------------------------------------------
// validateExecutionCwd
// --------------------------------------------------------------------------

describe("validateExecutionCwd", () => {
  test("'.' resolves to the worktree root", () => {
    const wt = tmpWorktree();
    const resolved = validateExecutionCwd({ worktreePath: wt, cwd: "." });
    assert.equal(resolved, realpathSync(wt));
  });

  test("a subdirectory inside the worktree resolves fine", () => {
    const wt = tmpWorktree();
    const resolved = validateExecutionCwd({ worktreePath: wt, cwd: "sub" });
    assert.equal(resolved, realpathSync(join(wt, "sub")));
  });

  test("rejects a cwd containing '..' outright", () => {
    const wt = tmpWorktree();
    assert.throws(() => validateExecutionCwd({ worktreePath: wt, cwd: "../escape" }), VerifyError);
  });

  test("rejects a cwd that does not exist", () => {
    const wt = tmpWorktree();
    assert.throws(() => validateExecutionCwd({ worktreePath: wt, cwd: "nope" }), VerifyError);
  });

  test("CWD ESCAPE via symlink: a symlink inside the worktree pointing OUTSIDE it is rejected even though the string path looks contained", () => {
    const wt = tmpWorktree();
    const outside = mkdtempSync(join(tmpdir(), "sup-verify-outside-"));
    writeFileSync(join(outside, "secret.txt"), "should not be reachable\n");
    symlinkSync(outside, join(wt, "escape-link"));
    assert.throws(() => validateExecutionCwd({ worktreePath: wt, cwd: "escape-link" }), VerifyError);
  });
});

// --------------------------------------------------------------------------
// runVerificationCommand — Step 5
// --------------------------------------------------------------------------

describe("runVerificationCommand", () => {
  test("PASS: exit 0 produces status PASS with a full log on disk", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationCommand({
      command: cmd(), worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "t1-01-cmd", timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    assert.equal(result.status, "PASS");
    assert.equal(result.exitCode, 0);
    assert.ok(readFileSync(result.logPath, "utf8").includes("exitCode: 0"));
  });

  test("FAIL: non-zero exit produces status FAIL", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationCommand({
      command: cmd({ argv: ["node", "-e", "process.exit(3)"] }), worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "t1-01-cmd", timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.exitCode, 3);
  });

  test("MODEL SUCCESS CONTRADICTED BY HOST FAILURE: a non-zero host result is FAIL regardless of what a model might separately claim — this file has no report concept at all, so a caller combining it with a DONE report must let this result win", async () => {
    const wt = tmpWorktree();
    const modelClaims = { status: "DONE" }; // a caller's model report, never consulted here
    const hostResult = await runVerificationCommand({
      command: cmd({ argv: ["node", "-e", "process.exit(1)"] }), worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "t1-01", timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    assert.equal(hostResult.status, "FAIL");
    // The caller-side rule (mirrored here since verify.mjs itself never sees
    // a report): host FAIL always overrides model DONE.
    const effectiveStatus = hostResult.status === "PASS" && modelClaims.status === "DONE" ? "DONE" : "BLOCKED";
    assert.equal(effectiveStatus, "BLOCKED");
  });

  test("UNSAFE ARGV: a shell interpreter or inline-code interpreter's shape is rejected by the contracts.mjs re-check (belt and suspenders)", async () => {
    const wt = tmpWorktree();
    await assert.rejects(runVerificationCommand({
      command: cmd({ argv: ["bash", "-c", "echo hi"] }), worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "unsafe",
    }), ContractError);
  });

  test("SECOND DEFENSE LAYER, not a restatement: an inline-code interpreter that DOES pass the shape/denylist check (perl -e is a documented, accepted gap in contracts.mjs) is still confined by cwd containment, shell:false, and a bounded timeout — it cannot escape the worktree via a symlink even though its argv is accepted", async () => {
    const wt = tmpWorktree();
    const outside = mkdtempSync(join(tmpdir(), "sup-verify-outside2-"));
    symlinkSync(outside, join(wt, "escape-link"));
    // node -e is a legitimate, must-stay-reachable interpreter per contracts.mjs's own documented gap.
    await assert.rejects(runVerificationCommand({
      command: cmd({ id: "inline", argv: ["node", "-e", "1"], cwd: "escape-link" }),
      worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "inline",
    }), VerifyError, "cwd containment must reject the escape even though argv shape alone would pass");
  });

  test("MISSING APPROVAL: a command requiring an unapproved id is rejected immediately before execution, and the child is never spawned", async () => {
    const wt = tmpWorktree();
    let spawned = false;
    const spawnImpl = (...args) => { spawned = true; throw new Error("should never be called"); };
    await assert.rejects(runVerificationCommand({
      command: cmd({ requires_approval_ids: ["approval-01"] }),
      worktreePath: wt, approvals: { "approval-01": "PENDING" }, logDir: join(wt, "logs"), logNamePrefix: "gate", spawnImpl,
    }), VerifyError);
    assert.equal(spawned, false);
  });

  test("an APPROVED requirement allows execution", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationCommand({
      command: cmd({ requires_approval_ids: ["approval-01"] }),
      worktreePath: wt, approvals: { "approval-01": "APPROVED" }, logDir: join(wt, "logs"), logNamePrefix: "gate-ok", timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    assert.equal(result.status, "PASS");
  });

  test("TIMEOUT: a long-sleeping command is killed and reported FAIL with timedOut:true, using a small bound (immune to slow startup — a slow child only makes this MORE certain)", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationCommand({
      command: cmd({ argv: ["node", "-e", "setTimeout(() => {}, 60000)"] }),
      worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "slow", timeoutMs: SMALL_TIMEOUT_MS, killGraceMs: 200,
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.timedOut, true);
  }, { timeout: GENEROUS_TIMEOUT_MS });

  test("BOUNDED TIMEOUT: a caller cannot request a timeout above MAX_VERIFY_TIMEOUT_MS", async () => {
    const wt = tmpWorktree();
    await assert.rejects(runVerificationCommand({
      command: cmd(), worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "toolong", timeoutMs: MAX_VERIFY_TIMEOUT_MS + 1,
    }), VerifyError);
  });

  test("TRUNCATED DISPLAY WITH FULL LOGS: long output is truncated in the returned display but the full content is always on disk", async () => {
    const wt = tmpWorktree();
    const bigOutputScript = "process.stdout.write('X'.repeat(5000))";
    const result = await runVerificationCommand({
      command: cmd({ argv: ["node", "-e", bigOutputScript] }), worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "big", timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.display.length < 5000);
    assert.ok(result.display.includes("truncated"));
    const fullLog = readFileSync(result.logPath, "utf8");
    assert.ok(fullLog.includes("X".repeat(5000)));
  });

  test("shell:false — a command that would only work if shell-interpreted (e.g. relying on $HOME expansion) runs literally, not interpreted", async () => {
    const wt = tmpWorktree();
    // argv[1] is the LITERAL string "$HOME", never expanded, because there
    // is no shell involved.
    const result = await runVerificationCommand({
      command: cmd({ argv: ["node", "-e", "process.exit(process.argv[1] === \"$HOME\" ? 0 : 1)", "$HOME"] }),
      worktreePath: wt, logDir: join(wt, "logs"), logNamePrefix: "noshell", timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    assert.equal(result.status, "PASS");
  });
});

// --------------------------------------------------------------------------
// runVerificationSet — Step 5
// --------------------------------------------------------------------------

describe("runVerificationSet", () => {
  test("runs every command even after an earlier one fails, and reports allPass:false", async () => {
    const wt = tmpWorktree();
    const commands = [cmd({ id: "a" }), cmd({ id: "b", argv: ["node", "-e", "process.exit(1)"] }), cmd({ id: "c" })];
    const result = await runVerificationSet({ commands, worktreePath: wt, logDir: join(wt, "logs"), timeoutMs: GENEROUS_TIMEOUT_MS });
    assert.equal(result.results.length, 3);
    assert.equal(result.results.map((r) => r.id).join(","), "a,b,c");
    assert.equal(result.allPass, false);
    assert.equal(result.commandsPassed, false);
  });

  test("allPass:true when every command passes and no residue is detected", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationSet({
      commands: [cmd({ id: "a" }), cmd({ id: "b" })], worktreePath: wt, logDir: join(wt, "logs"), timeoutMs: GENEROUS_TIMEOUT_MS,
      snapshotBefore: "fp-1", snapshotAfterFn: () => "fp-1",
    });
    assert.equal(result.allPass, true);
    assert.equal(result.residue, false);
  });

  test("WORKER-VERIFICATION DIFF MUTATION: a command that mutates the worktree during a per-task verification run is detected via the fingerprint snapshot and blocks even though the command itself exits 0", async () => {
    const wt = tmpWorktree();
    const mutate = cmd({ id: "mutator", argv: ["node", "-e", "require('fs').appendFileSync('file.txt', 'mutated\\n')"] });
    let calls = 0;
    const result = await runVerificationSet({
      commands: [mutate], worktreePath: wt, logDir: join(wt, "logs"), timeoutMs: GENEROUS_TIMEOUT_MS,
      snapshotBefore: "unchanged-fingerprint",
      snapshotAfterFn: () => { calls += 1; return "different-fingerprint-because-file-txt-changed"; },
    });
    assert.equal(result.results[0].status, "PASS"); // the command itself succeeded
    assert.equal(result.residue, true); // but it left residue
    assert.equal(result.allPass, false); // so the SET still fails
    assert.equal(calls, 1);
  });

  test("FINAL-VERIFICATION INTEGRATION RESIDUE: the same mechanism catches a final-verification command that moves HEAD or leaves status residue in the integration worktree", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationSet({
      commands: [cmd({ id: "final-1" })], worktreePath: wt, logDir: join(wt, "logs"), timeoutMs: GENEROUS_TIMEOUT_MS,
      snapshotBefore: { head: "abc123", status: "" },
      snapshotAfterFn: () => ({ head: "abc123", status: " M some-residual-file.txt" }), // status changed -> residue
    });
    assert.equal(result.residue, true);
    assert.equal(result.allPass, false);
  });

  test("commands with no snapshot functions supplied never falsely report residue", async () => {
    const wt = tmpWorktree();
    const result = await runVerificationSet({ commands: [cmd()], worktreePath: wt, logDir: join(wt, "logs"), timeoutMs: GENEROUS_TIMEOUT_MS });
    assert.equal(result.residue, false);
    assert.equal(result.allPass, true);
  });
});
