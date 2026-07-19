// Unit tests for plugins/contexthub/scripts/supervise/scheduler.mjs
// Run with: node --test tests/unit/supervise-scheduler.test.mjs
//
// executeWave tests use REAL temporary Git repositories (via git.mjs) and
// FAKE workers (a plain async function injected as options.runWorker) that
// write files directly into the assigned worktree, exactly like a Codex
// worker running under workspace-write would — this lets the whole
// host-authoritative pipeline (ownership derivation, verification, commit,
// candidate integration, publish) run for real without ever invoking the
// actual Codex CLI.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  SchedulerError,
  beginTrackedOperation,
  getRunnableTasks,
  assertParallelSafe,
  recommendedConcurrency,
  runPool,
  executeWave,
  assertReportVerificationCoverage,
  effectiveSessionPolicy,
  buildCodexWorker,
} from "../../plugins/contexthub/scripts/supervise/scheduler.mjs";
import {
  inspectRepository, ensurePrivateWorktreeRoot, createIntegrationWorktree,
  readHead, isWorktreeClean, isCommitIntegrated,
} from "../../plugins/contexthub/scripts/supervise/git.mjs";

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "sup-sched-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "a.txt"), "base-a\n");
  writeFileSync(join(repo, "b.txt"), "base-b\n");
  writeFileSync(join(repo, "c.txt"), "base-c\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return repo;
}

let runIdCounter = 0;
function freshRunId() {
  runIdCounter += 1;
  return `20260719T${String(130000 + runIdCounter).padStart(6, "0")}Z-${String(runIdCounter).padStart(8, "0")}`;
}

function makeWaveHarness() {
  const repo = makeRepo();
  const info = inspectRepository(repo);
  const runId = freshRunId();
  const worktreePaths = ensurePrivateWorktreeRoot(info, runId);
  const integ = createIntegrationWorktree({ repoInfo: info, runId, worktreePaths });
  const logsDir = join(worktreePaths.root, "logs");
  return { repo, info, runId, worktreePaths, integ, logsDir };
}

// A trivial always-passing verification command — real `node`, no shell.
const OK_VERIFY = { id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] };
const FAIL_VERIFY = { id: "fails", argv: ["node", "-e", "process.exit(1)"], cwd: ".", requires_approval_ids: [] };

function makeTask(overrides = {}) {
  return {
    id: "t1",
    wave: 1,
    objective: "test task",
    depends_on: [],
    read_paths: [],
    write_paths: ["a.txt"],
    acceptance_ids: ["AC-01"],
    verify: [OK_VERIFY],
    effort: "high",
    risk: "low",
    ...overrides,
  };
}

// Simulates a well-behaved Codex worker: writes the given file contents into
// the assigned worktree (nothing else — no staging, no commit, no HEAD
// move) and returns a valid DONE report.
function goodWorker(files, { status = "DONE", concerns = [] } = {}) {
  return async (task, ctx) => {
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(ctx.worktreePath, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return {
      processExitCode: 0,
      report: {
        status,
        summary: "task complete",
        acceptance: task.acceptance_ids.map((id) => ({ id, status: "PASS", evidence: "e2e" })),
        verification: task.verify.map((v) => ({ id: v.id, status: "PASS", summary: "ok" })),
        concerns,
        blockers: [],
      },
    };
  };
}

// A worker that makes SOME partial progress (so the ownership check passes
// and the model-status gate is actually what blocks it) but reports
// NEEDS_CONTEXT — a realistic case where a worker got partway through and
// recognized it can't finish.
function needsContextWorker() {
  return async (task, ctx) => {
    writeFileSync(join(ctx.worktreePath, task.write_paths[0]), "partial progress\n");
    return {
      processExitCode: 0,
      report: { status: "NEEDS_CONTEXT", summary: "unclear", acceptance: [], verification: [], concerns: [], blockers: ["ambiguous requirement"] },
    };
  };
}

// A misbehaving worker that STAGES its change (forbidden — Codex workers run
// under workspace-write, which never stages/commits, but a scheduler must
// still catch a worker that somehow did).
function stagingWorker(relPath, content) {
  return async (task, ctx) => {
    const full = join(ctx.worktreePath, relPath);
    writeFileSync(full, content);
    execFileSync("git", ["add", relPath], { cwd: ctx.worktreePath });
    return { processExitCode: 0, report: { status: "DONE", summary: "x", acceptance: task.acceptance_ids.map((id) => ({ id, status: "PASS", evidence: "e" })), verification: task.verify.map((v) => ({ id: v.id, status: "PASS", summary: "ok" })), concerns: [], blockers: [] } };
  };
}

// --------------------------------------------------------------------------
// recommendedConcurrency
// --------------------------------------------------------------------------

describe("recommendedConcurrency", () => {
  test("score 1 -> 1", () => assert.equal(recommendedConcurrency(1), 1));
  test("scores 2-3 -> 2", () => {
    assert.equal(recommendedConcurrency(2), 2);
    assert.equal(recommendedConcurrency(3), 2);
  });
  test("scores 4-5 -> 3", () => {
    assert.equal(recommendedConcurrency(4), 3);
    assert.equal(recommendedConcurrency(5), 3);
  });
  test("rejects out-of-range or non-integer scores", () => {
    assert.throws(() => recommendedConcurrency(0), SchedulerError);
    assert.throws(() => recommendedConcurrency(6), SchedulerError);
    assert.throws(() => recommendedConcurrency(2.5), SchedulerError);
  });
});

// --------------------------------------------------------------------------
// getRunnableTasks
// --------------------------------------------------------------------------

describe("getRunnableTasks", () => {
  test("returns tasks whose dependencies are all completed and are not themselves completed", () => {
    const graph = { tasks: [makeTask({ id: "t1", depends_on: [] }), makeTask({ id: "t2", depends_on: ["t1"] })] };
    assert.deepEqual(getRunnableTasks(graph, []).map((t) => t.id), ["t1"]);
    assert.deepEqual(getRunnableTasks(graph, ["t1"]).map((t) => t.id), ["t2"]);
    assert.deepEqual(getRunnableTasks(graph, ["t1", "t2"]).map((t) => t.id), []);
  });
});

// --------------------------------------------------------------------------
// assertParallelSafe
// --------------------------------------------------------------------------

describe("assertParallelSafe", () => {
  test("accepts a well-formed wave", () => {
    assert.doesNotThrow(() => assertParallelSafe([makeTask({ id: "t1", write_paths: ["a.txt"] }), makeTask({ id: "t2", write_paths: ["b.txt"] })]));
  });

  test("rejects a task with a non-empty depends_on — a coupled pair must be combined into one task", () => {
    assert.throws(
      () => assertParallelSafe([makeTask({ id: "t1", write_paths: ["a.txt"] }), makeTask({ id: "t2", write_paths: ["b.txt"], depends_on: ["t1"] })]),
      SchedulerError,
    );
  });

  test("rejects overlapping write roots", () => {
    assert.throws(
      () => assertParallelSafe([makeTask({ id: "t1", write_paths: ["src/"] }), makeTask({ id: "t2", write_paths: ["src/inner.txt"] })]),
      SchedulerError,
    );
  });

  test("rejects more than one 'max' effort task per wave", () => {
    assert.throws(
      () => assertParallelSafe([
        makeTask({ id: "t1", write_paths: ["a.txt"], effort: "max" }),
        makeTask({ id: "t2", write_paths: ["b.txt"], effort: "max" }),
      ]),
      SchedulerError,
    );
  });

  test("accepts exactly one 'max' effort task", () => {
    assert.doesNotThrow(() => assertParallelSafe([
      makeTask({ id: "t1", write_paths: ["a.txt"], effort: "max" }),
      makeTask({ id: "t2", write_paths: ["b.txt"], effort: "high" }),
    ]));
  });
});

// --------------------------------------------------------------------------
// runPool
// --------------------------------------------------------------------------

describe("runPool", () => {
  test("runs every item and preserves order in the results array", async () => {
    const results = await runPool([1, 2, 3, 4], 2, async (n) => n * 10);
    assert.deepEqual(results.map((r) => r.value), [10, 20, 30, 40]);
    assert.ok(results.every((r) => r.ok));
  });

  test("a single item's failure does not prevent siblings from completing", async () => {
    const results = await runPool([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.match(results[1].error.message, /boom/);
    assert.equal(results[2].ok, true);
  });

  test("respects the concurrency limit (never more than `limit` in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
    });
    assert.ok(maxInFlight <= 2, `expected at most 2 concurrent, saw ${maxInFlight}`);
  });

  test("empty items returns an empty array", async () => {
    assert.deepEqual(await runPool([], 4, async () => 1), []);
  });
});

// --------------------------------------------------------------------------
// assertReportVerificationCoverage — carry-forward #5
// --------------------------------------------------------------------------

describe("assertReportVerificationCoverage", () => {
  test("passes when every declared verify id is covered", () => {
    const task = makeTask({ verify: [OK_VERIFY, { ...FAIL_VERIFY, id: "second" }] });
    const report = { verification: [{ id: "ok", status: "PASS", summary: "s" }, { id: "second", status: "PASS", summary: "s" }] };
    assert.doesNotThrow(() => assertReportVerificationCoverage(task, report));
  });

  test("rejects a report claiming DONE with an EMPTY verification array despite declared verify commands — the gap contracts.mjs cannot see", () => {
    const task = makeTask({ verify: [OK_VERIFY] });
    const report = { status: "DONE", verification: [] };
    assert.throws(() => assertReportVerificationCoverage(task, report), SchedulerError);
  });

  test("rejects a report that covers only some of the declared verify ids", () => {
    const task = makeTask({ verify: [OK_VERIFY, { ...FAIL_VERIFY, id: "second" }] });
    const report = { verification: [{ id: "ok", status: "PASS", summary: "s" }] };
    assert.throws(() => assertReportVerificationCoverage(task, report), /second/);
  });
});

// --------------------------------------------------------------------------
// beginTrackedOperation — the central design decision
// --------------------------------------------------------------------------

describe("beginTrackedOperation (the central spawn-then-persist helper)", () => {
  test("spawns first, then immediately persists an event carrying {pid, startedAt, kind}", async () => {
    const persisted = [];
    const updateRunFn = async (event) => { persisted.push(event); return { phase: "WAVE_1_RUNNING" }; };
    const result = await beginTrackedOperation({
      updateRunFn, eventType: "RUN_WAVE_1", kind: "wave-1",
      spawnChild: () => ({ pid: 4242 }),
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].type, "RUN_WAVE_1");
    assert.equal(persisted[0].operation.pid, 4242);
    assert.equal(persisted[0].operation.kind, "wave-1");
    assert.match(persisted[0].operation.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.operation.pid, 4242);
  });

  test("merges buildEventExtras() into the persisted event (e.g. ACCEPT_REVIEW's reviewRef/hasGaps)", async () => {
    const persisted = [];
    const updateRunFn = async (event) => { persisted.push(event); return {}; };
    await beginTrackedOperation({
      updateRunFn, eventType: "ACCEPT_REVIEW", kind: "verify",
      buildEventExtras: () => ({ reviewRef: "review.json", hasGaps: false }),
      spawnChild: () => ({ pid: 99 }),
    });
    assert.equal(persisted[0].reviewRef, "review.json");
    assert.equal(persisted[0].hasGaps, false);
  });

  test("a multi-child launch (a wave or a verification set) records the HOST's own pid, per the module's documented resolution", async () => {
    const persisted = [];
    const updateRunFn = async (event) => { persisted.push(event); return {}; };
    await beginTrackedOperation({
      updateRunFn, eventType: "START_VERIFY", kind: "final-verification",
      spawnChild: () => ({ pid: process.pid }),
    });
    assert.equal(persisted[0].operation.pid, process.pid);
  });

  test("rejects a spawnChild() result without a positive integer pid", async () => {
    await assert.rejects(beginTrackedOperation({
      updateRunFn: async () => ({}), eventType: "START_GRADING", kind: "grader",
      spawnChild: () => ({ pid: -1 }),
    }), SchedulerError);
    await assert.rejects(beginTrackedOperation({
      updateRunFn: async () => ({}), eventType: "START_GRADING", kind: "grader",
      spawnChild: () => ({}),
    }), SchedulerError);
  });

  test("requires spawnChild and updateRunFn to be functions", async () => {
    await assert.rejects(beginTrackedOperation({ updateRunFn: async () => ({}), eventType: "X", kind: "k" }), SchedulerError);
    await assert.rejects(beginTrackedOperation({ spawnChild: () => ({ pid: 1 }), eventType: "X", kind: "k" }), SchedulerError);
  });

  test("persistence happens before any further async work — a slow updateRunFn is awaited, not raced", async () => {
    const order = [];
    const updateRunFn = async (event) => {
      order.push("persist-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("persist-end");
      return event;
    };
    await beginTrackedOperation({
      updateRunFn, eventType: "RUN_WAVE_2", kind: "wave-2",
      spawnChild: () => { order.push("spawn"); return { pid: 1 }; },
    });
    order.push("caller-continues");
    assert.deepEqual(order, ["spawn", "persist-start", "persist-end", "caller-continues"]);
  });
});

// --------------------------------------------------------------------------
// executeWave — Step 4
// --------------------------------------------------------------------------

describe("executeWave", () => {
  test("a fully successful single-task wave integrates and fast-forward publishes", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "changed by t1\n" }),
    });

    assert.equal(result.published, true);
    assert.deepEqual(result.integratedTaskIds, ["t1"]);
    assert.equal(result.taskResults[0].status, "READY");
    assert.equal(readHead(integ.path), result.integrationHead);
    assert.equal(isWorktreeClean(integ.path), true);
    assert.equal(readFileSync(join(integ.path, "a.txt"), "utf8"), "changed by t1\n");
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: result.taskResults[0].commit }), true);
  });

  test("every parallel worker receives a distinct worktree", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [makeTask({ id: "t1", write_paths: ["a.txt"] }), makeTask({ id: "t2", write_paths: ["b.txt"] })];
    const seenPaths = new Set();
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => {
        seenPaths.add(ctx.worktreePath);
        writeFileSync(join(ctx.worktreePath, task.write_paths[0]), `${task.id} change\n`);
        return { processExitCode: 0, report: { status: "DONE", summary: "s", acceptance: task.acceptance_ids.map((id) => ({ id, status: "PASS", evidence: "e" })), verification: task.verify.map((v) => ({ id: v.id, status: "PASS", summary: "ok" })), concerns: [], blockers: [] } };
      },
    });
    assert.equal(seenPaths.size, 2);
    assert.equal(result.published, true);
    assert.deepEqual(result.integratedTaskIds.sort(), ["t1", "t2"]);
  });

  test("one worker failure (NEEDS_CONTEXT) integrates no commits from that wave", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    const preHead = readHead(integ.path);

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: needsContextWorker(),
    });

    assert.equal(result.published, false);
    assert.deepEqual(result.integratedTaskIds, []);
    assert.equal(result.taskResults[0].status, "BLOCKED");
    assert.match(result.taskResults[0].reason, /model-status-NEEDS_CONTEXT/);
    assert.equal(readHead(integ.path), preHead);
  });

  test("a failed sibling does not block an independently successful task in the same wave", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [makeTask({ id: "ok-task", write_paths: ["a.txt"] }), makeTask({ id: "bad-task", write_paths: ["b.txt"] })];

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => {
        if (task.id === "bad-task") return needsContextWorker()(task, ctx);
        return goodWorker({ "a.txt": "ok-task change\n" })(task, ctx);
      },
    });

    assert.equal(result.published, true);
    assert.deepEqual(result.integratedTaskIds, ["ok-task"]);
    const okResult = result.taskResults.find((r) => r.taskId === "ok-task");
    const badResult = result.taskResults.find((r) => r.taskId === "bad-task");
    assert.equal(okResult.status, "READY");
    assert.equal(badResult.status, "BLOCKED");
  });

  test("a worker that STAGES its change is rejected — a normal worker leaves only owned changes for the host to commit", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: stagingWorker("a.txt", "staged content\n"),
    });
    assert.equal(result.taskResults[0].status, "BLOCKED");
    assert.match(result.taskResults[0].reason, /ownership-check-failed:index-staged/);
    assert.equal(result.published, false);
    // Dirty/unintegrated worktree is never force-removed.
    assert.ok(existsSync(result.taskResults[0].worktreePath));
  });

  test("out-of-scope changed files reject the worker's implicit receipt", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "in scope\n", "b.txt": "OUT OF SCOPE\n" }),
    });
    assert.equal(result.taskResults[0].status, "BLOCKED");
    assert.match(result.taskResults[0].reason, /ownership-check-failed:out-of-scope/);
  });

  test("a failing host verification command blocks the task and overrides a model-reported DONE", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"], verify: [FAIL_VERIFY] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }), // model claims DONE
    });
    assert.equal(result.taskResults[0].status, "BLOCKED");
    assert.equal(result.taskResults[0].reason, "verification-failed");
    assert.equal(result.published, false);
  });

  test("verification residue (content mutated during verification) blocks the task", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const mutatingVerify = { id: "mutator", argv: ["node", "-e", "require('fs').appendFileSync('a.txt', 'mutated\\n')"], cwd: ".", requires_approval_ids: [] };
    const task = makeTask({ id: "t1", write_paths: ["a.txt"], verify: [mutatingVerify] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }, {}),
    });
    assert.equal(result.taskResults[0].status, "BLOCKED");
    assert.equal(result.taskResults[0].reason, "verification-diff-residue");
  });

  test("NEEDS_CONTEXT and BLOCKED model statuses never commit or integrate; DONE_WITH_CONCERNS integrates and surfaces concerns", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }, { status: "DONE_WITH_CONCERNS", concerns: ["minor style nit"] }),
    });
    assert.equal(result.published, true);
    assert.equal(result.taskResults[0].status, "READY");
    assert.deepEqual(result.taskResults[0].report.concerns, ["minor style nit"]);
  });

  test("the host creates exactly one clean non-merge commit after verification, authenticated in the task result", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }),
    });
    const r = result.taskResults[0];
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    const msg = git(r.worktreePath, ["log", "-1", "--format=%s", r.commit]);
    assert.equal(msg, `supervise(${runId}): t1`);
    const parentCount = git(r.worktreePath, ["rev-list", "--count", `${info.headCommit}..${r.commit}`]);
    assert.equal(parentCount, "1");
  });

  test("successful commits survive for recovery and are discoverable via isCommitIntegrated without rerunning the task", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }),
    });
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: result.taskResults[0].commit }), true);
    // A recovery pass would consult isCommitIntegrated and skip re-running
    // "t1" entirely — this is the property that makes recovery cheap.
  });

  test("successful waves integrate in task-ID order", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [
      makeTask({ id: "zzz", write_paths: ["b.txt"] }),
      makeTask({ id: "aaa", write_paths: ["a.txt"] }),
      makeTask({ id: "mmm", write_paths: ["c.txt"] }),
    ];
    const order = [];
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 3,
      runWorker: async (task, ctx) => {
        writeFileSync(join(ctx.worktreePath, task.write_paths[0]), `${task.id}\n`);
        return { processExitCode: 0, report: { status: "DONE", summary: "s", acceptance: task.acceptance_ids.map((id) => ({ id, status: "PASS", evidence: "e" })), verification: task.verify.map((v) => ({ id: v.id, status: "PASS", summary: "ok" })), concerns: [], blockers: [] } };
      },
    });
    assert.equal(result.published, true);
    assert.deepEqual(result.integratedTaskIds, ["aaa", "mmm", "zzz"]);
    // Confirm actual cherry-pick order via the trailer commit log order too.
    const log = git(integ.path, ["log", "--format=%s", "--reverse", `${info.headCommit}..HEAD`]);
    assert.deepEqual(log.split("\n"), [`supervise(${runId}): aaa`, `supervise(${runId}): mmm`, `supervise(${runId}): zzz`]);
  });

  test("REGRESSION at the wave-execution level: cross-wave base drift makes the second candidate cherry-pick conflict, and the first (unrelated-file) commit from that wave is never published", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const originalHead = info.headCommit;

    // Wave 1: a "seed" task legitimately changes a.txt and integrates.
    const seedResult = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [makeTask({ id: "seed", write_paths: ["a.txt"] })],
      baseCommit: originalHead, worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "seed content\n" }),
    });
    assert.equal(seedResult.published, true);
    const postSeedHead = seedResult.integrationHead;
    assert.notEqual(postSeedHead, originalHead);

    // Wave 2: planned (by construction of this test) against the ORIGINAL
    // pre-seed base — simulating stale/recovered wave-two planning. Task
    // "c-task" touches an unrelated file (must integrate first, sorted
    // before "z-task"); task "z-task" touches a.txt, which conflicts with
    // what wave 1 already published.
    const tasks = [
      makeTask({ id: "c-task", wave: 2, write_paths: ["b.txt"] }),
      makeTask({ id: "z-task", wave: 2, write_paths: ["a.txt"] }),
    ];
    const result = await executeWave({
      repoInfo: info, runId, wave: 2, tasks, baseCommit: originalHead,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => {
        const content = task.id === "c-task" ? "c-task change\n" : "z-task conflicting change\n";
        return goodWorker({ [task.write_paths[0]]: content })(task, ctx);
      },
    });

    assert.equal(result.published, false, "the wave must not publish");
    assert.deepEqual(result.integratedTaskIds, [], "nothing integrates, including the commit that cherry-picked cleanly");
    assert.ok(result.conflict, "a conflict must be recorded");
    assert.equal(result.conflict.taskId, "z-task");

    const cTaskResult = result.taskResults.find((r) => r.taskId === "c-task");
    const zTaskResult = result.taskResults.find((r) => r.taskId === "z-task");
    assert.equal(cTaskResult.status, "BLOCKED");
    assert.equal(cTaskResult.reason, "candidate-integration-aborted-by-sibling-conflict");
    assert.equal(zTaskResult.status, "BLOCKED");
    assert.equal(zTaskResult.reason, "candidate-cherry-pick-conflict");

    // THE PROOF: integration HEAD is byte-for-byte where wave 1 left it.
    assert.equal(readHead(integ.path), postSeedHead);
    assert.equal(isWorktreeClean(integ.path), true);
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: cTaskResult.commit }), false);
    assert.ok(existsSync(result.candidateLogPath));
  });

  test("assertParallelSafe is enforced before any worktree is created", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [makeTask({ id: "t1", write_paths: ["src/"] }), makeTask({ id: "t2", write_paths: ["src/x.txt"] })];
    await assert.rejects(executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: async () => { throw new Error("must never be called"); },
    }), SchedulerError);
  });

  test("operationTracking, when supplied, calls beginTrackedOperation with the host pid before running the pool", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const persisted = [];
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });
    await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }),
      operationTracking: {
        updateRunFn: async (event) => { persisted.push(event); return {}; },
        eventType: "RUN_WAVE_1",
      },
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].type, "RUN_WAVE_1");
    assert.equal(persisted[0].operation.pid, process.pid);
    assert.equal(persisted[0].operation.kind, "wave-1");
  });
});

// --------------------------------------------------------------------------
// effectiveSessionPolicy / buildCodexWorker — carry-forwards #6-#9
// --------------------------------------------------------------------------

describe("effectiveSessionPolicy", () => {
  test("a wave-one task (no session_policy field at all) is always 'fresh'", () => {
    assert.equal(effectiveSessionPolicy({ id: "t1" }, { resumeSupported: true }), "fresh");
  });
  test("an explicit 'fresh' correction stays 'fresh' regardless of resumeSupported", () => {
    assert.equal(effectiveSessionPolicy({ session_policy: "fresh" }, { resumeSupported: true }), "fresh");
  });
  test("'resume-exact' is honored only when preflight.resumeSupported is true", () => {
    assert.equal(effectiveSessionPolicy({ session_policy: "resume-exact" }, { resumeSupported: true }), "resume-exact");
  });
  test("'resume-exact' falls back to 'fresh' when preflight.resumeSupported is false — carry-forward #7", () => {
    assert.equal(effectiveSessionPolicy({ session_policy: "resume-exact" }, { resumeSupported: false }), "fresh");
  });
  test("'resume-exact' falls back to 'fresh' when preflight is missing entirely (fails closed)", () => {
    assert.equal(effectiveSessionPolicy({ session_policy: "resume-exact" }, null), "fresh");
    assert.equal(effectiveSessionPolicy({ session_policy: "resume-exact" }, undefined), "fresh");
  });
});

// A minimal fake `codex` binary — just enough of `exec`/`exec resume` to
// exercise buildCodexWorker's argv construction and outputPath/resume
// branching, mirroring (at far smaller scale) the fake-codex harness in
// tests/unit/supervise-codex.test.mjs. Records every invocation's argv to
// FAKE_CODEX_RECORD as one JSON line per call.
const FAKE_CODEX_MIN = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const rec = process.env.FAKE_CODEX_RECORD;
if (rec) appendFileSync(rec, JSON.stringify({ argv }) + "\\n", "utf8");
if (argv[0] === "exec") {
  const olmIdx = argv.indexOf("--output-last-message");
  const outPath = olmIdx >= 0 ? argv[olmIdx + 1] : null;
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + "\\n");
  if (outPath) writeFileSync(outPath, JSON.stringify({ status: "DONE", summary: "s", acceptance: [], verification: [], concerns: [], blockers: [] }), "utf8");
  process.exit(0);
}
process.exit(2);
`;

function setupFakeCodexMin() {
  const dir = mkdtempSync(join(tmpdir(), "sup-sched-codex-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  writeFileSync(fakeCodex, FAKE_CODEX_MIN, "utf8");
  chmodSync(fakeCodex, 0o755);
  const recordFile = join(dir, "record.jsonl");
  return { dir, fakeCodex, recordFile };
}

function recordedCalls(recordFile) {
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

describe("buildCodexWorker", () => {
  test("uses a fresh outputPath on every attempt for the same task id — carry-forward #8", async () => {
    const { dir, fakeCodex, recordFile } = setupFakeCodexMin();
    const worker = buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "do the thing", logsDir: dir,
      model: "gpt-5.6-sol", preflight: { resumeSupported: false },
      codexBin: fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: recordFile },
    });
    const task = { id: "t1", effort: "high", session_policy: "fresh" };
    const ctx = { worktreePath: dir, baseCommit: "0".repeat(40) };
    const r1 = await worker(task, ctx);
    const r2 = await worker(task, ctx);
    assert.equal(r1.processExitCode, 0);
    assert.equal(r2.processExitCode, 0);

    const calls = recordedCalls(recordFile);
    const outPaths = calls.map((c) => {
      const idx = c.argv.indexOf("--output-last-message");
      return c.argv[idx + 1];
    });
    assert.equal(outPaths.length, 2);
    assert.notEqual(outPaths[0], outPaths[1]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("branches on resumeSupported: a resume-exact task with resumeSupported:false runs FRESH (no threadId positional, no 'resume' subcommand) — carry-forward #7", async () => {
    const { dir, fakeCodex, recordFile } = setupFakeCodexMin();
    const worker = buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "do the thing", logsDir: dir,
      model: "gpt-5.6-sol", preflight: { resumeSupported: false },
      resumeThreadIdFor: () => "0199a213-81c0-7800-8aa1-bbab2a035a53",
      codexBin: fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: recordFile },
    });
    const task = { id: "t1", effort: "high", session_policy: "resume-exact" };
    const result = await worker(task, { worktreePath: dir, baseCommit: "0".repeat(40) });
    assert.equal(result.effectiveSessionPolicy, "fresh");
    const calls = recordedCalls(recordFile);
    assert.equal(calls[0].argv[0], "exec");
    assert.notEqual(calls[0].argv[1], "resume");
    rmSync(dir, { recursive: true, force: true });
  });

  test("branches on resumeSupported: a resume-exact task with resumeSupported:true runs the resume argv shape", async () => {
    const { dir, fakeCodex, recordFile } = setupFakeCodexMin();
    const worker = buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "do the thing", logsDir: dir,
      model: "gpt-5.6-sol", preflight: { resumeSupported: true },
      resumeThreadIdFor: () => "0199a213-81c0-7800-8aa1-bbab2a035a53",
      codexBin: fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: recordFile },
    });
    const task = { id: "t1", effort: "high", session_policy: "resume-exact" };
    const result = await worker(task, { worktreePath: dir, baseCommit: "0".repeat(40) });
    assert.equal(result.effectiveSessionPolicy, "resume-exact");
    const calls = recordedCalls(recordFile);
    assert.equal(calls[0].argv[1], "resume");
    assert.ok(calls[0].argv.includes("0199a213-81c0-7800-8aa1-bbab2a035a53"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("parses the worker report from the finished --output-last-message file", async () => {
    const { dir, fakeCodex, recordFile } = setupFakeCodexMin();
    const worker = buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "do the thing", logsDir: dir,
      model: "gpt-5.6-sol", preflight: { resumeSupported: false },
      codexBin: fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: recordFile },
    });
    const result = await worker({ id: "t1", effort: "high" }, { worktreePath: dir, baseCommit: "0".repeat(40) });
    assert.equal(result.report.status, "DONE");
    assert.equal(result.threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects an unsupported model or effort BEFORE ever spawning — carry-forward #6 (query only through the exported predicates)", async () => {
    const { dir, fakeCodex, recordFile } = setupFakeCodexMin();
    assert.throws(() => buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "x", logsDir: dir,
      model: "gpt-3.5-turbo", preflight: { resumeSupported: false }, codexBin: fakeCodex,
    }), SchedulerError);

    const worker = buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "x", logsDir: dir,
      model: "gpt-5.6-sol", preflight: { resumeSupported: false }, codexBin: fakeCodex,
      env: { ...process.env, FAKE_CODEX_RECORD: recordFile },
    });
    await assert.rejects(worker({ id: "t1", effort: "ultra" }, { worktreePath: dir, baseCommit: "0".repeat(40) }), SchedulerError);
    assert.deepEqual(recordedCalls(recordFile), []); // never spawned
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires a prior preflight result — never re-probes per task", () => {
    assert.throws(() => buildCodexWorker({ schemaPath: "/a", buildPrompt: () => "x", logsDir: "/tmp" }), SchedulerError);
  });

  test("never mutates a frozen preflight result — carry-forward #9's discipline (requiredSkills is frozen upstream; this file must not be the thing that tries to touch it)", async () => {
    const { dir, fakeCodex, recordFile } = setupFakeCodexMin();
    const preflight = Object.freeze({
      resumeSupported: true,
      requiredSkills: Object.freeze(["test-driven-development", "systematic-debugging"]),
      missingSkills: [],
    });
    const worker = buildCodexWorker({
      schemaPath: "/abs/schema.json", buildPrompt: () => "x", logsDir: dir,
      model: "gpt-5.6-sol", preflight, resumeThreadIdFor: () => "0199a213-81c0-7800-8aa1-bbab2a035a53",
      codexBin: fakeCodex, env: { ...process.env, FAKE_CODEX_RECORD: recordFile },
    });
    // Would throw a TypeError on any attempted mutation of the frozen
    // preflight/requiredSkills, since both are genuinely frozen.
    await assert.doesNotReject(worker({ id: "t1", effort: "high", session_policy: "resume-exact" }, { worktreePath: dir, baseCommit: "0".repeat(40) }));
    assert.equal(effectiveSessionPolicy({ session_policy: "resume-exact" }, preflight), "resume-exact");
    rmSync(dir, { recursive: true, force: true });
  });
});
