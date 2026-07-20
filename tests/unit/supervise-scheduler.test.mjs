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
  buildTaskReceipt,
  clampConcurrency,
  MAX_WORKER_CONCURRENCY,
} from "../../plugins/contexthub/scripts/supervise/scheduler.mjs";
import { summarizeUsage } from "../../plugins/contexthub/scripts/supervise/checkpoint.mjs";
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
  test("never exceeds the global MAX_WORKER_CONCURRENCY cap", () => {
    for (let score = 1; score <= 5; score++) {
      assert.ok(recommendedConcurrency(score) <= MAX_WORKER_CONCURRENCY);
    }
  });
});

describe("clampConcurrency — the plan's verbatim 'at most three Codex workers concurrently'", () => {
  test("MAX_WORKER_CONCURRENCY is 3", () => {
    assert.equal(MAX_WORKER_CONCURRENCY, 3);
  });

  test("an OVER-CAP request is clamped to 3, never honored", () => {
    assert.equal(clampConcurrency(10, 6), 3);
    assert.equal(clampConcurrency(100, 50), 3);
    assert.equal(clampConcurrency(4, 6), 3);
  });

  test("an OMITTED value defaults to the cap, never to tasks.length", () => {
    assert.equal(clampConcurrency(undefined, 6), 3);
    assert.equal(clampConcurrency(null, 12), 3);
  });

  test("an under-cap request is honored as-is", () => {
    assert.equal(clampConcurrency(1, 6), 1);
    assert.equal(clampConcurrency(2, 6), 2);
  });

  test("never exceeds the task count (no point starting more workers than tasks)", () => {
    assert.equal(clampConcurrency(3, 1), 1);
    assert.equal(clampConcurrency(undefined, 2), 2);
  });

  test("invalid values (0, negative, non-integer) fall back to the cap rather than disabling concurrency", () => {
    assert.equal(clampConcurrency(0, 6), 3);
    assert.equal(clampConcurrency(-5, 6), 3);
    assert.equal(clampConcurrency(2.7, 6), 3);
  });
});

// --------------------------------------------------------------------------
// getRunnableTasks
// --------------------------------------------------------------------------

describe("getRunnableTasks", () => {
  // These graphs use `depends_on: []` throughout — the ONLY shape
  // assertParallelSafe (and contracts.mjs) actually accepts. The previous
  // test used `depends_on: ["t1"]`, which no accepted graph can contain,
  // and that is precisely why it hid the wave-filtering defect.
  function mixedWaveGraph() {
    return {
      tasks: [
        makeTask({ id: "w1a", wave: 1, write_paths: ["a.txt"] }),
        makeTask({ id: "w1b", wave: 1, write_paths: ["b.txt"] }),
        makeTask({ id: "w2a", wave: 2, write_paths: ["c.txt"] }),
      ],
    };
  }

  test("returns only the requested wave's tasks — a wave-2 task is NOT runnable during wave 1", () => {
    const graph = mixedWaveGraph();
    assert.deepEqual(getRunnableTasks(graph, [], 1).map((t) => t.id), ["w1a", "w1b"]);
    assert.deepEqual(getRunnableTasks(graph, [], 2).map((t) => t.id), ["w2a"]);
  });

  test("excludes already-completed tasks within the requested wave", () => {
    const graph = mixedWaveGraph();
    assert.deepEqual(getRunnableTasks(graph, ["w1a"], 1).map((t) => t.id), ["w1b"]);
    assert.deepEqual(getRunnableTasks(graph, ["w1a", "w1b"], 1).map((t) => t.id), []);
    // Completing wave 1 does not make wave 2 runnable under a wave-1 query.
    assert.deepEqual(getRunnableTasks(graph, ["w1a", "w1b"], 1).map((t) => t.id), []);
    assert.deepEqual(getRunnableTasks(graph, ["w1a", "w1b"], 2).map((t) => t.id), ["w2a"]);
  });

  test("a correction graph's tasks (no per-task wave field, graph-level wave: 2) are treated as wave 2", () => {
    const correctionGraph = {
      wave: 2,
      tasks: [
        { ...makeTask({ id: "fix-a", write_paths: ["a.txt"] }), wave: undefined },
        { ...makeTask({ id: "fix-b", write_paths: ["b.txt"] }), wave: undefined },
      ],
    };
    assert.deepEqual(getRunnableTasks(correctionGraph, [], 2).map((t) => t.id), ["fix-a", "fix-b"]);
    assert.deepEqual(getRunnableTasks(correctionGraph, [], 1).map((t) => t.id), []);
  });

  test("requires an explicit wave — omitting it would silently return both waves' tasks", () => {
    const graph = mixedWaveGraph();
    assert.throws(() => getRunnableTasks(graph, []), SchedulerError);
    assert.throws(() => getRunnableTasks(graph, [], 3), SchedulerError);
  });

  test("REGRESSION: for a graph the system would actually accept (every depends_on empty), wave filtering is the only thing separating the waves", () => {
    const graph = mixedWaveGraph();
    // Every task has an empty depends_on, so the dependency clause is
    // vacuously true for all three. If wave were ignored, this would return
    // all 3 tasks — the exact defect this fix closes.
    assert.ok(graph.tasks.every((t) => t.depends_on.length === 0));
    const wave1 = getRunnableTasks(graph, [], 1);
    assert.equal(wave1.length, 2);
    assert.ok(!wave1.some((t) => t.id === "w2a"), "a wave-2 task must never be runnable during wave 1");
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

  // ------------------------------------------------------------------------
  // WAVE-LEVEL ALL-OR-NOTHING (plan line 1570: "one worker failure integrates
  // no commits FROM THAT WAVE"). This is the WORKER-FAILURE all-or-nothing
  // path — distinct from the CANDIDATE CHERRY-PICK CONFLICT path exercised
  // further below, which is a different failure mode with its own handling.
  // ------------------------------------------------------------------------

  test("WAVE ALL-OR-NOTHING: one worker failure integrates no commits from that wave — including its SUCCESSFUL siblings", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    // Deliberately MULTI-task: a single-task wave cannot distinguish
    // "no commits from that worker" from "no commits from that wave", so a
    // one-task version of this test would be unfalsifiable.
    const tasks = [
      makeTask({ id: "ok-one", write_paths: ["a.txt"] }),
      makeTask({ id: "ok-two", write_paths: ["b.txt"] }),
      makeTask({ id: "bad-task", write_paths: ["c.txt"] }),
    ];
    const preHead = readHead(integ.path);

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 3,
      runWorker: async (task, ctx) => {
        if (task.id === "bad-task") return needsContextWorker()(task, ctx);
        return goodWorker({ [task.write_paths[0]]: `${task.id} change\n` })(task, ctx);
      },
    });

    assert.equal(result.published, false, "a wave with any failed worker must not publish");
    assert.deepEqual(result.integratedTaskIds, [], "no commits integrate, including the successful siblings'");
    assert.equal(result.waveOutcome, "BLOCKED_BY_TASK_FAILURE");
    assert.equal(readHead(integ.path), preHead, "integration HEAD must be byte-for-byte unchanged");
    assert.equal(isWorktreeClean(integ.path), true);

    // The two successful tasks genuinely SUCCEEDED — they are not retro-
    // actively marked failed. Only integration was withheld.
    const okOne = result.taskResults.find((r) => r.taskId === "ok-one");
    const okTwo = result.taskResults.find((r) => r.taskId === "ok-two");
    const bad = result.taskResults.find((r) => r.taskId === "bad-task");
    assert.equal(okOne.status, "READY");
    assert.equal(okTwo.status, "READY");
    assert.equal(bad.status, "BLOCKED");
    assert.match(bad.reason, /model-status-NEEDS_CONTEXT/);
  });

  test("WAVE ALL-OR-NOTHING: successful task commits still exist and survive on their private task branches for a later wave or recovery pass", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [
      makeTask({ id: "ok-one", write_paths: ["a.txt"] }),
      makeTask({ id: "bad-task", write_paths: ["c.txt"] }),
    ];

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => {
        if (task.id === "bad-task") return needsContextWorker()(task, ctx);
        return goodWorker({ "a.txt": "ok-one change\n" })(task, ctx);
      },
    });

    assert.equal(result.published, false);
    const okOne = result.taskResults.find((r) => r.taskId === "ok-one");
    assert.equal(okOne.status, "READY");

    // THIS IS THE POINT OF PLAN LINE 1571. All-or-nothing withholds
    // INTEGRATION; it must not delete or orphan the work itself. The commit
    // was really created, is reachable on its own task branch, and carries
    // the host-authored message — so wave two (or a recovery pass) can
    // cherry-pick it without re-spending a worker.
    assert.match(okOne.commit, /^[0-9a-f]{40}$/);
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: okOne.commit }), false,
      "not integrated — the wave failed");
    const onTaskBranch = git(info.topLevel, ["rev-list", okOne.branch]).split("\n");
    assert.ok(onTaskBranch.includes(okOne.commit), "the commit must survive on its private task branch");
    assert.equal(git(info.topLevel, ["log", "-1", "--format=%s", okOne.commit]), `supervise(${runId}): ok-one`);

    // The receipt (usage, thread ID, verification, log paths) survives too —
    // none of it is re-derivable from git.
    assert.ok(okOne.receipt);
    assert.equal(okOne.receipt.commit, okOne.commit);
    assert.equal(okOne.receipt.ownership_valid, true);

    // And the wave-level outcome is unambiguous for Task 10: it can tell
    // "wave failed, N commits available for later" from "wave published".
    assert.equal(result.waveOutcome, "BLOCKED_BY_TASK_FAILURE");
    assert.deepEqual(result.readyTaskIds, ["ok-one"]);
  });

  test("WAVE ALL-OR-NOTHING: no candidate worktree or branch is ever created when a task failed", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [
      makeTask({ id: "ok-one", write_paths: ["a.txt"] }),
      makeTask({ id: "bad-task", write_paths: ["c.txt"] }),
    ];

    // Observe candidate CREATION directly rather than inferring it from
    // post-state: a published candidate is removed on success and an aborted
    // one is removed on failure, so the end state is identical either way and
    // proves nothing. createCandidateIntegration necessarily calls
    // worktreePaths.candidatePath(wave), so spying on it detects the attempt
    // itself.
    let candidatePathRequested = 0;
    const realCandidatePath = worktreePaths.candidatePath;
    const spiedPaths = {
      ...worktreePaths,
      candidatePath: (w) => { candidatePathRequested += 1; return realCandidatePath(w); },
    };

    await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths: spiedPaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => {
        if (task.id === "bad-task") return needsContextWorker()(task, ctx);
        return goodWorker({ "a.txt": "change\n" })(task, ctx);
      },
    });

    // Not merely "aborted cleanly" — never built at all.
    assert.equal(candidatePathRequested, 0, "candidate integration must not even be attempted when a task failed");
    assert.equal(existsSync(worktreePaths.candidatePath(1)), false, "no candidate worktree may be created");
    const branches = git(info.topLevel, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n");
    assert.ok(!branches.includes(`carefully-crafted/${runId}/candidate-w1`), "no candidate branch may be created");
  });

  test("WAVE ALL-OR-NOTHING: a wave in which EVERY task succeeds still publishes normally", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [
      makeTask({ id: "ok-one", write_paths: ["a.txt"] }),
      makeTask({ id: "ok-two", write_paths: ["b.txt"] }),
    ];

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => goodWorker({ [task.write_paths[0]]: `${task.id} change\n` })(task, ctx),
    });

    assert.equal(result.published, true);
    assert.equal(result.waveOutcome, "PUBLISHED");
    assert.deepEqual(result.integratedTaskIds, ["ok-one", "ok-two"]);
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
      // This test's whole point is a STALE base (simulating recovered or
      // out-of-date wave-two planning), which is exactly the deliberate
      // override the base-commit guard exists to make explicit rather than
      // silent. Without this flag the guard would (correctly) reject the
      // wave before the conflict this test exists to produce.
      allowBaseDrift: true,
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
    // The SECOND all-or-nothing path, reported distinctly from the
    // worker-failure one: here every task genuinely succeeded, and it is
    // composition onto the current integration HEAD that failed.
    assert.equal(result.waveOutcome, "BLOCKED_BY_CANDIDATE_CONFLICT");

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

  test("CONCURRENCY CAP: an omitted concurrency never launches more than 3 workers at once, even for a 6-task wave", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => makeTask({ id, write_paths: [`${id}.txt`] }));
    let inFlight = 0;
    let maxInFlight = 0;

    await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      // concurrency deliberately OMITTED — previously this meant tasks.length
      runWorker: async (task, ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return goodWorker({ [task.write_paths[0]]: `${task.id}\n` })(task, ctx);
      },
    });

    assert.ok(maxInFlight <= MAX_WORKER_CONCURRENCY, `expected at most ${MAX_WORKER_CONCURRENCY} concurrent workers, observed ${maxInFlight}`);
  });

  test("CONCURRENCY CAP: an explicit over-cap request (10) is clamped, not honored", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => makeTask({ id, write_paths: [`${id}.txt`] }));
    let inFlight = 0;
    let maxInFlight = 0;

    await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 10,
      runWorker: async (task, ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return goodWorker({ [task.write_paths[0]]: `${task.id}\n` })(task, ctx);
      },
    });

    assert.ok(maxInFlight <= MAX_WORKER_CONCURRENCY, `expected at most ${MAX_WORKER_CONCURRENCY} concurrent workers, observed ${maxInFlight}`);
  });

  test("IDENTITY GATE: a repo with unusable git identity is rejected BEFORE any worker is dispatched", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const unusableIdentityInfo = { ...info, identityOk: false, prerequisiteError: "Git author/committer identity is not usable (test)" };
    let dispatched = false;

    await assert.rejects(executeWave({
      repoInfo: unusableIdentityInfo, runId, wave: 1, tasks: [makeTask({ id: "t1", write_paths: ["a.txt"] })],
      baseCommit: info.headCommit, worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: async () => { dispatched = true; throw new Error("must never be called"); },
    }), SchedulerError);

    assert.equal(dispatched, false, "no worker may be dispatched when the identity prerequisite fails");
  });

  test("BASE-COMMIT GUARD: a wave whose baseCommit does not match the integration HEAD is rejected before dispatch", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    let dispatched = false;

    await assert.rejects(executeWave({
      repoInfo: info, runId, wave: 1, tasks: [makeTask({ id: "t1", write_paths: ["a.txt"] })],
      baseCommit: "0".repeat(40), // a base that is not the integration HEAD
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: async () => { dispatched = true; throw new Error("must never be called"); },
    }), SchedulerError);

    assert.equal(dispatched, false, "a stale base must fail fast, before worker cost is incurred");
  });

  test("BASE-COMMIT GUARD: allowBaseDrift:true permits a deliberate stale-base run", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    // Advance the integration HEAD so baseCommit is genuinely stale.
    writeFileSync(join(integ.path, "drift.txt"), "drift\n");
    git(integ.path, ["add", "-A"]);
    git(integ.path, ["commit", "-qm", "drift"]);

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [makeTask({ id: "t1", write_paths: ["a.txt"] })],
      baseCommit: info.headCommit, allowBaseDrift: true,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }),
    });
    assert.equal(result.published, true);
  });

  test("USAGE PRESERVED ON FAILURE: thread ID and token usage survive on every failing path, not just READY", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const usage = { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 25 };
    const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    // Out-of-scope write => ownership failure, AFTER the worker spent tokens.
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [makeTask({ id: "t1", write_paths: ["a.txt"] })],
      baseCommit: info.headCommit, worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: async (task, ctx) => {
        writeFileSync(join(ctx.worktreePath, "a.txt"), "in scope\n");
        writeFileSync(join(ctx.worktreePath, "b.txt"), "OUT OF SCOPE\n");
        return { processExitCode: 0, threadId, usage, report: null };
      },
    });

    const r = result.taskResults[0];
    assert.equal(r.status, "BLOCKED");
    assert.match(r.reason, /ownership-check-failed/);
    // The cost evidence must NOT have been discarded.
    assert.equal(r.receipt.thread_id, threadId);
    assert.equal(r.receipt.usage.input_tokens, 1000);
    assert.equal(r.receipt.usage.output_tokens, 50);
    assert.equal(r.receipt.ownership_valid, false);
    assert.equal(r.receipt.commit, null);
  });

  test("RECEIPT ENVELOPE: a successful task produces the full Step 6 host-authenticated shape", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const usage = { inputTokens: 18420, cachedInputTokens: 12000, outputTokens: 1730, reasoningOutputTokens: 450 };
    const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [makeTask({ id: "t1", write_paths: ["a.txt"] })],
      baseCommit: info.headCommit, worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: async (task, ctx) => {
        const base = await goodWorker({ "a.txt": "change\n" })(task, ctx);
        return { ...base, threadId, usage };
      },
    });

    const receipt = result.taskResults[0].receipt;
    // Every field from the brief's Step 6 envelope, present and host-derived.
    assert.equal(receipt.version, 1);
    assert.equal(receipt.task_id, "t1");
    assert.equal(receipt.thread_id, threadId);
    assert.deepEqual(receipt.usage, { input_tokens: 18420, cached_input_tokens: 12000, output_tokens: 1730, reasoning_output_tokens: 450 });
    assert.match(receipt.commit, /^[0-9a-f]{40}$/);
    assert.equal(receipt.commit_source, "host-after-verification");
    assert.deepEqual(receipt.actual_changed_files, ["a.txt"]);
    assert.equal(receipt.ownership_valid, true);
    assert.equal(receipt.process_exit_code, 0);
    assert.equal(receipt.host_verification.length, 1);
    assert.equal(receipt.host_verification[0].status, "PASS");
    assert.match(receipt.host_verification[0].log_path, /\.log$/);
    assert.equal(receipt.report.status, "DONE");
  });

  test("RECEIPT ENVELOPE: receipts from a wave feed summarizeUsage directly — closing the producer gap", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const tasks = [makeTask({ id: "t1", write_paths: ["a.txt"] }), makeTask({ id: "t2", write_paths: ["b.txt"] })];

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks, baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir, concurrency: 2,
      runWorker: async (task, ctx) => {
        const base = await goodWorker({ [task.write_paths[0]]: `${task.id}\n` })(task, ctx);
        return { ...base, threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53", usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5 } };
      },
    });

    const receipts = result.taskResults.map((r) => r.receipt);
    const totals = summarizeUsage(receipts);
    assert.equal(totals.receipt_count, 2);
    assert.equal(totals.input_tokens, 200);
    assert.equal(totals.cached_input_tokens, 20);
    assert.equal(totals.output_tokens, 40);
    assert.equal(totals.reasoning_output_tokens, 10);
  });

  // -------------------------------------------------------------------------
  // WORKER-FAILURE SHORT-CIRCUIT. Final whole-branch review finding: a
  // non-null workerOutcome.failureCategory (timeout, transport,
  // missing-completion, ...) used to fall through to ownership derivation
  // and then full host verification (build/test commands) against a
  // worker's partial, untrustworthy tree, paying that cost before failing
  // anyway on an unrelated downstream reason — and the category itself
  // never reached the receipt. `failureCategory`/`retryable` were computed
  // in buildCodexWorker but had no consumer anywhere in the system.
  // -------------------------------------------------------------------------

  test("a worker failure (non-null failureCategory) short-circuits to BLOCKED before host verification ever runs", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const marker = join(worktreePaths.root, "verification-ran.marker");
    const verifyThatMarks = {
      id: "marker",
      argv: ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      cwd: ".", requires_approval_ids: [],
    };
    const task = makeTask({ id: "t1", write_paths: ["a.txt"], verify: [verifyThatMarks] });

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      // A worker that made SOME partial progress (so it would otherwise
      // clear the ownership check) before timing out — the realistic shape
      // of a worker that failed partway through, not one that never ran.
      runWorker: async (t, ctx) => {
        writeFileSync(join(ctx.worktreePath, "a.txt"), "partial progress from a worker that then timed out\n");
        return { processExitCode: null, threadId: null, usage: null, failureCategory: "timeout", report: null };
      },
    });

    const r = result.taskResults[0];
    assert.equal(r.status, "BLOCKED");
    assert.equal(r.reason, "worker-failed:timeout");
    assert.equal(
      existsSync(marker), false,
      "host verification must NOT run against a failed worker's partial tree — this is the wasted cost the fix closes"
    );
    assert.equal(result.published, false);
  });

  test("the failure category survives onto the receipt as failure_category, even though it is never auto-retried", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: async () => ({ processExitCode: 1, threadId: null, usage: null, failureCategory: "transport", report: null }),
    });

    const r = result.taskResults[0];
    assert.equal(r.status, "BLOCKED");
    assert.equal(r.reason, "worker-failed:transport");
    assert.equal(r.receipt.failure_category, "transport");
    // Not having auto-retry is correct (plan line 204) — this only asserts
    // the category is visible, not that anything acts on it automatically.
    assert.equal(result.published, false);
  });

  test("a clean worker (no failureCategory) is unaffected: failure_category is null and verification still runs", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [makeTask({ id: "t1", write_paths: ["a.txt"] })],
      baseCommit: info.headCommit, worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }),
    });
    const r = result.taskResults[0];
    assert.equal(r.receipt.failure_category, null);
    assert.equal(r.receipt.host_verification.length, 1, "verification must still run normally when there is no worker failure");
  });

  test("INTEGRATION-PHASE THROW: taskResults survive a candidate-creation failure rather than being discarded", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });

    // Force a candidate collision: pre-create the candidate branch that
    // executeWave will try to create, WITHOUT a matching ledger entry — the
    // exact "prior crashed wave" shape that trips the idempotency gate.
    git(info.topLevel, ["branch", `carefully-crafted/${runId}/candidate-w1`, info.headCommit]);

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "change\n" }),
    });

    // The wave did not publish — but the expensive per-task evidence is intact.
    assert.equal(result.published, false);
    assert.ok(result.integrationError, "an integrationError must be reported");
    assert.equal(result.integrationError.reason, "candidate-creation-failed");
    assert.equal(result.taskResults.length, 1);
    assert.equal(result.taskResults[0].status, "READY");
    assert.match(result.taskResults[0].commit, /^[0-9a-f]{40}$/);
    assert.ok(result.taskResults[0].receipt, "the receipt (usage, thread ID, verification) must survive");
    assert.equal(result.integrationHead, readHead(integ.path));
  });

  test("RECOVERY: a task commit that was never published still exists on its own task branch and is discoverable", async () => {
    const { info, runId, worktreePaths, integ, logsDir } = makeWaveHarness();
    const task = makeTask({ id: "t1", write_paths: ["a.txt"] });

    // Same forced candidate collision: the wave fails to publish, but the
    // host commit was already created on the task branch beforehand.
    git(info.topLevel, ["branch", `carefully-crafted/${runId}/candidate-w1`, info.headCommit]);

    const result = await executeWave({
      repoInfo: info, runId, wave: 1, tasks: [task], baseCommit: info.headCommit,
      worktreePaths, integrationWorktreePath: integ.path, logsDir,
      runWorker: goodWorker({ "a.txt": "survives\n" }),
    });

    assert.equal(result.published, false);
    const r = result.taskResults[0];
    assert.equal(r.status, "READY");

    // THE RECOVERY-RELEVANT ASSERTION: the commit is NOT on the integration
    // branch (the wave never published) but IS reachable on its own task
    // branch, so a recovery pass can find it instead of re-running the task.
    assert.equal(isCommitIntegrated({ repoInfo: info, ref: integ.branch, commit: r.commit }), false);
    const onTaskBranch = git(info.topLevel, ["rev-list", r.branch]).split("\n");
    assert.ok(onTaskBranch.includes(r.commit), "the commit must survive on its task branch for recovery");
    assert.equal(git(info.topLevel, ["log", "-1", "--format=%s", r.commit]), `supervise(${runId}): t1`);
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
