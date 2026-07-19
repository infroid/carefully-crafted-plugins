// Unit tests for plugins/contexthub/scripts/supervise/checkpoint.mjs
// Run with: node --test tests/unit/supervise-checkpoint.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CHECKPOINT_MAX_BYTES,
  buildCheckpoint,
  buildFinalReceipt,
  summarizeUsage,
  writeCheckpoint,
} from "../../plugins/contexthub/scripts/supervise/checkpoint.mjs";
import { ContractError } from "../../plugins/contexthub/scripts/supervise/contracts.mjs";

function byteLen(v) {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "sup-checkpoint-"));
}

// --------------------------------------------------------------------------
// buildCheckpoint — Step 7
// --------------------------------------------------------------------------

describe("buildCheckpoint", () => {
  test("a small checkpoint fits under the byte cap unmodified (overflow: null)", () => {
    const detailDir = tmpDir();
    const cp = buildCheckpoint({
      wave: 1,
      integrationHead: "a".repeat(40),
      diffStat: { filesChanged: 2, insertions: 10, deletions: 3 },
      acceptanceMatrix: [{ id: "AC-01", status: "SATISFIED", reason: "done" }],
      tasks: [{ id: "t1", status: "READY", commit: "b".repeat(40), summary: "did the thing", concerns: [] }],
      verificationCounts: { pass: 1, fail: 0, not_run: 0 },
      usageTotals: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 },
      violations: [],
      detailDir,
    });
    assert.equal(cp.wave, 1);
    assert.equal(cp.integration_head, "a".repeat(40));
    assert.equal(cp.overflow, null);
    assert.ok(byteLen(cp) <= CHECKPOINT_MAX_BYTES);
    assert.deepEqual(readdirSync(detailDir), []); // no detail artifact written when nothing overflowed
  });

  test("overflow: a huge task list is bounded to <= 8192 bytes, with a deterministic detail artifact preserving everything", () => {
    const detailDir = tmpDir();
    const tasks = Array.from({ length: 400 }, (_, i) => ({
      id: `t${i}`,
      status: "READY",
      commit: "c".repeat(40),
      summary: "a fairly long summary describing everything this task did in verbose detail ".repeat(3),
      concerns: ["concern one is fairly verbose too, describing exactly what went slightly wrong here"],
    }));
    const cp = buildCheckpoint({
      wave: 1,
      integrationHead: "a".repeat(40),
      diffStat: { filesChanged: 400, insertions: 5000, deletions: 200 },
      acceptanceMatrix: Array.from({ length: 40 }, (_, i) => ({ id: `AC-${String(i).padStart(2, "0")}`, status: "SATISFIED", reason: "x".repeat(200) })),
      tasks,
      verificationCounts: { pass: 400, fail: 0, not_run: 0 },
      usageTotals: { input_tokens: 100000, cached_input_tokens: 5000, output_tokens: 20000, reasoning_output_tokens: 4000 },
      violations: [],
      detailDir,
    });

    assert.ok(byteLen(cp) <= CHECKPOINT_MAX_BYTES, `checkpoint is ${byteLen(cp)} bytes, over the ${CHECKPOINT_MAX_BYTES} cap`);
    assert.ok(cp.overflow && typeof cp.overflow.detailPath === "string");
    assert.ok(existsSync(cp.overflow.detailPath));

    // NEVER FAIL COMPLETED WORK: nothing is lost, only relocated — the
    // detail artifact contains the FULL task list.
    const detail = JSON.parse(readFileSync(cp.overflow.detailPath, "utf8"));
    assert.equal(detail.tasks.length, 400);
    assert.equal(detail.tasks[0].summary, tasks[0].summary);

    // The bounded summary must still be complete enough to LOCATE every
    // detail artifact and to know how much was elided.
    assert.equal(cp.wave, 1);
    assert.equal(cp.integration_head, "a".repeat(40));
  });

  test("overflow never throws — buildCheckpoint always returns something, even under pathological detail volume", () => {
    const detailDir = tmpDir();
    const tasks = Array.from({ length: 5000 }, (_, i) => ({ id: `task-number-${i}`, status: "READY", commit: "d".repeat(40), summary: "x".repeat(400), concerns: ["y".repeat(200)] }));
    assert.doesNotThrow(() => {
      const cp = buildCheckpoint({
        wave: 2, integrationHead: "e".repeat(40), diffStat: { filesChanged: 5000, insertions: 1, deletions: 1 },
        acceptanceMatrix: [], tasks, verificationCounts: { pass: 0, fail: 0, not_run: 0 }, usageTotals: null, violations: [], detailDir,
      });
      assert.ok(byteLen(cp) <= CHECKPOINT_MAX_BYTES);
    });
  });

  test("OVERFLOW WITHOUT detailDir: never throws — a paid wave's checkpoint survives with detailPath: null", () => {
    // This is the failure mode the module header promises to prevent: the
    // detail write is the only filesystem step in the ladder, it fires ONLY
    // on overflow, and it previously threw when detailDir was absent — so a
    // run could work for months and then destroy a completed wave's
    // checkpoint on its first large wave.
    const tasks = Array.from({ length: 400 }, (_, i) => ({
      id: `t${i}`, status: "READY", commit: "c".repeat(40),
      summary: "a fairly long summary describing everything this task did ".repeat(3),
      concerns: ["a reasonably verbose concern about what went slightly wrong"],
    }));

    let cp;
    assert.doesNotThrow(() => {
      cp = buildCheckpoint({
        wave: 1, integrationHead: "a".repeat(40), diffStat: { filesChanged: 400, insertions: 5000, deletions: 200 },
        acceptanceMatrix: [], tasks, verificationCounts: { pass: 400, fail: 0, not_run: 0 },
        usageTotals: null, violations: [],
        // detailDir deliberately OMITTED
      });
    }, "overflow without a detailDir must not throw away completed work");

    assert.ok(byteLen(cp) <= CHECKPOINT_MAX_BYTES);
    assert.ok(cp.overflow, "overflow must still be signalled");
    assert.equal(cp.overflow.detailPath, null);
    assert.ok(typeof cp.overflow.detailUnavailable === "string" && cp.overflow.detailUnavailable.length > 0,
      "the reason the detail pointer is absent must be recorded, not silently implied");
    // The bounded summary is still complete enough to be useful.
    assert.equal(cp.wave, 1);
    assert.equal(cp.integration_head, "a".repeat(40));
  });

  test("OVERFLOW WITH AN UNWRITABLE detailDir: still never throws", () => {
    // A read-only parent directory stands in for a full disk / permissions
    // problem — an environmental failure entirely outside the caller's
    // control, arriving after the worker cost is already spent.
    const parent = tmpDir();
    const readOnlyParent = join(parent, "read-only");
    mkdirSync(readOnlyParent);
    chmodSync(readOnlyParent, 0o500); // r-x: cannot create children

    try {
      const tasks = Array.from({ length: 400 }, (_, i) => ({
        id: `t${i}`, status: "READY", commit: "c".repeat(40),
        summary: "a fairly long summary describing everything this task did ".repeat(3),
        concerns: ["a reasonably verbose concern"],
      }));

      let cp;
      assert.doesNotThrow(() => {
        cp = buildCheckpoint({
          wave: 2, integrationHead: "b".repeat(40), diffStat: null,
          acceptanceMatrix: [], tasks, verificationCounts: null, usageTotals: null, violations: [],
          detailDir: join(readOnlyParent, "nested-detail"),
        });
      });

      assert.ok(byteLen(cp) <= CHECKPOINT_MAX_BYTES);
      assert.equal(cp.overflow.detailPath, null);
      assert.ok(cp.overflow.detailUnavailable);
    } finally {
      chmodSync(readOnlyParent, 0o700); // restore so the temp dir can be cleaned up
    }
  });

  test("OVERFLOW WITHOUT detailDir on the final receipt: also never throws", () => {
    const finalVerification = Array.from({ length: 300 }, (_, i) => ({
      id: `final-${i}`, status: "PASS", exitCode: 0, logPath: `/absolute/run/logs/verification/final-${i}.log`,
    }));
    let receipt;
    assert.doesNotThrow(() => {
      receipt = buildFinalReceipt({
        integrationHead: "f".repeat(40), finalVerification,
        acceptanceMatrix: [], waveSummaries: [], usageTotals: null, violations: [],
        // detailDir deliberately OMITTED
      });
    });
    assert.ok(byteLen(receipt) <= CHECKPOINT_MAX_BYTES);
    assert.equal(receipt.overflow.detailPath, null);
    assert.ok(receipt.overflow.detailUnavailable);
    assert.equal(receipt.integration_head, "f".repeat(40));
  });

  test("does not alias the caller's concerns array into the built checkpoint", () => {
    const detailDir = tmpDir();
    const concerns = ["original concern"];
    const cp = buildCheckpoint({
      wave: 1, integrationHead: "a".repeat(40), diffStat: null,
      acceptanceMatrix: [], tasks: [{ id: "t1", status: "READY", commit: null, summary: "s", concerns }],
      verificationCounts: null, usageTotals: null, violations: [], detailDir,
    });
    // Mutating the caller's array afterward must not retroactively change an
    // already-built checkpoint.
    concerns.push("added after the checkpoint was built");
    assert.deepEqual(cp.tasks[0].concerns, ["original concern"]);
  });

  test("requires wave to be 1 or 2, and integrationHead to be present", () => {
    assert.throws(() => buildCheckpoint({ wave: 3, integrationHead: "a".repeat(40), detailDir: tmpDir() }), ContractError);
    assert.throws(() => buildCheckpoint({ wave: 1, detailDir: tmpDir() }), ContractError);
  });

  test("does not include full file lists or command output — only counts/paths for anything oversized", () => {
    const detailDir = tmpDir();
    const violations = Array.from({ length: 200 }, (_, i) => `ownership violation number ${i}: some very long description of exactly what happened here in detail`);
    const cp = buildCheckpoint({
      wave: 1, integrationHead: "a".repeat(40), diffStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      acceptanceMatrix: [], tasks: [], verificationCounts: { pass: 0, fail: 0, not_run: 0 }, usageTotals: null, violations, detailDir,
    });
    assert.ok(byteLen(cp) <= CHECKPOINT_MAX_BYTES);
    // Once overflowed, violations collapse to a count + detail pointer. The
    // count lives at `.violations.count` on the slim rung and at
    // `.counts.violationCount` on the minimal rung, so accept either —
    // written as an explicit parenthesized fallback because `typeof` binds
    // tighter than `??`, which previously made this assertion dead code
    // (it compared the string "number" against the ?? fallback and would
    // have thrown a TypeError had the ladder ever reached the minimal rung).
    assert.ok(cp.overflow, "this fixture must overflow, or the assertion below proves nothing");
    const violationCount = cp.violations?.count ?? cp.counts?.violationCount;
    assert.equal(typeof violationCount, "number");
    assert.equal(violationCount, 200);
  });
});

// --------------------------------------------------------------------------
// buildFinalReceipt — Step 7
// --------------------------------------------------------------------------

describe("buildFinalReceipt", () => {
  test("a small final receipt fits under the byte cap unmodified", () => {
    const detailDir = tmpDir();
    const receipt = buildFinalReceipt({
      integrationHead: "f".repeat(40),
      finalVerification: [{ id: "final-tests", status: "PASS", exitCode: 0, logPath: "/abs/logs/final-tests.log" }],
      acceptanceMatrix: [{ id: "AC-01", status: "SATISFIED" }],
      waveSummaries: [{ wave: 1, integrationHead: "g".repeat(40), taskCount: 2 }, { wave: 2, integrationHead: "f".repeat(40), taskCount: 1 }],
      usageTotals: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 },
      violations: [],
      detailDir,
    });
    assert.equal(receipt.integration_head, "f".repeat(40));
    assert.equal(receipt.overflow, null);
    assert.ok(byteLen(receipt) <= CHECKPOINT_MAX_BYTES);
  });

  test("overflow: a huge final-verification/acceptance set is bounded, with a deterministic detail artifact and no loss of completed work", () => {
    const detailDir = tmpDir();
    const finalVerification = Array.from({ length: 300 }, (_, i) => ({
      id: `final-${i}`, status: "PASS", exitCode: 0,
      logPath: `/abs/logs/final-${i}.log`,
    }));
    const receipt = buildFinalReceipt({
      integrationHead: "f".repeat(40),
      finalVerification,
      acceptanceMatrix: Array.from({ length: 40 }, (_, i) => ({ id: `AC-${i}`, status: "SATISFIED", reason: "z".repeat(300) })),
      waveSummaries: [{ wave: 1, integrationHead: "g".repeat(40), taskCount: 12 }, { wave: 2, integrationHead: "f".repeat(40), taskCount: 12 }],
      usageTotals: { input_tokens: 999999, cached_input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 1 },
      violations: [],
      detailDir,
    });

    assert.ok(byteLen(receipt) <= CHECKPOINT_MAX_BYTES, `final receipt is ${byteLen(receipt)} bytes`);
    assert.ok(receipt.overflow && existsSync(receipt.overflow.detailPath));
    const detail = JSON.parse(readFileSync(receipt.overflow.detailPath, "utf8"));
    assert.equal(detail.final_verification.length, 300);
    assert.equal(detail.final_verification[0].log_path, "/abs/logs/final-0.log");
    // The bounded summary is still complete enough to locate every detail
    // artifact: integration head is always present.
    assert.equal(receipt.integration_head, "f".repeat(40));
  });

  test("requires integrationHead", () => {
    assert.throws(() => buildFinalReceipt({ detailDir: tmpDir() }), ContractError);
  });
});

// --------------------------------------------------------------------------
// summarizeUsage
// --------------------------------------------------------------------------

describe("summarizeUsage", () => {
  test("sums usage across receipts without mutating inputs", () => {
    const receipts = [
      { usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } },
      { usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2 } },
    ];
    const frozen = JSON.stringify(receipts);
    const totals = summarizeUsage(receipts);
    assert.deepEqual(totals, { input_tokens: 30, cached_input_tokens: 2, output_tokens: 8, reasoning_output_tokens: 3, receipt_count: 2 });
    assert.equal(JSON.stringify(receipts), frozen);
  });

  test("handles an empty array and receipts with missing usage gracefully", () => {
    assert.deepEqual(summarizeUsage([]), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, receipt_count: 0 });
    assert.deepEqual(summarizeUsage([{}]), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, receipt_count: 1 });
  });

  test("rejects a non-array input", () => {
    assert.throws(() => summarizeUsage("not an array"), ContractError);
  });
});

// --------------------------------------------------------------------------
// writeCheckpoint
// --------------------------------------------------------------------------

describe("writeCheckpoint", () => {
  test("writes atomically (no leftover temp files) and the result parses as complete JSON", () => {
    const dir = tmpDir();
    const target = join(dir, "checkpoint-1.json");
    const value = { wave: 1, integration_head: "a".repeat(40), overflow: null };
    const result = writeCheckpoint(target, value);
    assert.equal(result, target);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  });

  test("accepts an object with a .path field as well as a bare string", () => {
    const dir = tmpDir();
    const target = join(dir, "final.json");
    const value = { integration_head: "b".repeat(40), overflow: null };
    writeCheckpoint({ path: target }, value);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
  });

  test("creates parent directories as needed", () => {
    const dir = tmpDir();
    const target = join(dir, "nested", "deeper", "checkpoint-2.json");
    writeCheckpoint(target, { wave: 2, integration_head: "c".repeat(40), overflow: null });
    assert.ok(existsSync(target));
  });

  test("writes COMPACT JSON, not pretty-printed: the on-disk bytes never exceed the cap even for a value whose pretty-printed form would", () => {
    const dir = tmpDir();
    const target = join(dir, "checkpoint-1.json");
    // Built to sit just under the cap when compact, but pretty-printing with
    // 2-space indentation would push it over — proves the cap is enforced
    // against, and the file is written as, the SAME compact serialization.
    const tasks = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, status: "READY" }));
    const value = { wave: 1, integration_head: "a".repeat(40), tasks, overflow: null };
    const compactBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const prettyBytes = Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
    assert.ok(compactBytes <= CHECKPOINT_MAX_BYTES, "fixture must fit compact");
    assert.ok(prettyBytes > CHECKPOINT_MAX_BYTES, "fixture must NOT fit pretty-printed — otherwise this test proves nothing");

    writeCheckpoint(target, value);
    const onDiskBytes = Buffer.byteLength(readFileSync(target, "utf8"), "utf8");
    assert.ok(onDiskBytes <= CHECKPOINT_MAX_BYTES, `on-disk checkpoint is ${onDiskBytes} bytes, over the ${CHECKPOINT_MAX_BYTES} cap`);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
  });

  test("is the last gate: rejects a value that exceeds the byte cap even if the caller bypassed the builders", () => {
    const dir = tmpDir();
    const target = join(dir, "checkpoint-1.json");
    const oversized = { junk: "x".repeat(9000) };
    assert.throws(() => writeCheckpoint(target, oversized), ContractError);
    assert.equal(existsSync(target), false);
  });

  test("rejects a missing/invalid path", () => {
    assert.throws(() => writeCheckpoint(undefined, {}), ContractError);
    assert.throws(() => writeCheckpoint({}, {}), ContractError);
  });
});
