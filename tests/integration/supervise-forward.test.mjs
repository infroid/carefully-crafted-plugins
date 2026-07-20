// Machine-level forward scenarios for /contexthub:supervise (Task 13, Step 1).
//
// Each scenario below starts from a FRESH temporary git repository, drives
// the REAL CLI (plugins/contexthub/scripts/supervise.mjs:main) against a
// fake, spawned `codex` executable (pointed at via io.env.CODEX_BIN — the
// same injection point plugins/contexthub/scripts/supervise/codex.mjs's own
// tests and tests/unit/supervise-cli.test.mjs use), and asserts LEDGER STATE
// (run.json phase, receipts, checkpoints, evidence files) and GIT STATE
// (branches, commit graphs, file contents) rather than prose. No mocks of
// git itself are used anywhere in this file.
//
// The supervise engine (supervise.mjs and every module under supervise/)
// only ever spawns a `codex` binary — it has no Agy transport at all (Agy is
// wired into the separate `converge`/`agy:*` skills, not into supervision).
// So "fake providers" here means exactly one fake, spawned `codex`
// executable; there is no second binary to fake for this surface.
//
// TIMING POLICY (see tests/unit/supervise-codex.test.mjs:56 for the class of
// flake this repo avoids): every fake-codex invocation below exits promptly
// on its own, with no sleeps and no assertion that depends on a child
// reaching a checkpoint within a wall-clock bound. Every wait in this file is
// on a real child process actually exiting (awaited via the CLI's own
// promise chain), never on elapsed time.
//
// Run with: node --test tests/integration/supervise-forward.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { main } from "../../plugins/contexthub/scripts/supervise.mjs";
import { Phase, getRunPaths, updateRun, loadRun } from "../../plugins/contexthub/scripts/supervise/state.mjs";
import {
  inspectRepository, ensurePrivateWorktreeRoot, createTaskWorktree, inspectTaskChanges,
  createTaskCommit, inspectTaskCommit, assertCommitOwnership, isWorktreeClean,
  taskBranchName,
} from "../../plugins/contexthub/scripts/supervise/git.mjs";
import { buildTaskReceipt } from "../../plugins/contexthub/scripts/supervise/scheduler.mjs";
import { ContractError, validateCorrectionGraph, validateTaskGraph } from "../../plugins/contexthub/scripts/supervise/contracts.mjs";

// --------------------------------------------------------------------------
// Small git helper
// --------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// --------------------------------------------------------------------------
// Fake codex executable — identical in shape to
// tests/unit/supervise-cli.test.mjs's FAKE_CODEX (a generic, env-driven
// interpreter): FAKE_TASK_FILE_MAP / FAKE_TASK_ACCEPTANCE_MAP /
// FAKE_TASK_STATUS_MAP key a task's write path, satisfied acceptance ids,
// and terminal status off the worktree directory name (which always ends in
// the task id — see git.mjs:waveWorktreePath), so several tasks running in
// one wave each get correct, distinct output with no other coordination.
// FAKE_CODEX_RECORD, when set, appends one JSON line per `exec` invocation
// so a test can assert exactly which/how many workers were dispatched and at
// what effort — the argv a worker was actually launched with, not a claim
// about it.
// --------------------------------------------------------------------------

const FAKE_CODEX = `#!/usr/bin/env node
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
const argv = process.argv.slice(2);
const rec = process.env.FAKE_CODEX_RECORD;
if (rec && argv[0] === "exec") {
  appendFileSync(rec, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n", "utf8");
}
if (argv[0] === "--version") { process.stdout.write("codex-cli 0.144.5\\n"); process.exit(0); }
if (argv[0] === "login" && argv[1] === "status") {
  const status = Number(process.env.FAKE_CODEX_LOGIN_STATUS ?? "0");
  if (status === 0) process.stdout.write("Logged in\\n"); else process.stderr.write("Not logged in\\n");
  process.exit(status);
}
if (argv[0] === "plugin" && argv[1] === "--help") {
  process.stdout.write("Usage: codex plugin <COMMAND>\\n\\nCommands:\\n  list  List plugins\\n  add   Add a plugin\\n");
  process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "list" && argv[2] === "--help") {
  process.stdout.write("Usage: codex plugin list [OPTIONS]\\n\\nOptions:\\n  --json  Output as JSON\\n");
  process.exit(0);
}
if (argv[0] === "plugin" && argv[1] === "list" && argv[2] === "--json") {
  const status = Number(process.env.FAKE_CODEX_PLUGIN_STATUS ?? "0");
  process.stdout.write(process.env.FAKE_CODEX_PLUGIN_JSON ?? JSON.stringify({
    installed: [{ pluginId: "superpowers@openai-curated", installed: true, enabled: true, version: "1.0.0", source: { source: "local", path: process.env.FAKE_SUPERPOWERS_PATH } }],
  }));
  process.exit(status);
}
if (argv[0] === "exec" && argv[1] === "--help") {
  process.stdout.write([
    "Usage: codex exec [OPTIONS] [PROMPT]", "Options:", "  -C, --cd <DIR>",
    "  -s, --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]",
    "  --json", "  --output-schema <PATH>", "  -o, --output-last-message <PATH>",
    "  -m, --model <MODEL>", "  -c, --config <KEY=VALUE>", "",
  ].join("\\n"));
  process.exit(0);
}
if (argv[0] === "exec" && argv[1] === "resume" && argv[2] === "--help") {
  process.stdout.write([
    "Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]", "Options:", "  --json",
    "  --output-schema <PATH>", "  -o, --output-last-message <PATH>", "  -m, --model <MODEL>",
    "  -c, --config <KEY=VALUE>", "",
  ].join("\\n"));
  process.exit(0);
}
if (argv[0] === "exec") {
  const olmIdx = argv.indexOf("--output-last-message");
  const outPath = olmIdx >= 0 ? argv[olmIdx + 1] : null;
  const isGrader = argv.includes("read-only");

  if (process.env.FAKE_CODEX_GRADER_FAIL === "1" && isGrader) {
    process.stderr.write("rate limit exceeded\\n");
    process.exit(1);
  }

  const resumeThreadId = argv[1] === "resume" ? argv[argv.length - 2] : null;
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: resumeThreadId || "0199a213-81c0-7800-8aa1-bbab2a035a53" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }) + "\\n");
  if (!outPath) { process.exit(0); }
  mkdirSync(dirname(outPath), { recursive: true });
  if (isGrader) {
    const gradeOverride = process.env.FAKE_GRADER_OUTPUT;
    writeFileSync(outPath, gradeOverride || JSON.stringify({
      score: 3, confidence: 0.8, dimensions: { scope: 3, uncertainty: 2, coupling: 2, risk: 2, verification: 3 },
      reasons: ["straightforward"], risk_flags: [], unknowns: [], suggested_parallelism: 1,
      relevant_paths: ["a.txt"], verification_hints: ["run tests"],
    }));
    process.exit(0);
  }
  const cwdArg = argv[argv.indexOf("-C") + 1];
  const targetDir = cwdArg || process.cwd();
  const m = /wave-\\d+-([a-z0-9-]+)$/.exec(targetDir);
  const taskId = m ? m[1] : "unknown";
  const fileMap = JSON.parse(process.env.FAKE_TASK_FILE_MAP || "{}");
  const acceptanceMap = JSON.parse(process.env.FAKE_TASK_ACCEPTANCE_MAP || "{}");
  const statusMap = JSON.parse(process.env.FAKE_TASK_STATUS_MAP || "{}");
  const writeFile = fileMap[taskId] || "a.txt";
  const ids = acceptanceMap[taskId] || [];
  const status = statusMap[taskId] || "DONE";
  const verifyIdMap = JSON.parse(process.env.FAKE_TASK_VERIFY_ID_MAP || "{}");
  const verifyIds = verifyIdMap[taskId] || ["ok"];
  if (status !== "BLOCKED_NO_WRITE") {
    writeFileSync(targetDir + "/" + writeFile, "changed-by-worker-" + taskId + "\\n");
  }
  if (status === "DONE" || status === "BLOCKED_NO_WRITE") {
    writeFileSync(outPath, JSON.stringify({
      status: status === "BLOCKED_NO_WRITE" ? "NEEDS_CONTEXT" : "DONE",
      summary: "did the thing",
      acceptance: status === "BLOCKED_NO_WRITE" ? [] : ids.map((id) => ({ id, status: "PASS", evidence: "e2e" })),
      verification: status === "BLOCKED_NO_WRITE" ? [] : verifyIds.map((id) => ({ id, status: "PASS", summary: "ok" })),
      concerns: [], blockers: status === "BLOCKED_NO_WRITE" ? ["could not proceed"] : [],
    }));
  }
  process.exit(0);
} else {
  process.stderr.write("fake-codex: unrecognized invocation: " + JSON.stringify(argv) + "\\n");
  process.exit(2);
}
`;

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

function makeRepo(extraFiles = { "a.txt": "base-a\n" }) {
  const root = mkdtempSync(join(tmpdir(), "sup-fwd-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  for (const [name, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return { root, repo };
}

function makeHarness(extraFiles) {
  const { root, repo } = makeRepo(extraFiles);
  const initialHead = git(repo, ["rev-parse", "HEAD"]);
  const superpowersDir = join(root, "superpowers");
  for (const skill of ["test-driven-development", "systematic-debugging", "verification-before-completion", "receiving-code-review"]) {
    mkdirSync(join(superpowersDir, "skills", skill), { recursive: true });
  }
  const fakeCodexPath = join(root, "codex-fake.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX);
  chmodSync(fakeCodexPath, 0o755);
  const baseEnv = { ...process.env, CODEX_BIN: fakeCodexPath, FAKE_SUPERPOWERS_PATH: superpowersDir };
  return { root, repo, baseEnv, initialHead };
}

function makeIO(cwd, env, stdin = "") {
  const outBuf = [];
  const errBuf = [];
  return {
    io: { stdin, stdout: { write: (s) => outBuf.push(s) }, stderr: { write: (s) => errBuf.push(s) }, cwd: () => cwd, env },
    stdout: () => outBuf.join(""),
    stderr: () => errBuf.join(""),
  };
}

async function call(argvArr, cwd, env) {
  const { io, stdout, stderr } = makeIO(cwd, env);
  const code = await main(argvArr, io);
  const out = stdout().trim();
  return { code, out: out ? JSON.parse(out) : null, rawOut: stdout(), rawErr: stderr() };
}

function writeJson(dir, name, obj) {
  const p = join(dir, `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// The property every scenario must hold, checked explicitly rather than
// assumed: nothing in this file ever touches the user's ACTIVE checkout
// (harness.repo's own working tree/branch) — every mutation happens inside a
// private worktree under .carefully-crafted/worktrees/<run-id>/.
function assertOriginalRepoUntouched(harness) {
  assert.equal(git(harness.repo, ["status", "--porcelain"]), "", "the original repository checkout must have no uncommitted changes");
  assert.equal(git(harness.repo, ["rev-parse", "HEAD"]), harness.initialHead, "the original repository's HEAD must never move");
}

// Full init -> grade bootstrap, shared by every scenario. `graderOutput`, when
// supplied, becomes the fake grader's exact --output-schema JSON (used to
// exercise a specific complexity score).
async function initAndGrade(harness, { graderOutput } = {}) {
  const requestPath = join(harness.root, `request-${Math.random().toString(16).slice(2)}.md`);
  writeFileSync(requestPath, "Implement the requested change.\n");
  const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
  assert.equal(initRes.code, 0, initRes.rawErr);
  const runId = initRes.out.run_id;
  const integrationWorktree = initRes.out.integration_worktree;
  const gradeEnv = graderOutput ? { ...harness.baseEnv, FAKE_GRADER_OUTPUT: JSON.stringify(graderOutput) } : harness.baseEnv;
  const gradeRes = await call(["grade", "--run", runId], harness.repo, gradeEnv);
  assert.equal(gradeRes.code, 0, gradeRes.rawErr);
  return { runId, integrationWorktree, complexityPath: gradeRes.out.artifact };
}

// Commits a trivial plan file into the integration worktree and returns the
// resulting clean HEAD — every accept-plan call requires exactly this.
function commitPlan(integrationWorktree) {
  const relPath = "docs/superpowers/plans/plan.md";
  mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
  writeFileSync(join(integrationWorktree, relPath), "# plan\n");
  git(integrationWorktree, ["add", "-A"]);
  git(integrationWorktree, ["commit", "-qm", "plan"]);
  return { relPath, baseCommit: git(integrationWorktree, ["rev-parse", "HEAD"]) };
}

const OK_VERIFY = { id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] };
const FINAL_OK = { id: "final-ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] };

function readWorkerCalls(recordPath) {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.argv[0] === "exec" && r.argv.includes("workspace-write"));
}

// ============================================================================
// Scenario 1: localized bug — score 1, one high-effort worker.
//
// WHAT WOULD BREAK THIS: dispatching more than one worker for a single-task
// wave, running the worker at any effort other than "high", or failing to
// land its commit on the integration branch.
// ============================================================================

describe("scenario 1: localized bug (score 1, one high-effort worker)", () => {
  test("a single high-effort worker completes the run end to end", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, complexityPath } = await initAndGrade(harness, {
      graderOutput: {
        score: 1, confidence: 0.9, dimensions: { scope: 1, uncertainty: 1, coupling: 1, risk: 1, verification: 1 },
        reasons: ["single-file fix"], risk_flags: [], unknowns: [], suggested_parallelism: 1,
        relevant_paths: ["a.txt"], verification_hints: ["run tests"],
      },
    });
    assert.equal(JSON.parse(readFileSync(complexityPath, "utf8")).score, 1);

    const { relPath, baseCommit } = commitPlan(integrationWorktree);
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 1, claude_score: 1, override_reason: null },
      acceptance: [{ id: "AC-01", text: "off-by-one is fixed" }],
      approval_flags: [],
      final_verification: [FINAL_OK],
      tasks: [{
        id: "t1", wave: 1, objective: "fix off-by-one", depends_on: [], read_paths: [],
        write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY],
        effort: "high", risk: "low",
      }],
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(acceptRes.code, 0, acceptRes.rawErr);
    assert.equal(acceptRes.out.phase, "PLANNED");

    const recordPath = join(harness.root, "record.jsonl");
    const waveEnv = {
      ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath,
      FAKE_TASK_FILE_MAP: JSON.stringify({ t1: "a.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ t1: ["AC-01"] }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
    assert.equal(wave1Res.code, 0, wave1Res.rawErr);
    assert.equal(wave1Res.out.phase, "WAVE_1_COMPLETE");

    const workerCalls = readWorkerCalls(recordPath);
    assert.equal(workerCalls.length, 1, "exactly one worker must be dispatched for a score-1 localized fix");
    assert.ok(workerCalls[0].argv.includes("model_reasoning_effort=high"), "the worker must run at effort high, not any other tier");

    const integrationHead = git(integrationWorktree, ["rev-parse", "HEAD"]);
    assert.notEqual(integrationHead, baseCommit);
    assert.deepEqual(git(integrationWorktree, ["log", "--format=%s", `${baseCommit}..HEAD`]).split("\n"), [`supervise(${runId}): t1`]);
    assert.equal(readFileSync(join(integrationWorktree, "a.txt"), "utf8"), "changed-by-worker-t1\n");

    const reviewPath = writeJson(harness.root, "review", { acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "verified" }], summary: "fixed" });
    const reviewRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);
    assert.equal(reviewRes.code, 0, reviewRes.rawErr);
    assert.equal(reviewRes.out.phase, "VERIFYING");

    const verifyRes = await call(["verify", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(verifyRes.code, 0, verifyRes.rawErr);
    assert.equal(verifyRes.out.phase, "FINISH_PENDING");

    const decisionPath = writeJson(harness.root, "decision", { target: null });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "keep", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);
    const completeRes = await call(["complete-finish", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(completeRes.code, 0, completeRes.rawErr);
    assert.equal(completeRes.out.phase, "COMPLETE");

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 2: multi-component feature — score 3, two disjoint workers,
// successful review.
//
// WHAT WOULD BREAK THIS: dispatching fewer than two workers, letting one
// task's commit be dropped from the integration branch, or a review that
// does not actually require BOTH acceptance IDs to be covered.
// ============================================================================

describe("scenario 2: multi-component feature (score 3, two disjoint workers)", () => {
  test("two disjoint workers both land and a full-coverage review reaches VERIFYING", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const tasks = [
      { id: "t1", wave: 1, objective: "component a", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" },
      { id: "t2", wave: 1, objective: "component b", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [OK_VERIFY], effort: "high", risk: "low" },
    ];
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "component a works" }, { id: "AC-02", text: "component b works" }],
      approval_flags: [], final_verification: [FINAL_OK], tasks,
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(acceptRes.code, 0, acceptRes.rawErr);
    assert.equal(acceptRes.out.phase, "PLANNED");

    const recordPath = join(harness.root, "record.jsonl");
    const waveEnv = {
      ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath,
      FAKE_TASK_FILE_MAP: JSON.stringify({ t1: "a.txt", t2: "b.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ t1: ["AC-01"], t2: ["AC-02"] }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
    assert.equal(wave1Res.code, 0, wave1Res.rawErr);
    assert.equal(wave1Res.out.phase, "WAVE_1_COMPLETE");

    const workerCalls = readWorkerCalls(recordPath);
    assert.equal(workerCalls.length, 2, "both disjoint components must be dispatched");

    const log = git(integrationWorktree, ["log", "--format=%s", "--reverse", `${baseCommit}..HEAD`]).split("\n");
    assert.deepEqual(log, [`supervise(${runId}): t1`, `supervise(${runId}): t2`], "both task-id-ordered commits must be on the integration branch");
    assert.equal(readFileSync(join(integrationWorktree, "a.txt"), "utf8"), "changed-by-worker-t1\n");
    assert.equal(readFileSync(join(integrationWorktree, "b.txt"), "utf8"), "changed-by-worker-t2\n");

    // A review that covers only one of the two acceptance IDs is rejected —
    // proving "successful review" here really means BOTH criteria satisfied,
    // not merely "a review was accepted."
    const partialReviewPath = writeJson(harness.root, "partial-review", { acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "ok" }], summary: "partial" });
    const partialReviewRes = await call(["accept-review", "--run", runId, "--review-file", partialReviewPath], integrationWorktree, waveEnv);
    assert.equal(partialReviewRes.code, 2, "a review missing an acceptance ID must be rejected as a contract error");
    const statusAfterPartial = await call(["status", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(statusAfterPartial.out.phase, "WAVE_1_COMPLETE", "a rejected review must not mutate run state");

    const reviewPath = writeJson(harness.root, "review", {
      acceptance: [
        { id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "verified" },
        { id: "AC-02", status: "SATISFIED", evidence_paths: [], reason: "verified" },
      ],
      summary: "both components verified",
    });
    const reviewRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);
    assert.equal(reviewRes.code, 0, reviewRes.rawErr);
    assert.equal(reviewRes.out.phase, "VERIFYING");

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 3: security migration — score 5, approval pending, one max
// bottleneck.
//
// WHAT WOULD BREAK THIS: dispatching the worker before the pending approval
// is decided, running it at any effort other than "max", or the contract
// silently permitting a second "max" task in the same wave.
// ============================================================================

describe("scenario 3: security migration (score 5, approval pending, one max task)", () => {
  test("plan acceptance stops at APPROVAL_PENDING, and only after approval does the sole max-effort worker run", async () => {
    const harness = makeHarness({ "migration.sql": "-- base\n" });
    const { runId, integrationWorktree, complexityPath } = await initAndGrade(harness, {
      graderOutput: {
        score: 5, confidence: 0.7, dimensions: { scope: 5, uncertainty: 4, coupling: 4, risk: 5, verification: 4 },
        reasons: ["security-sensitive data migration"], risk_flags: ["destructive-schema-change"], unknowns: [],
        suggested_parallelism: 1, relevant_paths: ["migration.sql"], verification_hints: ["run migration dry-run"],
      },
    });
    assert.equal(JSON.parse(readFileSync(complexityPath, "utf8")).score, 5);

    const { relPath, baseCommit } = commitPlan(integrationWorktree);
    const nowIso = new Date().toISOString();
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 5, claude_score: 5, override_reason: null },
      acceptance: [{ id: "AC-01", text: "migration applies safely" }],
      approval_flags: [{
        id: "approval-01", category: "data-migration", description: "irreversible schema change",
        status: "PENDING", prompt: "ok to run the migration?", evidence_paths: [], created_at: nowIso, decided_at: null,
      }],
      final_verification: [FINAL_OK],
      tasks: [{
        id: "mig1", wave: 1, objective: "apply the migration", depends_on: [], read_paths: [],
        write_paths: ["migration.sql"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY],
        effort: "max", risk: "high",
      }],
    };

    // THE CEILING, DEMONSTRATED AT THE CONTRACT LEVEL: a second "max" task in
    // the same wave is rejected outright, so "one max bottleneck" is an
    // enforced property, not merely this scenario's incidental shape.
    const twoMaxGraph = {
      ...graph,
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }],
      tasks: [
        graph.tasks[0],
        { id: "mig2", wave: 1, objective: "apply a second migration", depends_on: [], read_paths: [], write_paths: ["other.sql"], acceptance_ids: ["AC-02"], verify: [OK_VERIFY], effort: "max", risk: "high" },
      ],
    };
    // Matches the error MESSAGE, not merely the class: with only a class
    // check this would have passed on ANY ContractError — including one
    // thrown by unrelated earlier validation over the graph shape — and so
    // would not actually have proven the max-effort ceiling fired.
    assert.throws(
      () => validateTaskGraph(twoMaxGraph, { runId, objectFormat: "sha1" }),
      { name: "ContractError", message: /at most one "max" task is permitted per wave/ },
    );

    const graphPath = writeJson(harness.root, "graph", graph);
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(acceptRes.code, 0, acceptRes.rawErr);
    assert.equal(acceptRes.out.phase, "APPROVAL_PENDING");

    // Before approval, wave 1 is unreachable — the CLI refuses to skip the
    // approval gate rather than merely being "unlikely" to be called early.
    const earlyWave = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, harness.baseEnv);
    assert.equal(earlyWave.code, 2, "run-wave before an approval decision must be refused");

    const evidencePath = writeJson(harness.root, "evidence", { note: "security review approved by human" });
    const decideRes = await call(["decide-approval", "--run", runId, "--id", "approval-01", "--decision", "approve", "--evidence-file", evidencePath], integrationWorktree, harness.baseEnv);
    assert.equal(decideRes.code, 0, decideRes.rawErr);
    assert.equal(decideRes.out.phase, "PLANNED");

    const recordPath = join(harness.root, "record.jsonl");
    const waveEnv = {
      ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath,
      FAKE_TASK_FILE_MAP: JSON.stringify({ mig1: "migration.sql" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ mig1: ["AC-01"] }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
    assert.equal(wave1Res.code, 0, wave1Res.rawErr);
    assert.equal(wave1Res.out.phase, "WAVE_1_COMPLETE");

    const workerCalls = readWorkerCalls(recordPath);
    assert.equal(workerCalls.length, 1);
    assert.ok(workerCalls[0].argv.includes("model_reasoning_effort=max"), "the sole bottleneck worker must run at effort max");

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 4: blocked worker — the wave publishes no commits and preserves
// all recovery evidence.
//
// WHAT WOULD BREAK THIS: integrating the successful sibling's commit onto the
// integration branch despite the failure, or discarding the successful
// worker's own private-branch commit/receipt instead of preserving it for
// recovery.
// ============================================================================

describe("scenario 4: blocked worker (wave publishes no commits, evidence preserved)", () => {
  test("one worker succeeding and one worker failing publishes nothing, while the successful commit survives for recovery", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const tasks = [
      { id: "t1", wave: 1, objective: "the part that works", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" },
      { id: "t2", wave: 1, objective: "the part that stalls", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [OK_VERIFY], effort: "high", risk: "low" },
    ];
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }],
      approval_flags: [], final_verification: [FINAL_OK], tasks,
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(acceptRes.code, 0, acceptRes.rawErr);

    const waveEnv = {
      ...harness.baseEnv,
      FAKE_TASK_FILE_MAP: JSON.stringify({ t1: "a.txt", t2: "b.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ t1: ["AC-01"], t2: ["AC-02"] }),
      // t2's worker never writes its file and reports NEEDS_CONTEXT — a
      // never-integrable model status (contracts.mjs's own worker-report
      // vocabulary), exercised here through a real spawned process rather
      // than a hand-built report object.
      FAKE_TASK_STATUS_MAP: JSON.stringify({ t2: "BLOCKED_NO_WRITE" }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
    assert.equal(wave1Res.code, 1, wave1Res.rawErr);
    assert.equal(wave1Res.out.phase, "BLOCKED");

    const evidence = JSON.parse(readFileSync(wave1Res.out.artifact, "utf8"));
    assert.equal(evidence.waveOutcome, "BLOCKED_BY_TASK_FAILURE");
    assert.deepEqual(evidence.failedTaskIds, ["t2"]);

    // THE WAVE PUBLISHES NOTHING: the integration branch is byte-for-byte
    // where it started.
    assert.equal(git(integrationWorktree, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(isWorktreeClean(integrationWorktree), true);

    // BUT t1's successful work is not destroyed: its private task branch
    // carries a real commit past baseCommit.
    const repoInfo = inspectRepository(harness.repo);
    const t1Branch = taskBranchName(runId, 1, "t1");
    const t1BranchHead = git(harness.repo, ["rev-parse", t1Branch]);
    assert.notEqual(t1BranchHead, baseCommit, "t1's worktree branch must carry its host-created commit even though the wave never published");
    assert.equal(git(harness.repo, ["log", "-1", "--format=%s", t1Branch]), `supervise(${runId}): t1`);

    // t2's branch exists (its worktree was created before the failure) but
    // never advanced, since no commit was ever created for it.
    const t2Branch = taskBranchName(runId, 1, "t2");
    assert.equal(git(harness.repo, ["rev-parse", t2Branch]), baseCommit);

    // ALL RECOVERY EVIDENCE IS PRESERVED: a receipt exists for BOTH tasks,
    // not only the failed one.
    const paths = getRunPaths(repoInfo, runId);
    const t1Receipt = JSON.parse(readFileSync(join(paths.receiptsDir, "wave-1-t1.json"), "utf8"));
    const t2Receipt = JSON.parse(readFileSync(join(paths.receiptsDir, "wave-1-t2.json"), "utf8"));
    assert.ok(t1Receipt.commit, "the successful task's receipt must record its commit");
    assert.equal(t2Receipt.commit, null, "the failed task never reached a host commit");

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 5: overlapping ownership — plan validation fails before dispatch.
//
// WHAT WOULD BREAK THIS: accepting a plan whose tasks claim overlapping
// write paths, or dispatching any worker before that check runs.
// ============================================================================

describe("scenario 5: overlapping ownership (plan validation fails before dispatch)", () => {
  test("a plan with overlapping write ownership is rejected at accept-plan and no worker is ever created", async () => {
    const harness = makeHarness({ "src/a.txt": "base\n" });
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }],
      approval_flags: [], final_verification: [FINAL_OK],
      tasks: [
        { id: "t1", wave: 1, objective: "own the src directory", depends_on: [], read_paths: [], write_paths: ["src/"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" },
        // "src/a.txt" is a strict child of "src/" — overlapping ownership.
        { id: "t2", wave: 1, objective: "also touch a file inside src", depends_on: [], read_paths: [], write_paths: ["src/a.txt"], acceptance_ids: ["AC-02"], verify: [OK_VERIFY], effort: "high", risk: "low" },
      ],
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    const recordPath = join(harness.root, "record.jsonl");
    const acceptEnv = { ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath };
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, acceptEnv);
    assert.equal(acceptRes.code, 2, "overlapping write ownership must be a contract-layer refusal (exit 2)");

    const statusRes = await call(["status", "--run", runId], integrationWorktree, harness.baseEnv);
    assert.equal(statusRes.out.phase, "GRADED", "a rejected plan must never advance the run past GRADED");
    assert.equal(existsSync(recordPath), false, "no worker may ever be dispatched when plan validation fails before dispatch");

    const repoInfo = inspectRepository(harness.repo);
    const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);
    assert.equal(existsSync(worktreePaths.waveWorktreePath(1, "t1")), false, "no task worktree may exist for a plan that never passed validation");
    assert.equal(existsSync(worktreePaths.waveWorktreePath(1, "t2")), false);

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 6: wave one fully satisfies the ask — review runs and dispatches
// no correction.
//
// WHAT WOULD BREAK THIS: a no-gap review that still allows (or itself
// triggers) a wave-two dispatch.
// ============================================================================

describe("scenario 6: wave one fully satisfies the ask (no correction dispatched)", () => {
  test("a fully-satisfied review reaches VERIFYING directly, and wave two is structurally unreachable from there", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 2, claude_score: 2, override_reason: null },
      acceptance: [{ id: "AC-01", text: "the ask is satisfied" }],
      approval_flags: [], final_verification: [FINAL_OK],
      tasks: [{ id: "t1", wave: 1, objective: "do the whole thing", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" }],
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);

    const recordPath = join(harness.root, "record.jsonl");
    const waveEnv = {
      ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath,
      FAKE_TASK_FILE_MAP: JSON.stringify({ t1: "a.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ t1: ["AC-01"] }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
    assert.equal(wave1Res.code, 0, wave1Res.rawErr);

    const reviewPath = writeJson(harness.root, "review", { acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "fully satisfied" }], summary: "nothing left to fix" });
    const reviewRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);
    assert.equal(reviewRes.code, 0, reviewRes.rawErr);
    assert.equal(reviewRes.out.phase, "VERIFYING");
    // The CLI's own recommendation never points back at a correction wave.
    assert.equal(reviewRes.out.next, "verify");

    const workerCallsBeforeAttempt = readWorkerCalls(recordPath).length;
    assert.equal(workerCallsBeforeAttempt, 1, "only the single wave-one worker may have run so far");

    // Attempting wave two anyway is refused at the phase-machine layer
    // (REVIEWED is required; the run is in VERIFYING) — no correction is
    // dispatched, and the refusal itself mutates nothing.
    const wave2Attempt = await call(["run-wave", "--run", runId, "--wave", "2"], integrationWorktree, waveEnv);
    assert.equal(wave2Attempt.code, 2);
    const statusAfterAttempt = await call(["status", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(statusAfterAttempt.out.phase, "VERIFYING", "a refused wave-two attempt must not move the run");
    assert.equal(readWorkerCalls(recordPath).length, workerCallsBeforeAttempt, "a refused wave-two attempt must never spawn a worker");

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 7: worker claims success with failed tests — host receipt
// rejects success.
//
// WHAT WOULD BREAK THIS: trusting the worker's self-reported DONE/PASS
// verification claim instead of the host's own execution of the declared
// verify command, or creating a commit despite that host failure.
// ============================================================================

describe("scenario 7: worker claims success with failed tests (host receipt rejects it)", () => {
  test("a worker's DONE report cannot override a failing host-run verification command", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    // The task's OWN declared verification command always fails, independent
    // of anything the worker itself claims — the fake worker below still
    // reports DONE with this exact id marked PASS.
    const failingVerify = { id: "unit-tests", argv: ["node", "-e", "process.exit(1)"], cwd: ".", requires_approval_ids: [] };
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 2, claude_score: 2, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }],
      approval_flags: [], final_verification: [FINAL_OK],
      tasks: [{ id: "t1", wave: 1, objective: "claims success", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [failingVerify], effort: "high", risk: "low" }],
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);

    const waveEnv = {
      ...harness.baseEnv,
      FAKE_TASK_FILE_MAP: JSON.stringify({ t1: "a.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ t1: ["AC-01"] }),
      // The fake worker self-reports the SAME verify id ("unit-tests" is
      // resolved through FAKE_TASK_VERIFY_ID_MAP) as PASS — an explicit
      // false claim of success.
      FAKE_TASK_VERIFY_ID_MAP: JSON.stringify({ t1: ["unit-tests"] }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
    assert.equal(wave1Res.code, 1, wave1Res.rawErr);
    assert.equal(wave1Res.out.phase, "BLOCKED", "the host-run verification failure must block the run despite the worker's self-reported success");

    const evidence = JSON.parse(readFileSync(wave1Res.out.artifact, "utf8"));
    assert.equal(evidence.waveOutcome, "BLOCKED_BY_TASK_FAILURE");
    assert.deepEqual(evidence.failedTaskIds, ["t1"]);

    // THE RECEIPT ITSELF PROVES THE HOST, NOT THE MODEL, DECIDED: the
    // host-run "unit-tests" command is recorded as FAIL, and no commit was
    // ever created — the model's claimed PASS never reaches the receipt's
    // authoritative host_verification field at all.
    const repoInfo = inspectRepository(harness.repo);
    const paths = getRunPaths(repoInfo, runId);
    const receipt = JSON.parse(readFileSync(join(paths.receiptsDir, "wave-1-t1.json"), "utf8"));
    assert.equal(receipt.commit, null, "a task that fails host verification must never reach a host commit");
    assert.equal(receipt.commit_source, null);
    const hostCheck = receipt.host_verification.find((v) => v.id === "unit-tests");
    assert.ok(hostCheck, "the receipt must record the host's own run of the declared verify command");
    assert.equal(hostCheck.status, "FAIL", "the host's actual exit code, not the worker's claim, is what the receipt records");

    // The task's own branch never advanced past baseCommit either.
    assert.equal(git(harness.repo, ["rev-parse", taskBranchName(runId, 1, "t1")]), baseCommit);

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 8: same-wave dependency is rejected and coupled work must be one
// task.
//
// WHAT WOULD BREAK THIS: accepting a plan where one wave-one task
// depends_on another wave-one task, or dispatching any worker before that
// check runs.
// ============================================================================

describe("scenario 8: same-wave dependency rejected (coupled work must be one task)", () => {
  test("a wave-one task with a same-wave depends_on is rejected at accept-plan, before any dispatch", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }],
      approval_flags: [], final_verification: [FINAL_OK],
      tasks: [
        { id: "t1", wave: 1, objective: "the base change", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" },
        // A same-wave dependency: every task in a wave starts from the same
        // base commit, so this is unsound by construction and must be
        // rejected — the coupled work belongs in ONE task, not two.
        { id: "t2", wave: 1, objective: "depends on t1's change", depends_on: ["t1"], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [OK_VERIFY], effort: "high", risk: "low" },
      ],
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    const recordPath = join(harness.root, "record.jsonl");
    const acceptEnv = { ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath };
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, acceptEnv);
    assert.equal(acceptRes.code, 2, "a same-wave dependency must be a contract-layer refusal (exit 2)");
    assert.match(acceptRes.rawErr, /depends_on/);

    const statusRes = await call(["status", "--run", runId], integrationWorktree, harness.baseEnv);
    assert.equal(statusRes.out.phase, "GRADED", "a rejected plan must never advance the run past GRADED");
    assert.equal(existsSync(recordPath), false, "no worker may ever be dispatched for a plan that fails the dependency-hygiene check");

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 9: the second candidate cherry-pick conflicts and the integration
// HEAD is unchanged.
//
// This is the SECOND, structurally distinct all-or-nothing path
// (BLOCKED_BY_CANDIDATE_CONFLICT), kept separate from scenario 4's worker
// failure (BLOCKED_BY_TASK_FAILURE): here EVERY task succeeds, but their
// commits cannot be composed onto the current integration HEAD.
//
// Constructed via a genuine, CLI-reachable drift: wave one publishes a
// change to a.txt; before wave two runs, the integration branch drifts again
// (an out-of-band commit lands directly on it, exactly the kind of event
// `recover`'s `allowBaseDrift` computation exists to tolerate); the crashed
// run is then recovered, and wave two's two correction workers are
// dispatched — via the real CLI and a real spawned fake-codex process —
// against the wave's recorded (now-stale) base while the candidate is built
// from the ACTUAL current HEAD. The alphabetically-first task ("c-task",
// disjoint file) integrates cleanly; the second ("z-task", same file as the
// drift) conflicts.
//
// WHAT WOULD BREAK THIS: silently ignoring the base drift (accepting an
// unsafe fast-forward that discards the drifted commit), integrating the
// first candidate's commit despite the sibling's later conflict, or moving
// the real integration ref during an aborted candidate integration.
// ============================================================================

describe("scenario 9: second candidate cherry-pick conflicts (integration HEAD unchanged)", () => {
  test("every wave-two task succeeds, but a drifted base makes the second cherry-pick conflict and nothing integrates", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "c.txt": "base-c\n" });
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    // Wave one: a single task legitimately publishes a change to a.txt.
    const wave1Graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "a.txt is updated" }],
      approval_flags: [], final_verification: [FINAL_OK],
      tasks: [{ id: "seed", wave: 1, objective: "update a.txt", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" }],
    };
    const wave1GraphPath = writeJson(harness.root, "graph1", wave1Graph);
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", wave1GraphPath], integrationWorktree, harness.baseEnv);
    const wave1Env = {
      ...harness.baseEnv,
      FAKE_TASK_FILE_MAP: JSON.stringify({ seed: "a.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ seed: ["AC-01"] }),
    };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, wave1Env);
    assert.equal(wave1Res.code, 0, wave1Res.rawErr);
    const wave1Head = git(integrationWorktree, ["rev-parse", "HEAD"]);
    assert.equal(readFileSync(join(integrationWorktree, "a.txt"), "utf8"), "changed-by-worker-seed\n");

    // Review reports a gap on AC-01, requiring a correction wave.
    const reviewPath = writeJson(harness.root, "review", { acceptance: [{ id: "AC-01", status: "GAP", evidence_paths: [], reason: "needs another pass" }], summary: "one gap" });
    const correctionGraph = {
      version: 1, run_id: runId, wave: 2, base_commit: wave1Head, source_review: "review.json",
      tasks: [
        { id: "c-task", objective: "unrelated correction", depends_on: [], read_paths: [], write_paths: ["c.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low", source_task_id: null, session_policy: "fresh" },
        { id: "z-task", objective: "re-touch a.txt", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low", source_task_id: "seed", session_policy: "fresh" },
      ],
    };
    const correctionGraphPath = writeJson(harness.root, "correction-graph", correctionGraph);
    const acceptGapRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath, "--correction-graph-file", correctionGraphPath], integrationWorktree, wave1Env);
    assert.equal(acceptGapRes.code, 0, acceptGapRes.rawErr);
    assert.equal(acceptGapRes.out.phase, "REVIEWED");

    // THE DRIFT: an out-of-band commit lands directly on the integration
    // branch after wave one but before wave two ever runs — the real event
    // `recover`'s dynamically-computed allowBaseDrift exists to tolerate.
    writeFileSync(join(integrationWorktree, "a.txt"), "drifted-out-of-band\n");
    git(integrationWorktree, ["add", "-A"]);
    git(integrationWorktree, ["commit", "-qm", "out-of-band drift on a.txt"]);
    const driftedHead = git(integrationWorktree, ["rev-parse", "HEAD"]);
    assert.notEqual(driftedHead, wave1Head);

    // Simulate a crash the instant wave two started (before any worker ran)
    // — the same "force the phase, never call run-wave" technique the
    // existing crash-recovery unit test uses.
    const repoInfo = inspectRepository(harness.repo);
    await updateRun(repoInfo, runId, { type: "RUN_WAVE_2", operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "wave-2" } });
    assert.equal(loadRun(repoInfo, runId).phase, Phase.WAVE_2_RUNNING);

    const wave2Env = {
      ...harness.baseEnv,
      FAKE_TASK_FILE_MAP: JSON.stringify({ "c-task": "c.txt", "z-task": "a.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ "c-task": ["AC-01"], "z-task": ["AC-01"] }),
    };
    const recoverRes = await call(["recover", "--run", runId], integrationWorktree, wave2Env);
    assert.equal(recoverRes.code, 1, recoverRes.rawErr);
    assert.equal(recoverRes.out.phase, "BLOCKED");

    const evidence = JSON.parse(readFileSync(recoverRes.out.artifact, "utf8"));
    assert.equal(evidence.waveOutcome, "BLOCKED_BY_CANDIDATE_CONFLICT");
    assert.equal(evidence.conflict.taskId, "z-task");
    assert.deepEqual(evidence.failedTaskIds, [], "BLOCKED_BY_CANDIDATE_CONFLICT is a distinct vocabulary from BLOCKED_BY_TASK_FAILURE — every task here actually succeeded");

    // THE PROOF: the real integration HEAD is exactly where the drift left
    // it — nothing published, nothing partially merged.
    assert.equal(git(integrationWorktree, ["rev-parse", "HEAD"]), driftedHead);
    assert.equal(isWorktreeClean(integrationWorktree), true);

    // Both workers' commits still exist on their own private branches —
    // successful work is withheld, never destroyed.
    const paths = getRunPaths(repoInfo, runId);
    const cReceipt = JSON.parse(readFileSync(join(paths.receiptsDir, "wave-2-c-task.json"), "utf8"));
    const zReceipt = JSON.parse(readFileSync(join(paths.receiptsDir, "wave-2-z-task.json"), "utf8"));
    assert.ok(cReceipt.commit, "c-task's host commit must survive even though nothing integrated");
    assert.ok(zReceipt.commit, "z-task's host commit must survive even though it conflicted");
    assert.equal(git(harness.repo, ["cat-file", "-t", cReceipt.commit]), "commit");
    assert.equal(git(harness.repo, ["cat-file", "-t", zReceipt.commit]), "commit");
    assert.equal(git(harness.repo, ["rev-parse", taskBranchName(runId, 2, "c-task")]), cReceipt.commit);
    assert.equal(git(harness.repo, ["rev-parse", taskBranchName(runId, 2, "z-task")]), zReceipt.commit);

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 10: interrupted execution recovers completed receipts and blocks
// ambiguous dirty work.
//
// A single recover call must do BOTH things at once: silently re-integrate a
// task whose commit and receipt already exist from before the crash (no
// worker re-run), and refuse to guess at a SIBLING task's dirty,
// uncommitted worktree that has no receipt at all.
//
// WHAT WOULD BREAK THIS: re-running the already-completed task's worker a
// second time, or silently discarding (or silently trusting) the dirty
// sibling's uncommitted content instead of blocking on it.
// ============================================================================

describe("scenario 10: interrupted execution (recovers receipts, blocks ambiguous dirty work)", () => {
  test("recover re-integrates a completed receipt without rerunning it, and blocks on a sibling's ambiguous uncommitted worktree", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const tasks = [
      { id: "a-task", wave: 1, objective: "completed before the crash", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" },
      { id: "b-task", wave: 1, objective: "left dirty by the crash", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [OK_VERIFY], effort: "high", risk: "low" },
    ];
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }],
      approval_flags: [], final_verification: [FINAL_OK], tasks,
    };
    const graphPath = writeJson(harness.root, "graph", graph);
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);

    // --- Manually reproduce exactly what a crashed-mid-wave attempt leaves
    // behind, using git.mjs's own real primitives — never the CLI, never a
    // Codex spawn. ---
    const repoInfo = inspectRepository(harness.repo);
    const paths = getRunPaths(repoInfo, runId);
    const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);

    // a-task: a genuinely completed, host-verified, receipted commit — the
    // crash happened AFTER this task finished.
    const aTask = tasks[0];
    const aWt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave: 1, taskId: aTask.id, baseCommit });
    writeFileSync(join(aWt.path, "a.txt"), "changed-by-worker-a-task\n");
    const aChanges = inspectTaskChanges({ worktreePath: aWt.path, baseCommit, writePaths: aTask.write_paths });
    assert.ok(aChanges.ok, `inspectTaskChanges failed for a-task: ${aChanges.reason}`);
    const aCommitInfo = createTaskCommit({ repoInfo, worktreePath: aWt.path, baseCommit, writePaths: aTask.write_paths, runId, taskId: aTask.id, expectedFingerprint: aChanges.fingerprint });
    assert.ok(inspectTaskCommit({ worktreePath: aWt.path, baseCommit, commit: aCommitInfo.commit }).ok);
    const aOwnership = assertCommitOwnership({ worktreePath: aWt.path, baseCommit, commit: aCommitInfo.commit, writePaths: aTask.write_paths, expectedFingerprint: aChanges.fingerprint });
    const aReceipt = buildTaskReceipt({
      taskId: aTask.id,
      workerOutcome: { threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, processExitCode: 0 },
      commit: aCommitInfo.commit, changedFiles: aOwnership.files, ownershipValid: true,
      hostVerification: [{ id: "ok", status: "PASS", exitCode: 0, logPath: null }],
      report: { status: "DONE", summary: "done", acceptance: [{ id: "AC-01", status: "PASS", evidence: "e2e" }], verification: [{ id: "ok", status: "PASS", summary: "ok" }], concerns: [], blockers: [] },
    });
    mkdirSync(paths.receiptsDir, { recursive: true });
    writeFileSync(join(paths.receiptsDir, "wave-1-a-task.json"), JSON.stringify(aReceipt, null, 2));

    // b-task: a worker started (its worktree exists, checked out at
    // baseCommit) and left UNCOMMITTED changes when the process crashed —
    // no receipt exists for it at all.
    const bWt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave: 1, taskId: "b-task", baseCommit });
    writeFileSync(join(bWt.path, "b.txt"), "half-written-by-crashed-worker\n");
    assert.equal(isWorktreeClean(bWt.path), false, "the dirty worktree fixture must actually be dirty");

    // Force run.json into WAVE_1_RUNNING with a definitely-dead pid, exactly
    // like the crash this scenario models — never via run-wave.
    await updateRun(repoInfo, runId, { type: "RUN_WAVE_1", operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "wave-1" } });
    assert.equal(loadRun(repoInfo, runId).phase, Phase.WAVE_1_RUNNING);

    // A record file proves no worker is EVER spawned during this recovery.
    const recordPath = join(harness.root, "record.jsonl");
    const recoverEnv = { ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath };
    const recoverRes = await call(["recover", "--run", runId], integrationWorktree, recoverEnv);
    assert.equal(recoverRes.code, 1, recoverRes.rawErr);
    assert.equal(recoverRes.out.phase, "BLOCKED");
    assert.equal(readWorkerCalls(recordPath).length, 0, "recovering a completed receipt or blocking on ambiguous dirty work must never spawn a codex worker");

    const evidence = JSON.parse(readFileSync(recoverRes.out.artifact, "utf8"));
    assert.equal(evidence.reason, "ambiguous-dirty-task-worktrees");
    assert.equal(evidence.ambiguous.length, 1);
    assert.equal(evidence.ambiguous[0].taskId, "b-task");
    assert.equal(evidence.ambiguous[0].reason, "uncommitted changes with no verified receipt");

    // a-task's ALREADY-COMPLETED commit was re-integrated onto the real
    // integration branch as part of this same recover call.
    const integrationHead = git(integrationWorktree, ["rev-parse", "HEAD"]);
    assert.notEqual(integrationHead, baseCommit, "a-task's completed receipt must have been integrated during recovery");
    assert.ok(
      git(integrationWorktree, ["log", "--format=%H", "--grep", `cherry picked from commit ${aCommitInfo.commit}`, integrationHead]).length > 0,
      "a-task's commit must be integrated via cherry-pick, not re-run",
    );

    // b-task's dirty worktree is untouched — neither silently committed nor
    // discarded.
    assert.equal(existsSync(bWt.path), true);
    assert.equal(readFileSync(join(bWt.path, "b.txt"), "utf8"), "half-written-by-crashed-worker\n");
    assert.equal(isWorktreeClean(bWt.path), false);

    assertOriginalRepoUntouched(harness);
  });
});

// ============================================================================
// Scenario 11: wave-two review leaves one criterion blocked and no third
// wave is representable.
//
// Demonstrated structurally, not merely asserted as a rejection message: the
// Phase enum itself has no WAVE_3 member, a correction graph's `wave` field
// is hardcoded to reject anything but exactly 2 at the DATA level, and
// `correctionWaveUsed` makes a second correction wave for this run
// impossible even after recovering out of BLOCKED.
//
// WHAT WOULD BREAK THIS: adding any transition that reaches a wave-two
// dispatch a second time for the same run, or accepting a correction graph
// whose `wave` is not exactly 2.
// ============================================================================

describe("scenario 11: wave-two review leaves a criterion blocked (no third wave representable)", () => {
  test("a BLOCKED post-correction criterion blocks the run, and a third wave is unrepresentable at both the CLI and the data layer", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree } = await initAndGrade(harness);
    const { relPath, baseCommit } = commitPlan(integrationWorktree);

    const wave1Graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "the fix holds" }],
      approval_flags: [], final_verification: [FINAL_OK],
      tasks: [{ id: "w1t", wave: 1, objective: "first attempt", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low" }],
    };
    const wave1GraphPath = writeJson(harness.root, "graph1", wave1Graph);
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, relPath), "--graph-file", wave1GraphPath], integrationWorktree, harness.baseEnv);
    const wave1Env = { ...harness.baseEnv, FAKE_TASK_FILE_MAP: JSON.stringify({ w1t: "a.txt" }), FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ w1t: ["AC-01"] }) };
    const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, wave1Env);
    assert.equal(wave1Res.code, 0, wave1Res.rawErr);
    const wave1Head = git(integrationWorktree, ["rev-parse", "HEAD"]);

    const reviewPath = writeJson(harness.root, "review", { acceptance: [{ id: "AC-01", status: "GAP", evidence_paths: [], reason: "still broken" }], summary: "one gap" });
    const correctionGraph = {
      version: 1, run_id: runId, wave: 2, base_commit: wave1Head, source_review: "review.json",
      tasks: [{ id: "w2t", objective: "second attempt", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [OK_VERIFY], effort: "high", risk: "low", source_task_id: "w1t", session_policy: "fresh" }],
    };
    const correctionGraphPath = writeJson(harness.root, "correction-graph", correctionGraph);
    const acceptGapRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath, "--correction-graph-file", correctionGraphPath], integrationWorktree, wave1Env);
    assert.equal(acceptGapRes.code, 0, acceptGapRes.rawErr);

    const wave2Env = { ...harness.baseEnv, FAKE_TASK_FILE_MAP: JSON.stringify({ w2t: "a.txt" }), FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ w2t: ["AC-01"] }) };
    const wave2Res = await call(["run-wave", "--run", runId, "--wave", "2"], integrationWorktree, wave2Env);
    assert.equal(wave2Res.code, 0, wave2Res.rawErr);
    assert.equal(wave2Res.out.phase, "WAVE_2_COMPLETE");

    // The post-correction review still reports the criterion BLOCKED — never
    // a third wave, the run blocks instead.
    const finalReviewPath = writeJson(harness.root, "final-review", { acceptance: [{ id: "AC-01", status: "BLOCKED", evidence_paths: [], reason: "correction did not resolve it" }], summary: "still failing after the one permitted correction" });
    const afrRes = await call(["accept-final-review", "--run", runId, "--review-file", finalReviewPath], integrationWorktree, wave2Env);
    assert.equal(afrRes.code, 1, afrRes.rawErr);
    assert.equal(afrRes.out.phase, "BLOCKED");

    const repoInfo = inspectRepository(harness.repo);
    const run = loadRun(repoInfo, runId);
    assert.equal(run.blockedFrom, "WAVE_2_COMPLETE");
    assert.equal(run.correctionWaveUsed, true);

    // --- STRUCTURAL DEMONSTRATIONS (not merely a CLI rejection message) ---

    // (a) The Phase enum is EXHAUSTIVELY pinned to its exact 16 members.
    //
    // This deliberately replaces an earlier `/3/`-substring filter, which was
    // a proxy rather than the property: it caught a hypothetical `WAVE_3_*`
    // but would have sailed past `WAVE_THREE_RUNNING` or `SECOND_CORRECTION`
    // — i.e. it only rejected one SPELLING of a third wave, not the addition
    // of one. Pinning the complete set means ANY new phase, however named,
    // fails here and forces a deliberate re-review of this scenario.
    assert.deepEqual(Object.values(Phase).sort(), [
      "APPROVAL_PENDING", "BLOCKED", "COMPLETE", "CORRECTIONS_REVIEWED",
      "FINISH_ACTION_PENDING", "FINISH_PENDING", "GRADED", "GRADING",
      "INITIALIZED", "PLANNED", "REVIEWED", "VERIFYING",
      "WAVE_1_COMPLETE", "WAVE_1_RUNNING", "WAVE_2_COMPLETE", "WAVE_2_RUNNING",
    ].sort(), "the Phase enum's exact membership is pinned — adding ANY phase (a third wave under any spelling, or any other state) must fail this scenario deliberately");

    // (b) A correction graph literally cannot declare a third wave — the
    // data-level contract rejects anything but wave: 2, independent of any
    // CLI orchestration. The second argument matches the error MESSAGE (not
    // just the class), so this cannot start passing for an unrelated
    // ContractError thrown earlier in validation.
    const thirdWaveGraph = { ...correctionGraph, wave: 3 };
    assert.throws(
      () => validateCorrectionGraph(thirdWaveGraph, { runId, objectFormat: "sha1", expectedBaseCommit: wave1Head, waveOneTasksById: { w1t: wave1Graph.tasks[0] }, acceptanceIds: ["AC-01"], nonSatisfiedAcceptanceIds: ["AC-01"], claudeScore: 3, approvalFlags: [] }),
      { name: "ContractError", message: /correction graph\.wave must be exactly 2/ },
    );

    // (c) Recovering out of BLOCKED returns to WAVE_2_COMPLETE — never back
    // to REVIEWED, so RUN_WAVE_2 (the one and only edge that can ever
    // produce WAVE_2_RUNNING) is unreachable a second time for this run.
    const changedPath = writeJson(harness.root, "changed-condition", { note: "operator acknowledged the residual gap" });
    const recoverRes = await call(["recover", "--run", runId, "--changed-condition-file", changedPath], integrationWorktree, wave2Env);
    assert.equal(recoverRes.code, 0, recoverRes.rawErr);
    assert.equal(recoverRes.out.phase, "WAVE_2_COMPLETE");

    // (d) From WAVE_2_COMPLETE, a second wave-two attempt is refused at the
    // phase-machine layer (REVIEWED is required) and mutates nothing.
    const secondWave2Attempt = await call(["run-wave", "--run", runId, "--wave", "2"], integrationWorktree, wave2Env);
    assert.equal(secondWave2Attempt.code, 2);
    const statusAfter = await call(["status", "--run", runId], integrationWorktree, wave2Env);
    assert.equal(statusAfter.out.phase, "WAVE_2_COMPLETE", "a refused second wave-two attempt must not move the run");

    assertOriginalRepoUntouched(harness);
  });
});
