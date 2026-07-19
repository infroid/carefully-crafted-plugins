// Unit tests for plugins/contexthub/scripts/supervise.mjs
// Run with: node --test tests/unit/supervise-cli.test.mjs
//
// Drives main() with fake IO and a fake `codex` executable (pointed at via
// io.env.CODEX_BIN, exactly the injection point codex.mjs's own tests use)
// against REAL temporary git repositories — no mocks of git itself. This
// proves the CLI wires the frozen supervise/*.mjs modules together
// correctly end to end, including both complete flow variants, the
// carry-forwards, and the state machine's phase-skip/third-wave guards.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync,
  symlinkSync, realpathSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../plugins/contexthub/scripts/supervise.mjs";
import { Phase, getRunPaths, updateRun, loadRun } from "../../plugins/contexthub/scripts/supervise/state.mjs";
import {
  inspectRepository, ensurePrivateWorktreeRoot, createTaskWorktree, inspectTaskChanges,
  createTaskCommit, inspectTaskCommit, assertCommitOwnership, isWorktreeClean,
} from "../../plugins/contexthub/scripts/supervise/git.mjs";
import { buildTaskReceipt } from "../../plugins/contexthub/scripts/supervise/scheduler.mjs";

// --------------------------------------------------------------------------
// TIMING POLICY — every call here spawns a real Node child process (the fake
// codex binary). None of these tests assert a wall-clock bound; every fake
// codex invocation exits promptly on its own (no sleeps), so there is no
// timing dependency to violate. See supervise-codex.test.mjs:56 for the
// class of flake this repo avoids.
// --------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// --------------------------------------------------------------------------
// Fake codex executable — a generic, env-driven interpreter (same idea as
// supervise-codex.test.mjs's FAKE_CODEX_SCRIPT, adapted for multi-task
// waves): FAKE_TASK_FILE_MAP / FAKE_TASK_ACCEPTANCE_MAP key a task's write
// path and satisfied acceptance ids off the worktree directory name (which
// always ends in the task id, per git.mjs's waveWorktreePath), so several
// tasks running concurrently in one wave each get correct, distinct output
// without any other coordination.
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
  if (status !== "BLOCKED_NO_WRITE") {
    writeFileSync(targetDir + "/" + writeFile, "changed-by-worker-" + taskId + "\\n");
  }
  if (status === "DONE" || status === "BLOCKED_NO_WRITE") {
    writeFileSync(outPath, JSON.stringify({
      status: status === "BLOCKED_NO_WRITE" ? "NEEDS_CONTEXT" : "DONE",
      summary: "did the thing",
      acceptance: status === "BLOCKED_NO_WRITE" ? [] : ids.map((id) => ({ id, status: "PASS", evidence: "e2e" })),
      verification: status === "BLOCKED_NO_WRITE" ? [] : [{ id: "ok", status: "PASS", summary: "ok" }],
      concerns: [], blockers: status === "BLOCKED_NO_WRITE" ? ["could not proceed"] : [],
    }));
  }
  process.exit(0);
} else {
  process.stderr.write("fake-codex: unrecognized invocation: " + JSON.stringify(argv) + "\\n");
  process.exit(2);
}
`;

function makeRepo(extraFiles = { "a.txt": "base-a\n" }) {
  const root = mkdtempSync(join(tmpdir(), "sup-cli-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(repo, name), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  return { root, repo };
}

function makeHarness(extraFiles) {
  const { root, repo } = makeRepo(extraFiles);
  const superpowersDir = join(root, "superpowers");
  for (const skill of ["test-driven-development", "systematic-debugging", "verification-before-completion", "receiving-code-review"]) {
    mkdirSync(join(superpowersDir, "skills", skill), { recursive: true });
  }
  const fakeCodexPath = join(root, "codex-fake.mjs");
  writeFileSync(fakeCodexPath, FAKE_CODEX);
  chmodSync(fakeCodexPath, 0o755);
  const baseEnv = { ...process.env, CODEX_BIN: fakeCodexPath, FAKE_SUPERPOWERS_PATH: superpowersDir };
  return { root, repo, baseEnv };
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
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A full init -> grade -> accept-plan -> run-wave 1 bootstrap, shared by many
// tests. Returns everything a caller needs to keep driving the flow.
async function bootstrapThroughWave1(harness, { tasks } = {}) {
  const { root, repo, baseEnv } = harness;
  const requestPath = join(root, "request.md");
  writeFileSync(requestPath, "Implement a widget.\n");
  const initRes = await call(["init", "--request-file", requestPath], repo, baseEnv);
  assert.equal(initRes.code, 0, initRes.rawErr);
  const runId = initRes.out.run_id;
  const integrationWorktree = initRes.out.integration_worktree;

  const gradeRes = await call(["grade", "--run", runId], repo, baseEnv);
  assert.equal(gradeRes.code, 0, gradeRes.rawErr);

  const planRelPath = "docs/superpowers/plans/2026-plan.md";
  mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
  writeFileSync(join(integrationWorktree, planRelPath), "# Plan\n");
  git(integrationWorktree, ["add", "-A"]);
  git(integrationWorktree, ["commit", "-qm", "plan"]);
  const baseCommit = git(integrationWorktree, ["rev-parse", "HEAD"]);

  const taskList = tasks ?? [{
    id: "t1", wave: 1, objective: "widget a", depends_on: [], read_paths: [],
    write_paths: ["a.txt"], acceptance_ids: ["AC-01"],
    verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
    effort: "high", risk: "low",
  }];
  const acceptanceIds = [...new Set(taskList.flatMap((t) => t.acceptance_ids))];
  const graph = {
    version: 1, run_id: runId, base_commit: baseCommit,
    complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
    acceptance: acceptanceIds.map((id) => ({ id, text: `criterion ${id}` })),
    approval_flags: [],
    final_verification: [{ id: "final-ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
    tasks: taskList,
  };
  const graphPath = writeJson(root, "graph.json", graph);
  const acceptPlanRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath), "--graph-file", graphPath], integrationWorktree, baseEnv);
  assert.equal(acceptPlanRes.code, 0, acceptPlanRes.rawErr);

  const fileMap = {};
  const acceptanceMap = {};
  for (const t of taskList) {
    fileMap[t.id] = t.write_paths[0];
    acceptanceMap[t.id] = t.acceptance_ids;
  }
  const waveEnv = { ...baseEnv, FAKE_TASK_FILE_MAP: JSON.stringify(fileMap), FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify(acceptanceMap) };
  const wave1Res = await call(["run-wave", "--run", runId, "--wave", "1"], integrationWorktree, waveEnv);
  assert.equal(wave1Res.code, 0, wave1Res.rawErr);

  return { root, repo, runId, integrationWorktree, baseEnv, waveEnv, graph, wave1Res, acceptPlanRes };
}

// --------------------------------------------------------------------------
// Full flow 1: no-gap
// --------------------------------------------------------------------------

describe("complete flow: no gaps", () => {
  test("init -> grade -> accept-plan -> run-wave 1 -> accept-review(no gaps) -> verify -> choose-finish(keep) -> complete-finish -> COMPLETE", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);

    const reviewPath = writeJson(harness.root, "review.json", {
      acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "verified" }],
      summary: "all good",
    });
    const reviewRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);
    assert.equal(reviewRes.code, 0, reviewRes.rawErr);
    assert.equal(reviewRes.out.phase, "VERIFYING");

    const verifyRes = await call(["verify", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(verifyRes.code, 0, verifyRes.rawErr);
    assert.equal(verifyRes.out.phase, "FINISH_PENDING");

    const decisionPath = writeJson(harness.root, "decision.json", { target: null });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "keep", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);
    assert.equal(chooseRes.out.phase, "FINISH_ACTION_PENDING");

    const completeRes = await call(["complete-finish", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(completeRes.code, 0, completeRes.rawErr);
    assert.equal(completeRes.out.phase, "COMPLETE");
  });
});

// --------------------------------------------------------------------------
// Full flow 2: gap -> one correction wave -> never a third
// --------------------------------------------------------------------------

describe("complete flow: gap then one correction wave", () => {
  test("accept-review(gaps) -> run-wave 2 -> accept-final-review(satisfied) -> verify -> choose-finish(keep) -> complete-finish -> COMPLETE, and a third wave is refused", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const tasks = [
      { id: "t1", wave: 1, objective: "widget a", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
      { id: "t2", wave: 1, objective: "widget b", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
    ];
    const { root, runId, integrationWorktree, baseEnv } = await bootstrapThroughWave1(harness, { tasks });

    const reviewPath = writeJson(root, "review.json", {
      acceptance: [
        { id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "verified" },
        { id: "AC-02", status: "GAP", evidence_paths: [], reason: "missing edge case" },
      ],
      summary: "one gap",
    });

    // Missing --correction-graph-file is rejected (exit 2) and does NOT
    // mutate run state.
    const missingCg = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, baseEnv);
    assert.equal(missingCg.code, 2);
    const statusAfterMissing = await call(["status", "--run", runId], integrationWorktree, baseEnv);
    assert.equal(statusAfterMissing.out.phase, "WAVE_1_COMPLETE");

    const wave1IntegrationHead = git(integrationWorktree, ["rev-parse", "HEAD"]);
    const correctionGraphPath = writeJson(root, "correction-graph.json", {
      version: 1, run_id: runId, wave: 2, base_commit: wave1IntegrationHead, source_review: "review.json",
      tasks: [{
        id: "t2-fix", objective: "fix widget b edge case", depends_on: [], read_paths: [],
        write_paths: ["b.txt"], acceptance_ids: ["AC-02"],
        verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
        effort: "high", risk: "low", source_task_id: "t2", session_policy: "fresh",
      }],
    });

    const acceptGap = await call(["accept-review", "--run", runId, "--review-file", reviewPath, "--correction-graph-file", correctionGraphPath], integrationWorktree, baseEnv);
    assert.equal(acceptGap.code, 0, acceptGap.rawErr);
    assert.equal(acceptGap.out.phase, "REVIEWED");

    const wave2Env = { ...baseEnv, FAKE_TASK_FILE_MAP: JSON.stringify({ "t2-fix": "b.txt" }), FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ "t2-fix": ["AC-02"] }) };
    const wave2 = await call(["run-wave", "--run", runId, "--wave", "2"], integrationWorktree, wave2Env);
    assert.equal(wave2.code, 0, wave2.rawErr);
    assert.equal(wave2.out.phase, "WAVE_2_COMPLETE");

    // A THIRD WAVE IS IMPOSSIBLE THROUGH THE CLI. `notEqual(code, 0)` alone
    // would also pass on a *runtime* failure (exit 1) or on a refusal that
    // nonetheless mutated the run, so assert the exact contract: an
    // argument/contract refusal (exit 2) that leaves the phase untouched.
    const thirdWave = await call(["run-wave", "--run", runId, "--wave", "2"], integrationWorktree, wave2Env);
    assert.equal(thirdWave.code, 2, thirdWave.rawErr);
    const phaseAfterThirdWaveAttempt = await call(["status", "--run", runId], integrationWorktree, wave2Env);
    assert.equal(phaseAfterThirdWaveAttempt.out.phase, "WAVE_2_COMPLETE", "a refused third wave must not mutate the run");

    const finalReviewPath = writeJson(root, "final-review.json", {
      acceptance: [
        { id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "verified" },
        { id: "AC-02", status: "SATISFIED", evidence_paths: [], reason: "fixed" },
      ],
      summary: "all satisfied after correction",
    });
    const afr = await call(["accept-final-review", "--run", runId, "--review-file", finalReviewPath], integrationWorktree, wave2Env);
    assert.equal(afr.code, 0, afr.rawErr);
    assert.equal(afr.out.phase, "CORRECTIONS_REVIEWED");

    const verifyRes = await call(["verify", "--run", runId], integrationWorktree, wave2Env);
    assert.equal(verifyRes.code, 0, verifyRes.rawErr);
    assert.equal(verifyRes.out.phase, "FINISH_PENDING");

    const decisionPath = writeJson(root, "decision.json", { target: null });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "keep", "--decision-file", decisionPath], integrationWorktree, wave2Env);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);
    const completeRes = await call(["complete-finish", "--run", runId], integrationWorktree, wave2Env);
    assert.equal(completeRes.code, 0, completeRes.rawErr);
    assert.equal(completeRes.out.phase, "COMPLETE");
  });
});

// --------------------------------------------------------------------------
// Stdout size discipline
// --------------------------------------------------------------------------

describe("stdout discipline", () => {
  test("every successful command's stdout stays under 1024 bytes", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const reviewPath = writeJson(harness.root, "review.json", { acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "ok" }], summary: "ok" });
    const results = [];
    results.push(await call(["status", "--run", runId], integrationWorktree, waveEnv));
    results.push(await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv));
    results.push(await call(["verify", "--run", runId], integrationWorktree, waveEnv));
    for (const r of results) {
      assert.equal(r.code, 0, r.rawErr);
      assert.ok(Buffer.byteLength(r.rawOut) < 1024, `stdout was ${Buffer.byteLength(r.rawOut)} bytes: ${r.rawOut}`);
    }
  });
});

// --------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------

describe("init", () => {
  test("requires --request-file in production (no stdin fallback without --stdin)", async () => {
    const harness = makeHarness();
    const res = await call(["init"], harness.repo, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("--stdin is a test-only injection path", async () => {
    const harness = makeHarness();
    const { io, stdout } = makeIO(harness.repo, harness.baseEnv, "request text from stdin\n");
    const code = await main(["init", "--stdin"], io);
    assert.equal(code, 0);
    const out = JSON.parse(stdout());
    const paths = getRunPaths(inspectRepository(harness.repo), out.run_id);
    assert.equal(readFileSync(paths.request, "utf8"), "request text from stdin\n");
  });

  test("rejects a symlinked --request-file", async () => {
    const harness = makeHarness();
    const real = join(harness.root, "real-request.md");
    writeFileSync(real, "hi\n");
    const link = join(harness.root, "linked-request.md");
    symlinkSync(real, link);
    const res = await call(["init", "--request-file", link], harness.repo, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("rejects a --request-file over the byte cap", async () => {
    const harness = makeHarness();
    const big = join(harness.root, "big-request.md");
    writeFileSync(big, "x".repeat(65537));
    const res = await call(["init", "--request-file", big], harness.repo, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("fails before any mutation when Codex preflight fails (no run directory is created)", async () => {
    const harness = makeHarness();
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const badEnv = { ...harness.baseEnv, FAKE_CODEX_LOGIN_STATUS: "1", CODEX_API_KEY: "" };
    delete badEnv.CODEX_API_KEY;
    const res = await call(["init", "--request-file", requestPath], harness.repo, badEnv);
    assert.equal(res.code, 1);
    const supervisedDir = join(harness.repo, ".git", "carefully-crafted", "supervise");
    assert.equal(existsSync(supervisedDir), false, "no run ledger should exist when preflight fails before any mutation");
  });
});

// --------------------------------------------------------------------------
// accept-plan
// --------------------------------------------------------------------------

describe("accept-plan", () => {
  test("rejects a plan file outside the integration worktree", async () => {
    const harness = makeHarness();
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);

    const outsidePlan = join(harness.root, "outside-plan.md");
    writeFileSync(outsidePlan, "# plan\n");
    const graphPath = writeJson(harness.root, "graph.json", { version: 1, run_id: runId, base_commit: "0".repeat(40) });
    const res = await call(["accept-plan", "--run", runId, "--plan-file", outsidePlan, "--graph-file", graphPath], initRes.out.integration_worktree, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("rejects an untracked plan file inside the integration worktree", async () => {
    const harness = makeHarness();
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);
    const integrationWorktree = initRes.out.integration_worktree;

    const untrackedPlan = join(integrationWorktree, "untracked-plan.md");
    writeFileSync(untrackedPlan, "# plan\n");
    const graphPath = writeJson(harness.root, "graph.json", { version: 1, run_id: runId, base_commit: git(integrationWorktree, ["rev-parse", "HEAD"]) });
    const res = await call(["accept-plan", "--run", runId, "--plan-file", untrackedPlan, "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("rejects a graph whose base_commit does not match the clean integration HEAD", async () => {
    const harness = makeHarness();
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);
    const integrationWorktree = initRes.out.integration_worktree;

    const planRelPath = "docs/superpowers/plans/plan.md";
    mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(integrationWorktree, planRelPath), "# plan\n");
    git(integrationWorktree, ["add", "-A"]);
    git(integrationWorktree, ["commit", "-qm", "plan"]);

    const graph = {
      version: 1, run_id: runId, base_commit: "f".repeat(40),
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }], approval_flags: [],
      final_verification: [{ id: "final-ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
      tasks: [{ id: "t1", wave: 1, objective: "x", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" }],
    };
    const graphPath = writeJson(harness.root, "graph.json", graph);
    const res = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(res.code, 2);
  });
});

// --------------------------------------------------------------------------
// decide-approval
// --------------------------------------------------------------------------

describe("decide-approval", () => {
  async function bootstrapWithApproval(harness) {
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);
    const integrationWorktree = initRes.out.integration_worktree;

    const planRelPath = "docs/superpowers/plans/plan.md";
    mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(integrationWorktree, planRelPath), "# plan\n");
    git(integrationWorktree, ["add", "-A"]);
    git(integrationWorktree, ["commit", "-qm", "plan"]);
    const baseCommit = git(integrationWorktree, ["rev-parse", "HEAD"]);

    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }],
      approval_flags: [{
        id: "approval-01", category: "destructive", description: "delete stuff", status: "PENDING",
        prompt: "ok to delete?", evidence_paths: [], created_at: new Date().toISOString(), decided_at: null,
      }, {
        id: "approval-02", category: "network", description: "call external API", status: "PENDING",
        prompt: "ok to call the API?", evidence_paths: [], created_at: new Date().toISOString(), decided_at: null,
      }],
      final_verification: [{ id: "final-ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
      tasks: [{ id: "t1", wave: 1, objective: "x", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" }],
    };
    const graphPath = writeJson(harness.root, "graph.json", graph);
    const acceptRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);
    assert.equal(acceptRes.code, 0, acceptRes.rawErr);
    assert.equal(acceptRes.out.phase, "APPROVAL_PENDING");
    return { runId, integrationWorktree };
  }

  test("approval pending, idempotent approve, then run-wave becomes reachable", async () => {
    // Two flags so approving the first one legitimately LEAVES the run in
    // APPROVAL_PENDING (the second is still pending) — the only shape in
    // which a repeat decision on the first can actually be exercised from
    // APPROVAL_PENDING at all (a single-flag graph moves straight to
    // PLANNED, where DECIDE_APPROVAL has no edge).
    const harness = makeHarness();
    const { runId, integrationWorktree } = await bootstrapWithApproval(harness);
    const evidencePath = writeJson(harness.root, "evidence.json", { note: "reviewed by human" });

    const first = await call(["decide-approval", "--run", runId, "--id", "approval-01", "--decision", "approve", "--evidence-file", evidencePath], integrationWorktree, harness.baseEnv);
    assert.equal(first.code, 0, first.rawErr);
    assert.equal(first.out.phase, "APPROVAL_PENDING");

    // Idempotent repeat of the SAME decision succeeds harmlessly and does
    // not advance past the still-pending second flag.
    const second = await call(["decide-approval", "--run", runId, "--id", "approval-01", "--decision", "approve", "--evidence-file", evidencePath], integrationWorktree, harness.baseEnv);
    assert.equal(second.code, 0, second.rawErr);
    assert.equal(second.out.phase, "APPROVAL_PENDING");

    // A CONFLICTING decision on an already-decided id is rejected.
    const conflicting = await call(["decide-approval", "--run", runId, "--id", "approval-01", "--decision", "reject", "--evidence-file", evidencePath], integrationWorktree, harness.baseEnv);
    assert.notEqual(conflicting.code, 0);

    const third = await call(["decide-approval", "--run", runId, "--id", "approval-02", "--decision", "approve", "--evidence-file", evidencePath], integrationWorktree, harness.baseEnv);
    assert.equal(third.code, 0, third.rawErr);
    assert.equal(third.out.phase, "PLANNED");
  });

  test("rejection invalidates the accepted graph and returns to GRADED for replanning", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree } = await bootstrapWithApproval(harness);
    const evidencePath = writeJson(harness.root, "evidence.json", { note: "rejected: too risky" });

    const rej = await call(["decide-approval", "--run", runId, "--id", "approval-01", "--decision", "reject", "--evidence-file", evidencePath], integrationWorktree, harness.baseEnv);
    assert.equal(rej.code, 0, rej.rawErr);
    assert.equal(rej.out.phase, "GRADED");

    // A genuine replan (different plan/graph content) is legitimately
    // reachable again from GRADED — proves the "current plan" artifacts are
    // overwritable rather than exclusive-locked forever.
    const planRelPath2 = "docs/superpowers/plans/plan-v2.md";
    mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(integrationWorktree, planRelPath2), "# plan v2\n");
    git(integrationWorktree, ["add", "-A"]);
    git(integrationWorktree, ["commit", "-qm", "plan v2"]);
    const baseCommit2 = git(integrationWorktree, ["rev-parse", "HEAD"]);
    const graph2 = {
      version: 1, run_id: runId, base_commit: baseCommit2,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }], approval_flags: [],
      final_verification: [{ id: "final-ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
      tasks: [{ id: "t1", wave: 1, objective: "x", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" }],
    };
    const graphPath2 = writeJson(harness.root, "graph2.json", graph2);
    const replanRes = await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath2), "--graph-file", graphPath2], integrationWorktree, harness.baseEnv);
    assert.equal(replanRes.code, 0, replanRes.rawErr);
    assert.equal(replanRes.out.phase, "PLANNED");
  });
});

// --------------------------------------------------------------------------
// Failure gates: phase-skip refusal
// --------------------------------------------------------------------------

describe("phase-skip refusal", () => {
  test("run-wave before accept-plan is refused", async () => {
    const harness = makeHarness();
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const res = await call(["run-wave", "--run", initRes.out.run_id, "--wave", "1"], initRes.out.integration_worktree, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("grade before init (unknown run) is refused", async () => {
    const harness = makeHarness();
    const res = await call(["grade", "--run", "20260101T000000Z-deadbeef"], harness.repo, harness.baseEnv);
    assert.equal(res.code, 2);
  });

  test("verify before accept-review is refused", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const res = await call(["verify", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(res.code, 2);
  });

  test("complete-finish before choose-finish is refused", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const res = await call(["complete-finish", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(res.code, 2);
  });

  test("run-wave --wave 3 is rejected at the argument layer", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const res = await call(["run-wave", "--run", runId, "--wave", "3"], integrationWorktree, waveEnv);
    assert.equal(res.code, 2);
  });
});

// --------------------------------------------------------------------------
// Restart by run ID
// --------------------------------------------------------------------------

describe("restart by run ID", () => {
  test("status works from a freshly-resolved context (a different io.cwd inside the same repo)", async () => {
    const harness = makeHarness();
    const { runId, repo, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    // Query from the ORIGINAL repo checkout, not the integration worktree —
    // proves the run is locatable purely from the run ID plus any cwd inside
    // the same repository (shared git-common-dir).
    const res = await call(["status", "--run", runId], repo, waveEnv);
    assert.equal(res.code, 0, res.rawErr);
    assert.equal(res.out.run_id, runId);
    assert.equal(res.out.phase, "WAVE_1_COMPLETE");
    void integrationWorktree;
  });
});

// --------------------------------------------------------------------------
// Missing result output (grader failure -> BLOCKED)
// --------------------------------------------------------------------------

describe("grading failure -> BLOCKED, then recover", () => {
  test("a grader failure blocks the run with evidence, and recover refuses without a changed-condition file", async () => {
    const harness = makeHarness();
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;

    const failEnv = { ...harness.baseEnv, FAKE_CODEX_GRADER_FAIL: "1" };
    const gradeRes = await call(["grade", "--run", runId], harness.repo, failEnv);
    assert.equal(gradeRes.code, 1);
    assert.equal(gradeRes.out.phase, "BLOCKED");
    assert.ok(existsSync(gradeRes.out.artifact), "block evidence must be written to disk");

    // recover without --changed-condition-file is refused.
    const recoverNoFile = await call(["recover", "--run", runId], harness.repo, harness.baseEnv);
    assert.equal(recoverNoFile.code, 2);

    // recover with UNCHANGED evidence (byte-identical to what caused the
    // block) is refused.
    const blockEvidenceBytes = readFileSync(gradeRes.out.artifact);
    const sameEvidencePath = join(harness.root, "same-condition.json");
    writeFileSync(sameEvidencePath, blockEvidenceBytes);
    const recoverSame = await call(["recover", "--run", runId, "--changed-condition-file", sameEvidencePath], harness.repo, harness.baseEnv);
    assert.equal(recoverSame.code, 1);

    // recover with a GENUINELY changed condition, and a healthy codex this
    // time, succeeds and completes grading.
    const changedPath = writeJson(harness.root, "changed-condition.json", { note: "rate limit cleared", at: new Date().toISOString() });
    const recoverOk = await call(["recover", "--run", runId, "--changed-condition-file", changedPath], harness.repo, harness.baseEnv);
    assert.equal(recoverOk.code, 0, recoverOk.rawErr);
    assert.equal(recoverOk.out.phase, "GRADED");
  });
});

// --------------------------------------------------------------------------
// Crash recovery: interrupted wave recovers completed receipts without
// rerunning them (carry-forward #7).
// --------------------------------------------------------------------------

describe("recover: interrupted wave reuses completed receipts", () => {
  test("a wave interrupted after both tasks already committed is recovered by integration only — neither worker is invoked again", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const tasks = [
      { id: "t1", wave: 1, objective: "widget a", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
      { id: "t2", wave: 1, objective: "widget b", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
    ];

    // Bootstrap through accept-plan only (not run-wave).
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);
    const integrationWorktree = initRes.out.integration_worktree;

    const planRelPath = "docs/superpowers/plans/plan.md";
    mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(integrationWorktree, planRelPath), "# plan\n");
    git(integrationWorktree, ["add", "-A"]);
    git(integrationWorktree, ["commit", "-qm", "plan"]);
    const baseCommit = git(integrationWorktree, ["rev-parse", "HEAD"]);
    const graph = {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }], approval_flags: [],
      final_verification: [{ id: "final-ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
      tasks,
    };
    const graphPath = writeJson(harness.root, "graph.json", graph);
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);

    // --- Manually reproduce exactly what a crashed-mid-wave attempt leaves
    // behind: both task commits genuinely exist (created via git.mjs's own
    // primitives, never via the CLI or a Codex spawn), receipts are written
    // to the ledger, and run.json is forced into WAVE_1_RUNNING with a dead
    // pid — WITHOUT ever calling run-wave. ---
    const repoInfo = inspectRepository(harness.repo);
    const paths = getRunPaths(repoInfo, runId);
    const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);

    const commits = {};
    for (const t of tasks) {
      const wt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave: 1, taskId: t.id, baseCommit });
      writeFileSync(join(wt.path, t.write_paths[0]), `changed-by-worker-${t.id}\n`);
      const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit, writePaths: t.write_paths });
      assert.ok(changes.ok, `inspectTaskChanges failed for ${t.id}: ${changes.reason}`);
      const commitInfo = createTaskCommit({ repoInfo, worktreePath: wt.path, baseCommit, writePaths: t.write_paths, runId, taskId: t.id, expectedFingerprint: changes.fingerprint });
      const inspect = inspectTaskCommit({ worktreePath: wt.path, baseCommit, commit: commitInfo.commit });
      assert.ok(inspect.ok);
      const ownership = assertCommitOwnership({ worktreePath: wt.path, baseCommit, commit: commitInfo.commit, writePaths: t.write_paths, expectedFingerprint: changes.fingerprint });
      commits[t.id] = commitInfo.commit;

      const receipt = buildTaskReceipt({
        taskId: t.id,
        workerOutcome: { threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, processExitCode: 0 },
        commit: commitInfo.commit, changedFiles: ownership.files, ownershipValid: true,
        hostVerification: [{ id: "ok", status: "PASS", exitCode: 0, logPath: null }],
        report: { status: "DONE", summary: "did it", acceptance: t.acceptance_ids.map((id) => ({ id, status: "PASS", evidence: "e2e" })), verification: [{ id: "ok", status: "PASS", summary: "ok" }], concerns: [], blockers: [] },
      });
      mkdirSync(paths.receiptsDir, { recursive: true });
      writeFileSync(join(paths.receiptsDir, `wave-1-${t.id}.json`), JSON.stringify(receipt, null, 2));
    }

    // Force run.json into WAVE_1_RUNNING with a definitely-dead pid.
    await updateRun(repoInfo, runId, { type: "RUN_WAVE_1", operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "wave-1" } });
    assert.equal(loadRun(repoInfo, runId).phase, Phase.WAVE_1_RUNNING);

    // A record file proves no NEW codex spawn happens during recovery.
    const recordPath = join(harness.root, "codex-record.jsonl");
    const recoverEnv = { ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath };
    const recoverRes = await call(["recover", "--run", runId], integrationWorktree, recoverEnv);
    assert.equal(recoverRes.code, 0, recoverRes.rawErr);
    assert.equal(recoverRes.out.phase, "WAVE_1_COMPLETE");
    assert.equal(existsSync(recordPath), false, "recovering already-completed receipts must not spawn a single worker");

    // Both commits are now on the integration branch.
    const integrationHead = git(integrationWorktree, ["rev-parse", "HEAD"]);
    for (const t of tasks) {
      assert.ok(git(integrationWorktree, ["log", "--format=%H", "--grep", `cherry picked from commit ${commits[t.id]}`, integrationHead]).length > 0, `${t.id}'s commit should be integrated via cherry-pick`);
    }
  });
});

// --------------------------------------------------------------------------
// block
// --------------------------------------------------------------------------

describe("block", () => {
  test("an operator-initiated block is legal from a non-terminal phase and requires recover afterward", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const evidencePath = writeJson(harness.root, "block-evidence.json", { note: "manual hold" });
    const res = await call(["block", "--run", runId, "--evidence-file", evidencePath], integrationWorktree, waveEnv);
    assert.equal(res.code, 1);
    assert.equal(res.out.phase, "BLOCKED");

    const statusRes = await call(["status", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(statusRes.out.phase, "BLOCKED");
    assert.equal(statusRes.out.next, "recover");
  });
});

// --------------------------------------------------------------------------
// Finishing: keep / failed+successful merge / discard
// --------------------------------------------------------------------------

async function bootstrapToFinishPending(harness) {
  const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
  const reviewPath = writeJson(harness.root, "review.json", { acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "ok" }], summary: "ok" });
  const reviewRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);
  assert.equal(reviewRes.code, 0, reviewRes.rawErr);
  const verifyRes = await call(["verify", "--run", runId], integrationWorktree, waveEnv);
  assert.equal(verifyRes.code, 0, verifyRes.rawErr);
  return { runId, integrationWorktree, waveEnv };
}

describe("finishing: keep", () => {
  test("choose-finish(keep) -> complete-finish completes immediately with no external action", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    const decisionPath = writeJson(harness.root, "decision.json", { target: null });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "keep", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);
    const completeRes = await call(["complete-finish", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(completeRes.code, 0, completeRes.rawErr);
    assert.equal(completeRes.out.phase, "COMPLETE");
  });
});

describe("finishing: merge", () => {
  test("a failed merge attempt stays FINISH_ACTION_PENDING; a subsequent successful merge completes", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);

    // Set up a real local "origin/main"-like target ref that does NOT yet
    // contain the integration HEAD.
    git(harness.repo, ["branch", "release"]);
    const decisionPath = writeJson(harness.root, "decision.json", { target: "release" });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "merge", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);

    // complete-finish before Superpowers actually performed the merge: the
    // target ref does not yet contain the integration HEAD -> failure,
    // stays FINISH_ACTION_PENDING.
    const evidencePath1 = writeJson(harness.root, "merge-evidence-1.json", { note: "attempted merge" });
    const failRes = await call(["complete-finish", "--run", runId, "--evidence-file", evidencePath1], integrationWorktree, waveEnv);
    assert.equal(failRes.code, 1);
    assert.equal(failRes.out.phase, "FINISH_ACTION_PENDING");

    // Now perform the actual merge (what Superpowers would have done),
    // preserving the integration worktree.
    const integrationHead = git(integrationWorktree, ["rev-parse", "HEAD"]);
    git(harness.repo, ["update-ref", "refs/heads/release", integrationHead]);
    assert.ok(existsSync(integrationWorktree), "the integration worktree must still exist");

    const evidencePath2 = writeJson(harness.root, "merge-evidence-2.json", { note: "merge landed" });
    const okRes = await call(["complete-finish", "--run", runId, "--evidence-file", evidencePath2], integrationWorktree, waveEnv);
    assert.equal(okRes.code, 0, okRes.rawErr);
    assert.equal(okRes.out.phase, "COMPLETE");
  });
});

describe("finishing: discard", () => {
  test("discard runs from the original repository and completes after the integration worktree is removed", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);

    const decisionPath = writeJson(harness.root, "decision.json", { target: null });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "discard", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);
    assert.equal(chooseRes.out.phase, "FINISH_ACTION_PENDING");

    // complete-finish must be refused for a discard choice.
    const wrongCmd = await call(["complete-finish", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(wrongCmd.code, 2);

    const discardDecisionPath = writeJson(harness.root, "discard-decision.json", { confirm: "discard", run_id: runId });
    // cleanup --mode discard runs from the ORIGINAL repository.
    const cleanupRes = await call(["cleanup", "--run", runId, "--mode", "discard", "--decision-file", discardDecisionPath], harness.repo, waveEnv);
    assert.equal(cleanupRes.code, 0, cleanupRes.rawErr);
    assert.equal(cleanupRes.out.phase, "COMPLETE");
    assert.equal(existsSync(integrationWorktree), false, "the integration worktree must be removed by discard cleanup");
  });

  test("BRIEF-NAMED SCENARIO: discard completes even when the integration worktree DIRECTORY was already removed out of band", async () => {
    // Brief lines 38 and 55: "discard after integration-worktree removal".
    // Before the fix this was a permanent dead end — `git branch -D` failed
    // with "used by worktree at ..." because the stale registration under
    // .git/worktrees survived the directory, every cleanup retry failed
    // identically, and complete-finish refuses a discard choice, so the run
    // could never reach a terminal phase.
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);

    const decisionPath = writeJson(harness.root, "decision.json", { target: null });
    const chooseRes = await call(["choose-finish", "--run", runId, "--choice", "discard", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    assert.equal(chooseRes.code, 0, chooseRes.rawErr);

    // The scenario: the directory is gone, but git still has it registered.
    rmSync(integrationWorktree, { recursive: true, force: true });
    assert.equal(existsSync(integrationWorktree), false);

    const discardDecisionPath = writeJson(harness.root, "discard-decision.json", { confirm: "discard", run_id: runId });
    const cleanupRes = await call(["cleanup", "--run", runId, "--mode", "discard", "--decision-file", discardDecisionPath], harness.repo, waveEnv);
    assert.equal(cleanupRes.code, 0, cleanupRes.rawErr);
    assert.equal(cleanupRes.out.phase, "COMPLETE");

    // The run's branches are genuinely gone, not merely reported gone.
    const branches = execFileSync("git", ["branch", "--list", `carefully-crafted/${runId}/*`], { cwd: harness.repo, encoding: "utf8" }).trim();
    assert.equal(branches, "", `expected no surviving run branches, got: ${branches}`);
  });

  test("cleanup --mode discard refuses to run from inside the worktree tree it would delete", async () => {
    // SKILL.md instructs Claude to run this from the original repository,
    // but the CLI is the supervisor-owned safety boundary: an instruction is
    // not an enforcement point. Before the fix this exited 0, deleted its
    // own cwd, and reported COMPLETE.
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    const decisionPath = writeJson(harness.root, "decision.json", { target: null });
    await call(["choose-finish", "--run", runId, "--choice", "discard", "--decision-file", decisionPath], integrationWorktree, waveEnv);

    const discardDecisionPath = writeJson(harness.root, "discard-decision.json", { confirm: "discard", run_id: runId });
    const fromInside = await call(["cleanup", "--run", runId, "--mode", "discard", "--decision-file", discardDecisionPath], integrationWorktree, waveEnv);
    assert.equal(fromInside.code, 2, fromInside.rawErr);
    assert.match(fromInside.rawErr, /refusing to run from inside/);
    assert.ok(existsSync(integrationWorktree), "the refused cleanup must not have deleted its own cwd");

    // And the correct invocation still works afterward — the guard blocks
    // the unsafe cwd, not the operation.
    const fromRepo = await call(["cleanup", "--run", runId, "--mode", "discard", "--decision-file", discardDecisionPath], harness.repo, waveEnv);
    assert.equal(fromRepo.code, 0, fromRepo.rawErr);
    assert.equal(fromRepo.out.phase, "COMPLETE");
  });
});

// --------------------------------------------------------------------------
// choose-finish target requirement (Critical 1)
// --------------------------------------------------------------------------

describe("choose-finish: a verifiable target is mandatory for merge/push", () => {
  test("merge without a target is refused at choose-finish, so an unperformed merge can never reach COMPLETE", async () => {
    // Before the fix: choose-finish accepted a targetless merge, and
    // complete-finish's only real check (`if (success && run.finish.target)`)
    // was skipped, so "success" collapsed to "clean worktree + some file was
    // passed". A run could claim a merge it never performed and reach
    // COMPLETE with the target ref untouched.
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    execFileSync("git", ["branch", "release"], { cwd: harness.repo });

    const noTargetDecision = writeJson(harness.root, "decision.json", { note: "merge into release" });
    const res = await call(["choose-finish", "--run", runId, "--choice", "merge", "--decision-file", noTargetDecision], integrationWorktree, waveEnv);
    assert.equal(res.code, 2, res.rawErr);
    assert.match(res.rawErr, /requires a non-empty "target"/);

    // The run did not advance, so no completion is reachable from here.
    const status = await call(["status", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(status.out.phase, "FINISH_PENDING");
  });

  test("push without a target is refused the same way", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    const noTargetDecision = writeJson(harness.root, "decision.json", { note: "push it" });
    const res = await call(["choose-finish", "--run", runId, "--choice", "push", "--decision-file", noTargetDecision], integrationWorktree, waveEnv);
    assert.equal(res.code, 2, res.rawErr);
  });

  test("a self-referential target (this run's own integration branch) is refused as vacuous", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    const selfTarget = writeJson(harness.root, "decision.json", { target: `carefully-crafted/${runId}/integration` });
    const res = await call(["choose-finish", "--run", runId, "--choice", "merge", "--decision-file", selfTarget], integrationWorktree, waveEnv);
    assert.equal(res.code, 2, res.rawErr);
    assert.match(res.rawErr, /vacuously true/);
  });

  test("keep and discard still need no target (they have no ref-verified action)", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    const noTarget = writeJson(harness.root, "decision.json", { note: "just keep it" });
    const res = await call(["choose-finish", "--run", runId, "--choice", "keep", "--decision-file", noTarget], integrationWorktree, waveEnv);
    assert.equal(res.code, 0, res.rawErr);
    assert.equal(res.out.phase, "FINISH_ACTION_PENDING");
  });

  test("a discard run's `next` names cleanup, not the complete-finish that would refuse it", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapToFinishPending(harness);
    const decisionPath = writeJson(harness.root, "decision.json", { target: null });
    await call(["choose-finish", "--run", runId, "--choice", "discard", "--decision-file", decisionPath], integrationWorktree, waveEnv);
    const status = await call(["status", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(status.out.phase, "FINISH_ACTION_PENDING");
    assert.match(status.out.next, /cleanup --mode discard/);
  });
});

// --------------------------------------------------------------------------
// Valueless-flag handling (argument errors must map to exit 2, never 1)
// --------------------------------------------------------------------------

describe("valueless flags are argument errors (exit 2), never runtime errors (exit 1)", () => {
  test("init --request-file with no value exits 2", async () => {
    const harness = makeHarness();
    const res = await call(["init", "--request-file"], harness.repo, harness.baseEnv);
    assert.equal(res.code, 2, res.rawErr);
    assert.match(res.rawErr, /requires a value/);
  });

  test("run-wave --wave with no value exits 2 rather than silently meaning wave 1", async () => {
    // Number(true) === 1, so a bare `--wave` used to quietly run wave one.
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const res = await call(["run-wave", "--run", runId, "--wave"], integrationWorktree, waveEnv);
    assert.equal(res.code, 2, res.rawErr);
  });

  test("recover --changed-condition-file with no value exits 2", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const evidencePath = writeJson(harness.root, "block-evidence.json", { note: "hold" });
    await call(["block", "--run", runId, "--evidence-file", evidencePath], integrationWorktree, waveEnv);
    const res = await call(["recover", "--run", runId, "--changed-condition-file"], integrationWorktree, waveEnv);
    assert.equal(res.code, 2, res.rawErr);
  });
});

// --------------------------------------------------------------------------
// Crash recovery for the remaining running phases (Important 4)
//
// The brief requires a crash simulation for EACH running phase. GRADING and
// WAVE_1_RUNNING are covered above; these cover VERIFYING and
// WAVE_2_RUNNING. The wave-two case matters disproportionately because
// recoverWave(ctx, 2) calls loadCorrectionGraph, which re-reads and
// re-validates task-graph.json, review.json, and correction-graph.json
// against run.wave1IntegrationHead — a path never exercised by the wave-one
// recovery test.
// --------------------------------------------------------------------------

describe("recover: interrupted VERIFYING", () => {
  test("a run crashed mid-verification recovers, re-runs the immutable command set, and reaches FINISH_PENDING", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const reviewPath = writeJson(harness.root, "review.json", {
      acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "ok" }],
      summary: "ok",
    });
    // The no-gap accept-review arms VERIFYING with a recorded operation.
    const reviewRes = await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);
    assert.equal(reviewRes.code, 0, reviewRes.rawErr);
    assert.equal(reviewRes.out.phase, "VERIFYING");

    // Simulate the crash: overwrite the recorded operation's pid with a
    // definitely-dead one, leaving the run stranded in VERIFYING exactly as
    // a killed process would.
    const repoInfo = inspectRepository(harness.repo);
    await updateRun(repoInfo, runId, {
      type: "RECOVER_INTERRUPTED",
      reconciliation: { processes: true, receipts: true, worktrees: true, integrationHead: true },
      operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "verify" },
    });
    assert.equal(loadRun(repoInfo, runId).phase, Phase.VERIFYING);

    const recoverRes = await call(["recover", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(recoverRes.code, 0, recoverRes.rawErr);
    assert.equal(recoverRes.out.phase, "FINISH_PENDING");
    assert.ok(existsSync(recoverRes.out.artifact), "recovery must write the final receipt");
  });

  test("recover refuses while the recorded operation's process is still alive", async () => {
    const harness = makeHarness();
    const { runId, integrationWorktree, waveEnv } = await bootstrapThroughWave1(harness);
    const reviewPath = writeJson(harness.root, "review.json", {
      acceptance: [{ id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "ok" }],
      summary: "ok",
    });
    await call(["accept-review", "--run", runId, "--review-file", reviewPath], integrationWorktree, waveEnv);

    // This test process is, definitionally, alive.
    const repoInfo = inspectRepository(harness.repo);
    await updateRun(repoInfo, runId, {
      type: "RECOVER_INTERRUPTED",
      reconciliation: { processes: true, receipts: true, worktrees: true, integrationHead: true },
      operation: { pid: process.pid, startedAt: new Date().toISOString(), kind: "verify" },
    });
    const res = await call(["recover", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(res.code, 1, res.rawErr);
    assert.match(res.rawErr, /still running/);
  });
});

describe("recover: interrupted WAVE_2_RUNNING", () => {
  test("a correction wave crashed after its task committed recovers via loadCorrectionGraph without respawning the worker", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const tasks = [
      { id: "t1", wave: 1, objective: "widget a", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
      { id: "t2", wave: 1, objective: "widget b", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
    ];
    const { root, runId, integrationWorktree, baseEnv } = await bootstrapThroughWave1(harness, { tasks });

    const reviewPath = writeJson(root, "review.json", {
      acceptance: [
        { id: "AC-01", status: "SATISFIED", evidence_paths: [], reason: "ok" },
        { id: "AC-02", status: "GAP", evidence_paths: [], reason: "gap" },
      ],
      summary: "one gap",
    });
    const wave1Head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: integrationWorktree, encoding: "utf8" }).trim();
    const correctionGraphPath = writeJson(root, "correction-graph.json", {
      version: 1, run_id: runId, wave: 2, base_commit: wave1Head, source_review: "review.json",
      tasks: [{
        id: "t2-fix", objective: "fix b", depends_on: [], read_paths: [], write_paths: ["b.txt"],
        acceptance_ids: ["AC-02"],
        verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
        effort: "high", risk: "low", source_task_id: "t2", session_policy: "fresh",
      }],
    });
    const acceptGap = await call(["accept-review", "--run", runId, "--review-file", reviewPath, "--correction-graph-file", correctionGraphPath], integrationWorktree, baseEnv);
    assert.equal(acceptGap.code, 0, acceptGap.rawErr);
    assert.equal(acceptGap.out.phase, "REVIEWED");

    // Reproduce a crashed wave two: the correction task's commit genuinely
    // exists (built through git.mjs primitives, never through run-wave), its
    // receipt is on disk, and run.json is stranded in WAVE_2_RUNNING with a
    // dead pid.
    const repoInfo = inspectRepository(harness.repo);
    const paths = getRunPaths(repoInfo, runId);
    const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);
    const correctionTask = { id: "t2-fix", write_paths: ["b.txt"], acceptance_ids: ["AC-02"] };

    const wt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave: 2, taskId: correctionTask.id, baseCommit: wave1Head });
    writeFileSync(join(wt.path, "b.txt"), "corrected-by-t2-fix\n");
    const changes = inspectTaskChanges({ worktreePath: wt.path, baseCommit: wave1Head, writePaths: correctionTask.write_paths });
    assert.ok(changes.ok, `inspectTaskChanges failed: ${changes.reason}`);
    const commitInfo = createTaskCommit({ repoInfo, worktreePath: wt.path, baseCommit: wave1Head, writePaths: correctionTask.write_paths, runId, taskId: correctionTask.id, expectedFingerprint: changes.fingerprint });
    const ownership = assertCommitOwnership({ worktreePath: wt.path, baseCommit: wave1Head, commit: commitInfo.commit, writePaths: correctionTask.write_paths, expectedFingerprint: changes.fingerprint });
    const receipt = buildTaskReceipt({
      taskId: correctionTask.id,
      workerOutcome: { threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, processExitCode: 0 },
      commit: commitInfo.commit, changedFiles: ownership.files, ownershipValid: true,
      hostVerification: [{ id: "ok", status: "PASS", exitCode: 0, logPath: null }],
      report: { status: "DONE", summary: "fixed", acceptance: [{ id: "AC-02", status: "PASS", evidence: "e" }], verification: [{ id: "ok", status: "PASS", summary: "ok" }], concerns: [], blockers: [] },
    });
    mkdirSync(paths.receiptsDir, { recursive: true });
    writeFileSync(join(paths.receiptsDir, "wave-2-t2-fix.json"), JSON.stringify(receipt, null, 2));

    await updateRun(repoInfo, runId, { type: "RUN_WAVE_2", operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "wave-2" } });
    assert.equal(loadRun(repoInfo, runId).phase, Phase.WAVE_2_RUNNING);

    const recordPath = join(root, "codex-record-w2.jsonl");
    const recoverRes = await call(["recover", "--run", runId], integrationWorktree, { ...baseEnv, FAKE_CODEX_RECORD: recordPath });
    assert.equal(recoverRes.code, 0, recoverRes.rawErr);
    assert.equal(recoverRes.out.phase, "WAVE_2_COMPLETE");
    assert.equal(existsSync(recordPath), false, "recovering a completed correction receipt must not respawn the worker");

    // The correction commit is genuinely on the integration branch.
    const trailerHits = execFileSync("git", ["log", "--format=%H", "--grep", `cherry picked from commit ${commitInfo.commit}`, "HEAD"], { cwd: integrationWorktree, encoding: "utf8" }).trim();
    assert.ok(trailerHits.length > 0, "the correction commit should be integrated via cherry-pick");
  });
});

// --------------------------------------------------------------------------
// Ambiguous dirty work blocks recovery (Important 5)
// --------------------------------------------------------------------------

describe("recover: ambiguous dirty task worktrees", () => {
  test("a leftover task worktree with uncommitted work and NO receipt blocks recovery instead of being silently re-run", async () => {
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const tasks = [
      { id: "t1", wave: 1, objective: "widget a", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
      { id: "t2", wave: 1, objective: "widget b", depends_on: [], read_paths: [], write_paths: ["b.txt"], acceptance_ids: ["AC-02"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
    ];

    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);
    const integrationWorktree = initRes.out.integration_worktree;

    const planRelPath = "docs/superpowers/plans/plan.md";
    mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(integrationWorktree, planRelPath), "# plan\n");
    execFileSync("git", ["add", "-A"], { cwd: integrationWorktree });
    execFileSync("git", ["commit", "-qm", "plan"], { cwd: integrationWorktree });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: integrationWorktree, encoding: "utf8" }).trim();
    const graphPath = writeJson(harness.root, "graph.json", {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }, { id: "AC-02", text: "y" }], approval_flags: [],
      final_verification: [{ id: "fv", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
      tasks,
    });
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);

    const repoInfo = inspectRepository(harness.repo);
    const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);

    // t2 crashed mid-flight: its worktree exists with UNCOMMITTED changes
    // and there is no receipt for it — the host cannot tell whether that
    // work is worth keeping.
    const wt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave: 1, taskId: "t2", baseCommit });
    writeFileSync(join(wt.path, "b.txt"), "half-finished work from a crashed worker\n");
    assert.equal(isWorktreeClean(wt.path), false, "fixture must genuinely be dirty");

    await updateRun(repoInfo, runId, { type: "RUN_WAVE_1", operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "wave-1" } });

    const recordPath = join(harness.root, "codex-record-ambiguous.jsonl");
    const res = await call(["recover", "--run", runId], integrationWorktree, { ...harness.baseEnv, FAKE_CODEX_RECORD: recordPath });
    assert.equal(res.code, 1, res.rawErr);
    assert.equal(res.out.phase, "BLOCKED");
    assert.match(res.rawErr, /ambiguous uncommitted work/);
    assert.match(res.rawErr, /t2/);
    assert.equal(existsSync(recordPath), false, "ambiguous dirty work must block BEFORE dispatching any worker");
    // The half-finished work is preserved, not destroyed.
    assert.equal(readFileSync(join(wt.path, "b.txt"), "utf8"), "half-finished work from a crashed worker\n");
  });

  test("a CLEAN leftover task worktree with no receipt is not ambiguous — recovery proceeds and re-runs it", async () => {
    // The negative control: this proves the gate keys on dirtiness, not
    // merely on the worktree existing, so it cannot block every recovery.
    const harness = makeHarness({ "a.txt": "base-a\n", "b.txt": "base-b\n" });
    const tasks = [
      { id: "t1", wave: 1, objective: "widget a", depends_on: [], read_paths: [], write_paths: ["a.txt"], acceptance_ids: ["AC-01"], verify: [{ id: "ok", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }], effort: "high", risk: "low" },
    ];
    const requestPath = join(harness.root, "request.md");
    writeFileSync(requestPath, "hi\n");
    const initRes = await call(["init", "--request-file", requestPath], harness.repo, harness.baseEnv);
    const runId = initRes.out.run_id;
    await call(["grade", "--run", runId], harness.repo, harness.baseEnv);
    const integrationWorktree = initRes.out.integration_worktree;

    const planRelPath = "docs/superpowers/plans/plan.md";
    mkdirSync(join(integrationWorktree, "docs/superpowers/plans"), { recursive: true });
    writeFileSync(join(integrationWorktree, planRelPath), "# plan\n");
    execFileSync("git", ["add", "-A"], { cwd: integrationWorktree });
    execFileSync("git", ["commit", "-qm", "plan"], { cwd: integrationWorktree });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: integrationWorktree, encoding: "utf8" }).trim();
    const graphPath = writeJson(harness.root, "graph.json", {
      version: 1, run_id: runId, base_commit: baseCommit,
      complexity_review: { grader_score: 3, claude_score: 3, override_reason: null },
      acceptance: [{ id: "AC-01", text: "x" }], approval_flags: [],
      final_verification: [{ id: "fv", argv: ["node", "-e", "process.exit(0)"], cwd: ".", requires_approval_ids: [] }],
      tasks,
    });
    await call(["accept-plan", "--run", runId, "--plan-file", join(integrationWorktree, planRelPath), "--graph-file", graphPath], integrationWorktree, harness.baseEnv);

    const repoInfo = inspectRepository(harness.repo);
    const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);
    // Worktree exists but is CLEAN — a worker that was killed before writing
    // anything. Nothing ambiguous about that.
    const wt = createTaskWorktree({ repoInfo, runId, worktreePaths, wave: 1, taskId: "t1", baseCommit });
    assert.equal(isWorktreeClean(wt.path), true);

    await updateRun(repoInfo, runId, { type: "RUN_WAVE_1", operation: { pid: 999999999, startedAt: new Date().toISOString(), kind: "wave-1" } });

    const waveEnv = {
      ...harness.baseEnv,
      FAKE_TASK_FILE_MAP: JSON.stringify({ t1: "a.txt" }),
      FAKE_TASK_ACCEPTANCE_MAP: JSON.stringify({ t1: ["AC-01"] }),
    };
    const res = await call(["recover", "--run", runId], integrationWorktree, waveEnv);
    assert.equal(res.code, 0, res.rawErr);
    assert.equal(res.out.phase, "WAVE_1_COMPLETE");
  });
});
