#!/usr/bin/env node
// supervise.mjs — the /contexthub:supervise CLI shell.
//
// A THIN CLI shell over the frozen supervise/*.mjs modules (contracts,
// state, codex, git, scheduler, checkpoint, verify). This file owns:
//   - argv parsing and exit-code mapping (2 = argument/contract error,
//     1 = runtime/prerequisite/blocked outcome, 0 = success),
//   - reading/copying file inputs into the run ledger under deterministic
//     names, with symlink/device rejection and byte caps,
//   - wiring the frozen modules together in the exact sequence the state
//     machine and carry-forwards require.
//
// It contains NO orchestration logic that belongs in the imported modules —
// every state transition goes through state.mjs:updateRun, every git
// operation through git.mjs, every Codex call through codex.mjs/scheduler.mjs,
// every checkpoint through checkpoint.mjs, every verification command through
// verify.mjs.
//
// Node 20+ standard library only.

import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, readdirSync,
  realpathSync, rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ContractError, validateComplexity, validateTaskGraph, validateCorrectionGraph,
  validateClaudeReview, validateIdentifier,
} from "./supervise/contracts.mjs";
import {
  Phase, createRun, getRunPaths, loadRun, updateRun,
} from "./supervise/state.mjs";
import {
  SUPPORTED_MODELS, runCodex, checkCodexPrerequisites,
} from "./supervise/codex.mjs";
import {
  GitError, inspectRepository, ensurePrivateWorktreeRoot, createIntegrationWorktree,
  removeCleanWorktree, createCandidateIntegration, integrateCandidateCommit,
  abortCandidateIntegration, publishCandidateIntegration, isCommitIntegrated,
  listRunWorktrees, readHead, isWorktreeClean, integrationBranchName, candidateBranchName,
} from "./supervise/git.mjs";
import {
  beginTrackedOperation, getRunnableTasks, recommendedConcurrency,
  executeWave, effectiveSessionPolicy, buildCodexWorker,
} from "./supervise/scheduler.mjs";
import {
  buildCheckpoint, buildFinalReceipt, summarizeUsage, writeCheckpoint,
} from "./supervise/checkpoint.mjs";
import { runVerificationSet } from "./supervise/verify.mjs";

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const COMPLEXITY_SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "complexity.schema.json");
const WORKER_REPORT_SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "worker-report.schema.json");

// The only model this transport is ever allowed to route to (codex.mjs's own
// allowlist, queried through its exported array rather than hard-coded here
// a second time — SUPPORTED_MODELS is a genuinely frozen array).
const CODEX_MODEL = SUPPORTED_MODELS[0];

// Byte caps (ambiguity resolution #6, verbatim): request.md and each
// review/evidence input at 65536 bytes, the human plan at 1 MiB, machine
// graphs at their own 65536-byte contract cap (checked again here, before
// copying, in addition to contracts.mjs's own internal check post-parse).
const REQUEST_MAX_BYTES = 65536;
const PLAN_MAX_BYTES = 1024 * 1024;
const GRAPH_MAX_BYTES = 65536;
const EVIDENCE_MAX_BYTES = 65536;

const FINISH_CHOICES = new Set(["keep", "merge", "push", "pr", "discard"]);

const NEXT_COMMAND = {
  INITIALIZED: "grade",
  GRADING: "recover",
  GRADED: "accept-plan",
  APPROVAL_PENDING: "decide-approval",
  PLANNED: "run-wave --wave 1",
  WAVE_1_RUNNING: "recover",
  WAVE_1_COMPLETE: "accept-review",
  REVIEWED: "run-wave --wave 2",
  WAVE_2_RUNNING: "recover",
  WAVE_2_COMPLETE: "accept-final-review",
  CORRECTIONS_REVIEWED: "verify",
  VERIFYING: "verify",
  FINISH_PENDING: "choose-finish",
  FINISH_ACTION_PENDING: "complete-finish",
  COMPLETE: "(done)",
  BLOCKED: "recover",
};

const RUNNING_PHASES = new Set([Phase.GRADING, Phase.WAVE_1_RUNNING, Phase.WAVE_2_RUNNING, Phase.VERIFYING]);

// --------------------------------------------------------------------------
// IO + errors
// --------------------------------------------------------------------------

const defaultIO = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: () => process.cwd(),
  env: process.env,
};

// exitCode: 2 = argument/contract error, 1 = runtime/prerequisite/blocked.
// payload (optional): a compact object printed to stdout even on failure, so
// a caller always has {run_id, phase, artifact, next} to act on when a run
// exists, even when the command itself did not "succeed".
class CliError extends Error {
  constructor(exitCode, message, payload = null) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

// --------------------------------------------------------------------------
// Small utilities
// --------------------------------------------------------------------------

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function requireArg(args, key, usage) {
  if (args[key] === undefined || args[key] === true) {
    throw new CliError(2, `missing required ${usage}`);
  }
}

// Reject symlinks, devices, and non-regular files outright (brief,
// ambiguity resolution #6). lstat (not stat) so a symlink is detected as
// itself rather than silently followed to whatever it points at.
function readOpaqueFile(filePath, maxBytes, label) {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (err) {
    throw new CliError(2, `${label}: cannot stat "${filePath}" (${err.code ?? err.message})`);
  }
  if (st.isSymbolicLink()) {
    throw new CliError(2, `${label}: "${filePath}" is a symlink — refusing to follow it`);
  }
  if (!st.isFile()) {
    throw new CliError(2, `${label}: "${filePath}" is not a regular file (devices/directories/FIFOs/sockets are rejected)`);
  }
  const bytes = readFileSync(filePath);
  if (bytes.length > maxBytes) {
    throw new CliError(2, `${label}: "${filePath}" is ${bytes.length} bytes, max ${maxBytes}`);
  }
  return bytes;
}

// Exclusive creation for IMMUTABLE ledger artifacts (request.md, complexity,
// review.json, correction-graph.json, final-review.json, finish-choice.json,
// approval/finish/block/cleanup evidence, changed-condition files). A
// restart may reuse only an exact byte-for-byte hash match; anything else is
// refused rather than silently overwriting prior evidence.
function writeLedgerArtifactExclusive(destPath, bytes) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    writeFileSync(destPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const existing = readFileSync(destPath);
    if (!existing.equals(bytes)) {
      throw new CliError(2, `refusing to overwrite existing ledger artifact at "${destPath}" with different content — a restart may only reuse an exact byte-for-byte match`);
    }
  }
}

// A small set of "current plan" artifacts (plan.md, task-graph.json,
// approvals.json) are legitimately OVERWRITTEN on a genuine re-plan: the
// only way accept-plan is reachable a second time for the same run is after
// a rejection (APPROVAL_PENDING -> GRADED), which already invalidated the
// prior plan/graph. Exclusive-create-or-match would incorrectly block that
// legitimate replan, so these three specifically use plain overwrite.
function writeLedgerArtifactOverwrite(destPath, bytes) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes, { mode: 0o600 });
}

function isPathTrackedAtHead(cwd, relPath) {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", relPath], { cwd, encoding: "utf8" });
  return r.status === 0;
}

function isAncestorOf(cwd, ancestor, ref) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, ref], { cwd });
  return r.status === 0;
}

// Force-delete is ONLY ever performed by the supervisor (this CLI, never
// Superpowers) and ONLY ever within this run's own branch namespace — the
// prefix check is a hard backstop, not merely documentation.
function forceDeleteRunBranch(topLevel, runId, branch) {
  if (!branch.startsWith(`carefully-crafted/${runId}/`)) {
    throw new GitError(`forceDeleteRunBranch: refusing to delete a branch outside this run's namespace: "${branch}"`);
  }
  const r = spawnSync("git", ["branch", "-D", branch], { cwd: topLevel, encoding: "utf8" });
  if (r.status !== 0) {
    throw new GitError(`git branch -D ${branch} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
}

function isProcessAliveLocal(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true;
    return false;
  }
}

// --------------------------------------------------------------------------
// Prompts (Codex-facing; kept intentionally compact — the CLI's job is
// wiring, not prompt engineering)
// --------------------------------------------------------------------------

function buildGraderPrompt(requestBytes) {
  return [
    "You are the complexity grader for /contexthub:supervise, a token-efficient",
    "supervision transport. Read the implementation request below and produce",
    "ONLY the required --output-schema JSON (score, confidence, dimensions,",
    "reasons, risk_flags, unknowns, suggested_parallelism, relevant_paths,",
    "verification_hints). Do not write any code and do not modify anything.",
    "",
    "=== REQUEST ===",
    requestBytes.toString("utf8"),
  ].join("\n");
}

function buildWorkerPrompt(task) {
  const isCorrection = typeof task.session_policy === "string";
  const skills = isCorrection
    ? "test-driven-development, receiving-code-review, systematic-debugging (if you get stuck), and verification-before-completion"
    : "test-driven-development, systematic-debugging (if you get stuck), and verification-before-completion";
  return [
    `You are an isolated Codex worker executing exactly one ${isCorrection ? "correction " : ""}task ("${task.id}") in a`,
    "workspace-write sandbox confined to this worktree. Use the skills",
    `${skills}.`,
    "Do NOT use subagent-driven-development or any parallel-agent skill — you",
    "are the only worker in this worktree.",
    "",
    `Objective: ${task.objective}`,
    `Write paths (you may only modify these): ${task.write_paths.join(", ")}`,
    `Acceptance IDs you must satisfy: ${task.acceptance_ids.join(", ")}`,
    `Required verification command ids: ${task.verify.map((v) => v.id).join(", ")}`,
    "",
    "Produce ONLY the required --output-schema JSON worker report when done.",
  ].join("\n");
}

// --------------------------------------------------------------------------
// Run context resolution — every command after `init` starts here.
// --------------------------------------------------------------------------

async function resolveRunContext(runId, io) {
  const liveInfo = inspectRepository(io.cwd());
  const bootPaths = getRunPaths({ gitCommonDir: liveInfo.gitCommonDir }, runId);
  let preflight;
  try {
    preflight = JSON.parse(readFileSync(bootPaths.preflight, "utf8"));
  } catch (err) {
    throw new CliError(2, `no run "${runId}" found under ${liveInfo.gitCommonDir} (${err.code ?? err.message})`);
  }
  const repoInfo = inspectRepository(preflight.repo.topLevel);
  if (repoInfo.gitCommonDir !== liveInfo.gitCommonDir) {
    throw new CliError(1, `run "${runId}" belongs to a different repository (${repoInfo.gitCommonDir}) than the current working directory (${liveInfo.gitCommonDir})`);
  }
  const paths = getRunPaths(repoInfo, runId);
  const run = loadRun(repoInfo, runId);
  const worktreePaths = ensurePrivateWorktreeRoot(repoInfo, runId);
  return { repoInfo, paths, run, runId, preflight, worktreePaths, io };
}

// --------------------------------------------------------------------------
// Ledger readers
// --------------------------------------------------------------------------

function loadTaskGraph(ctx) {
  const raw = JSON.parse(readFileSync(ctx.paths.taskGraph, "utf8"));
  return validateTaskGraph(raw, { runId: ctx.runId, objectFormat: ctx.repoInfo.objectFormat });
}

function loadCorrectionGraph(ctx) {
  const raw = JSON.parse(readFileSync(ctx.paths.correctionGraph, "utf8"));
  const wave1 = loadTaskGraph(ctx);
  const waveOneTasksById = Object.fromEntries(wave1.tasks.map((t) => [t.id, t]));
  const acceptanceIds = wave1.acceptance.map((a) => a.id);
  const review = JSON.parse(readFileSync(ctx.paths.review, "utf8"));
  const nonSatisfiedAcceptanceIds = review.acceptance.filter((a) => a.status !== "SATISFIED").map((a) => a.id);
  return validateCorrectionGraph(raw, {
    runId: ctx.runId,
    objectFormat: ctx.repoInfo.objectFormat,
    expectedBaseCommit: ctx.run.wave1IntegrationHead,
    waveOneTasksById,
    acceptanceIds,
    nonSatisfiedAcceptanceIds,
    claudeScore: wave1.complexity_review.claude_score,
    approvalFlags: wave1.approval_flags,
  });
}

function loadApprovalsMap(ctx) {
  try {
    const data = JSON.parse(readFileSync(ctx.paths.approvals, "utf8"));
    const map = {};
    for (const f of data.flags ?? []) map[f.id] = f.status;
    return map;
  } catch {
    return {};
  }
}

function loadLatestReviewAcceptance(ctx) {
  const p = existsSync(ctx.paths.finalReview) ? ctx.paths.finalReview : ctx.paths.review;
  if (!existsSync(p)) return [];
  const data = JSON.parse(readFileSync(p, "utf8"));
  return data.acceptance ?? [];
}

function loadWaveSummaries(ctx) {
  const out = [];
  for (const [wave, p] of [[1, ctx.paths.checkpoint1], [2, ctx.paths.checkpoint2]]) {
    if (!existsSync(p)) continue;
    const cp = JSON.parse(readFileSync(p, "utf8"));
    out.push({ wave, integrationHead: cp.integration_head, taskCount: cp.tasks?.length ?? cp.counts?.taskCount ?? null });
  }
  return out;
}

function loadAllReceipts(ctx) {
  const dir = ctx.paths.receiptsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, n), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadWaveOneThreadIds(ctx) {
  const dir = ctx.paths.receiptsDir;
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("wave-1-") || !name.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (r.task_id && r.thread_id) out[r.task_id] = r.thread_id;
    } catch {
      // skip a corrupt receipt rather than fail the whole read
    }
  }
  return out;
}

function readPriorReadyReceipts(ctx, wave) {
  const dir = ctx.paths.receiptsDir;
  if (!existsSync(dir)) return [];
  const prefix = `wave-${wave}-`;
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (receipt.commit && receipt.ownership_valid === true) {
      out.push({ taskId: receipt.task_id, commit: receipt.commit });
    }
  }
  return out;
}

function readReceiptFor(ctx, wave, taskId) {
  const p = path.join(ctx.paths.receiptsDir, `wave-${wave}-${taskId}.json`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// BLOCKED transitions — every blocking path funnels through here so the
// evidence bytes are always written to disk (run.json only ever stores a
// hash of them) before the transition is recorded.
// --------------------------------------------------------------------------

async function transitionToBlocked(ctx, eventPartial, evidenceObj, reason) {
  const { repoInfo, runId, paths } = ctx;
  const bytes = Buffer.from(JSON.stringify(evidenceObj, null, 2), "utf8");
  mkdirSync(paths.reportsDir, { recursive: true });
  const evidencePath = path.join(paths.reportsDir, `${eventPartial.type.toLowerCase()}-block-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
  writeFileSync(evidencePath, bytes, { mode: 0o600 });
  const run = await updateRun(repoInfo, runId, { ...eventPartial, evidenceBytes: bytes, reason });
  return { run, evidencePath };
}

// --------------------------------------------------------------------------
// Checkpoint / receipt bookkeeping shared by run-wave and recover
// --------------------------------------------------------------------------

function countVerification(taskResults) {
  const counts = { PASS: 0, FAIL: 0, NOT_RUN: 0 };
  for (const r of taskResults) {
    for (const v of r.verify?.results ?? []) counts[v.status] = (counts[v.status] ?? 0) + 1;
  }
  return counts;
}

async function finalizeWaveResult(ctx, wave, waveResult) {
  const { paths } = ctx;
  mkdirSync(paths.receiptsDir, { recursive: true });
  for (const r of waveResult.taskResults) {
    const bytes = Buffer.from(JSON.stringify(r.receipt ?? {}, null, 2), "utf8");
    writeLedgerArtifactOverwrite(path.join(paths.receiptsDir, `wave-${wave}-${r.taskId}.json`), bytes);
  }
  const verificationCounts = countVerification(waveResult.taskResults);
  const usageTotals = summarizeUsage(waveResult.taskResults.map((r) => r.receipt).filter(Boolean));
  const tasksSummary = waveResult.taskResults.map((r) => ({
    id: r.taskId,
    status: r.status,
    commit: r.commit ?? null,
    summary: r.report?.summary ?? r.reason ?? "",
    concerns: r.report?.concerns ?? [],
  }));
  const checkpoint = buildCheckpoint({
    wave,
    integrationHead: waveResult.integrationHead,
    tasks: tasksSummary,
    verificationCounts,
    usageTotals,
    violations: waveResult.conflict ? [waveResult.conflict] : [],
    detailDir: paths.reportsDir,
  });
  writeCheckpoint(wave === 1 ? paths.checkpoint1 : paths.checkpoint2, checkpoint);
}

async function finishWaveOutcome(ctx, wave, result) {
  const { repoInfo, runId, paths } = ctx;
  await finalizeWaveResult(ctx, wave, result);

  if (result.waveOutcome === "PUBLISHED") {
    const eventType = wave === 1 ? "WAVE_1_COMPLETE" : "WAVE_2_COMPLETE";
    const run = await updateRun(repoInfo, runId, {
      type: eventType,
      checkpointRef: wave === 1 ? "checkpoint-1.json" : "checkpoint-2.json",
      ...(wave === 1 ? { integrationHead: result.integrationHead } : {}),
    });
    return {
      run_id: runId,
      phase: run.phase,
      artifact: wave === 1 ? paths.checkpoint1 : paths.checkpoint2,
      next: wave === 1 ? "accept-review" : "accept-final-review",
    };
  }

  const evidence = {
    stage: `wave-${wave}`,
    waveOutcome: result.waveOutcome,
    failedTaskIds: result.failedTaskIds,
    conflict: result.conflict,
    integrationError: result.integrationError ?? null,
  };
  const { run, evidencePath } = await transitionToBlocked(ctx, { type: "BLOCK" }, evidence, `wave ${wave} did not publish (${result.waveOutcome})`);
  throw new CliError(1, `run-wave: wave ${wave} blocked (${result.waveOutcome})`, {
    run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover",
  });
}

// --------------------------------------------------------------------------
// performGrading / performWave / performVerify — reusable across the direct
// commands and `recover`.
// --------------------------------------------------------------------------

async function performGrading(ctx, { armed = false } = {}) {
  const { repoInfo, runId, paths, io } = ctx;
  mkdirSync(paths.logsDir, { recursive: true });
  const requestBytes = readFileSync(paths.request);
  const prompt = buildGraderPrompt(requestBytes);
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const outputPath = path.join(paths.logsDir, `grader-${stamp}.output.json`);
  const logPath = path.join(paths.logsDir, `grader-${stamp}.log`);

  // Capture the real child pid the moment codex.mjs:runCodex spawns it —
  // Promise executors run SYNCHRONOUSLY, so by the time runCodex(...) has
  // returned its pending promise to us, spawnImpl has already been called
  // (or never will be, if pre-spawn validation rejected first). This lets
  // beginTrackedOperation persist a REAL child pid before the (up to 180s)
  // grading call completes, with no polling and no timing dependency.
  let capturedChild = null;
  const spawnImpl = (...spawnArgs) => {
    capturedChild = spawn(...spawnArgs);
    return capturedChild;
  };

  const graderPromise = runCodex({
    cwd: repoInfo.topLevel,
    prompt,
    schemaPath: COMPLEXITY_SCHEMA_PATH,
    outputPath,
    logPath,
    model: CODEX_MODEL,
    effort: "medium",
    sandbox: "read-only",
    codexBin: io.env.CODEX_BIN || "codex",
    env: io.env,
    spawnImpl,
  });

  if (!armed) {
    await beginTrackedOperation({
      updateRunFn: (event) => updateRun(repoInfo, runId, event),
      eventType: "START_GRADING",
      kind: "grader",
      spawnChild: async () => {
        if (!capturedChild || !Number.isInteger(capturedChild.pid)) {
          await graderPromise.catch(() => {});
          throw new CliError(1, "grade: the grader did not spawn a process (pre-spawn validation likely rejected the call)");
        }
        return { pid: capturedChild.pid };
      },
    });
  }

  const result = await graderPromise;

  if (result.failureCategory) {
    const evidence = { stage: "grading", failureCategory: result.failureCategory, exitCode: result.exitCode, logPath: result.logPath };
    const { run, evidencePath } = await transitionToBlocked(ctx, { type: "BLOCK" }, evidence, `grading failed: ${result.failureCategory}`);
    throw new CliError(1, `grade: grading failed (${result.failureCategory})`, { run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover" });
  }

  const rawOutput = readFileSync(result.finalOutputPath);
  let parsed;
  try {
    parsed = JSON.parse(rawOutput.toString("utf8"));
  } catch (err) {
    const { run, evidencePath } = await transitionToBlocked(ctx, { type: "BLOCK" }, { stage: "grading", reason: "invalid-json", message: err.message }, "grader output was not valid JSON");
    throw new CliError(1, "grade: grader output was not valid JSON", { run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover" });
  }
  try {
    validateComplexity(parsed);
  } catch (err) {
    const { run, evidencePath } = await transitionToBlocked(ctx, { type: "BLOCK" }, { stage: "grading", reason: "contract-violation", message: err.message }, "grader output failed contract validation");
    throw new CliError(1, "grade: grader output failed contract validation", { run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover" });
  }

  writeLedgerArtifactExclusive(paths.complexity, rawOutput);
  const run = await updateRun(repoInfo, runId, { type: "GRADING_COMPLETE", complexityRef: "complexity.json" });
  return { run_id: runId, phase: run.phase, artifact: paths.complexity, next: "accept-plan" };
}

async function performWave(ctx, wave, { armed = false, tasksOverride = null, allowBaseDrift = false } = {}) {
  const { repoInfo, runId, paths, preflight, worktreePaths, io } = ctx;
  const graph = wave === 1 ? loadTaskGraph(ctx) : loadCorrectionGraph(ctx);
  const tasks = tasksOverride ?? getRunnableTasks(graph, [], wave);
  if (tasks.length === 0) {
    return { skipped: true, graph };
  }
  const approvals = loadApprovalsMap(ctx);
  const baseCommit = wave === 1 ? ctx.run.baseCommit : ctx.run.wave1IntegrationHead;
  const resumeThreadIdByTaskId = wave === 2 ? loadWaveOneThreadIds(ctx) : {};
  const runWorker = buildCodexWorker({
    schemaPath: WORKER_REPORT_SCHEMA_PATH,
    buildPrompt: buildWorkerPrompt,
    logsDir: paths.logsDir,
    model: CODEX_MODEL,
    preflight: preflight.codex,
    resumeThreadIdFor: (task) => resumeThreadIdByTaskId[task.source_task_id] ?? null,
    codexBin: io.env.CODEX_BIN || "codex",
    env: io.env,
  });
  const resumeExactMap = {};
  if (wave === 2) {
    for (const t of graph.tasks) {
      if (effectiveSessionPolicy(t, preflight.codex) === "resume-exact") resumeExactMap[t.id] = t.source_task_id;
    }
  }
  const operationTracking = armed ? undefined : {
    updateRunFn: (event) => updateRun(repoInfo, runId, event),
    eventType: wave === 1 ? "RUN_WAVE_1" : "RUN_WAVE_2",
    kind: `wave-${wave}`,
  };
  const result = await executeWave({
    repoInfo,
    runId,
    wave,
    tasks,
    baseCommit,
    worktreePaths,
    concurrency: recommendedConcurrency(graph.complexity_review?.claude_score ?? 3),
    integrationWorktreePath: worktreePaths.integration,
    runWorker,
    approvals,
    logsDir: paths.logsDir,
    resumeExactMap,
    operationTracking,
    allowBaseDrift,
  });
  return { skipped: false, result, graph };
}

async function performVerify(ctx, { armed = false } = {}) {
  const { repoInfo, runId, paths, worktreePaths } = ctx;
  if (!armed) {
    if (ctx.run.phase === Phase.CORRECTIONS_REVIEWED) {
      await beginTrackedOperation({
        updateRunFn: (event) => updateRun(repoInfo, runId, event),
        eventType: "START_VERIFY",
        kind: "verify",
        spawnChild: () => ({ pid: process.pid }),
      });
    }
    // else: ctx.run.phase === VERIFYING already (entered via ACCEPT_REVIEW's
    // no-gap branch) — no transition needed, per carry-forward #2.
  }

  const graph = loadTaskGraph(ctx);
  const approvals = loadApprovalsMap(ctx);
  const before = { head: readHead(worktreePaths.integration), clean: isWorktreeClean(worktreePaths.integration) };
  const results = await runVerificationSet({
    commands: graph.final_verification,
    worktreePath: worktreePaths.integration,
    approvals,
    logDir: path.join(paths.logsDir, "final-verification"),
    logPrefix: "final",
    snapshotBefore: before,
    snapshotAfterFn: () => ({ head: readHead(worktreePaths.integration), clean: isWorktreeClean(worktreePaths.integration) }),
  });

  const acceptance = loadLatestReviewAcceptance(ctx);
  const waveSummaries = loadWaveSummaries(ctx);
  const usageTotals = summarizeUsage(loadAllReceipts(ctx));
  const receipt = buildFinalReceipt({
    integrationHead: before.head,
    finalVerification: results.results,
    acceptanceMatrix: acceptance,
    usageTotals,
    waveSummaries,
    violations: results.residue ? [{ reason: "verification-residue" }] : [],
    detailDir: paths.reportsDir,
  });

  if (!results.allPass) {
    const evidence = { stage: "verify", results: results.results, residue: results.residue };
    const { run, evidencePath } = await transitionToBlocked(ctx, { type: "VERIFY_COMPLETE", success: false }, evidence, "final verification failed");
    throw new CliError(1, "verify: final verification failed", { run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover" });
  }

  writeCheckpoint(paths.final, receipt);
  const run = await updateRun(repoInfo, runId, { type: "VERIFY_COMPLETE", success: true, resultsRef: "final.json" });
  return { run_id: runId, phase: run.phase, artifact: paths.final, next: "choose-finish" };
}

// --------------------------------------------------------------------------
// integrateExistingCommits — used by recover to publish previously-completed
// task commits without re-invoking their workers (carry-forward #7).
// --------------------------------------------------------------------------

async function integrateExistingCommits({ repoInfo, runId, wave, worktreePaths, integrationWorktreePath, commits, logsDir }) {
  const sorted = [...commits].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const preHead = readHead(integrationWorktreePath);
  const candidate = createCandidateIntegration({ repoInfo, runId, worktreePaths, wave, integrationHead: preHead });
  const integratedTaskIds = [];
  let conflict = null;
  for (const { taskId, commit } of sorted) {
    const pick = integrateCandidateCommit({ candidate, commit });
    if (!pick.ok) {
      conflict = { taskId, commit, stderr: pick.stderr };
      break;
    }
    integratedTaskIds.push(taskId);
  }
  if (conflict) {
    const logPath = path.join(logsDir, `candidate-w${wave}-recover-conflict.log`);
    abortCandidateIntegration({ repoInfo, candidate, logPath, reason: `recovery cherry-pick conflict on task "${conflict.taskId}"` });
    return { published: false, conflict, integrationHead: preHead, integratedTaskIds: [] };
  }
  const publish = publishCandidateIntegration({ repoInfo, integrationWorktreePath, candidate, expectedPreHead: preHead });
  return { published: true, integrationHead: publish.head, integratedTaskIds };
}

async function recoverWave(ctx, wave) {
  const { repoInfo, runId, paths, worktreePaths } = ctx;
  const graph = wave === 1 ? loadTaskGraph(ctx) : loadCorrectionGraph(ctx);
  const priorReady = readPriorReadyReceipts(ctx, wave);
  const notYetIntegrated = priorReady.filter(
    (r) => !isCommitIntegrated({ repoInfo, ref: integrationBranchName(runId), commit: r.commit }),
  );

  // Clear any leftover candidate from the crashed attempt first, or the
  // ledger idempotency gate rejects a fresh candidate as an unexplained
  // collision.
  const leftoverCandidatePath = worktreePaths.candidatePath(wave);
  if (existsSync(leftoverCandidatePath)) {
    try {
      abortCandidateIntegration({
        repoInfo,
        candidate: { path: leftoverCandidatePath, branch: candidateBranchName(runId, wave) },
        reason: "leftover candidate from an interrupted wave, cleared during recovery",
      });
    } catch (err) {
      throw new CliError(1, `recover: could not clean up a leftover candidate integration for wave ${wave}: ${err.message}`);
    }
  }

  let integrationHead = readHead(worktreePaths.integration);
  if (notYetIntegrated.length > 0) {
    const pick = await integrateExistingCommits({
      repoInfo, runId, wave, worktreePaths,
      integrationWorktreePath: worktreePaths.integration,
      commits: notYetIntegrated, logsDir: paths.logsDir,
    });
    if (!pick.published) {
      const evidence = { stage: `wave-${wave}-recovery-integration`, conflict: pick.conflict };
      const { run, evidencePath } = await transitionToBlocked(ctx, { type: "BLOCK" }, evidence, `recovery could not re-integrate previously completed wave ${wave} commits`);
      throw new CliError(1, "recover: recovery integration conflict", { run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover" });
    }
    integrationHead = pick.integrationHead;
  }

  const readyIds = priorReady.map((r) => r.taskId);
  const remaining = getRunnableTasks(graph, readyIds, wave);
  const readyResultsFromReceipts = priorReady.map((r) => ({
    taskId: r.taskId, status: "READY", commit: r.commit, receipt: readReceiptFor(ctx, wave, r.taskId),
  }));

  if (remaining.length === 0) {
    const fauxResult = {
      wave,
      taskResults: readyResultsFromReceipts,
      integratedTaskIds: readyIds,
      readyTaskIds: readyIds,
      failedTaskIds: [],
      integrationHead,
      published: true,
      conflict: null,
      waveOutcome: "PUBLISHED",
    };
    return await finishWaveOutcome(ctx, wave, fauxResult);
  }

  const { result } = await performWave(ctx, wave, {
    armed: true,
    tasksOverride: remaining,
    allowBaseDrift: integrationHead !== (wave === 1 ? ctx.run.baseCommit : ctx.run.wave1IntegrationHead),
  });
  const combined = {
    ...result,
    taskResults: [...readyResultsFromReceipts, ...result.taskResults],
    integratedTaskIds: [...readyIds, ...result.integratedTaskIds],
    readyTaskIds: [...readyIds, ...result.readyTaskIds],
  };
  return await finishWaveOutcome(ctx, wave, combined);
}

// --------------------------------------------------------------------------
// Command: init
// --------------------------------------------------------------------------

function readInitRequestBytes(args, io) {
  if (args["request-file"]) {
    return readOpaqueFile(path.resolve(args["request-file"]), REQUEST_MAX_BYTES, "--request-file");
  }
  if (args.stdin) {
    const raw = io.stdin;
    if (typeof raw === "string") return Buffer.from(raw, "utf8");
    if (Buffer.isBuffer(raw)) return raw;
    throw new CliError(2, "init --stdin requires io.stdin to already contain a string or Buffer (test harness only)");
  }
  throw new CliError(2, "init requires --request-file <path> (reading from stdin is a test-only path, not the production path)");
}

async function cmdInit(args, io) {
  const requestBytes = readInitRequestBytes(args, io);

  // Full preflight BEFORE any mutation: Git, Codex, auth, Superpowers, and a
  // usable Git author/committer identity.
  const repoInfoLive = inspectRepository(io.cwd());
  if (!repoInfoLive.identityOk) {
    throw new CliError(1, `init: ${repoInfoLive.prerequisiteError}`);
  }
  const codexBin = io.env.CODEX_BIN || "codex";
  const codexEvidence = await checkCodexPrerequisites({ codexBin, cwd: io.cwd(), env: io.env });
  if (!codexEvidence.ok) {
    throw new CliError(1, `init: Codex preflight failed (${codexEvidence.failureCategory}): ${codexEvidence.message}`);
  }

  // First mutation: allocate the run ledger.
  const run = createRun({ repoInfo: repoInfoLive });
  const paths = getRunPaths(repoInfoLive, run.runId);

  writeLedgerArtifactExclusive(paths.request, requestBytes);

  const worktreePaths = ensurePrivateWorktreeRoot(repoInfoLive, run.runId);
  createIntegrationWorktree({ repoInfo: repoInfoLive, runId: run.runId, worktreePaths });

  const preflightRecord = {
    version: 1,
    repo: {
      topLevel: repoInfoLive.topLevel,
      gitDir: repoInfoLive.gitDir,
      gitCommonDir: repoInfoLive.gitCommonDir,
      objectFormat: repoInfoLive.objectFormat,
      isLinkedWorktree: repoInfoLive.isLinkedWorktree,
    },
    codex: codexEvidence,
    integrationWorktree: worktreePaths.integration,
    createdAt: new Date().toISOString(),
  };
  writeLedgerArtifactExclusive(paths.preflight, Buffer.from(JSON.stringify(preflightRecord, null, 2), "utf8"));

  return {
    run_id: run.runId,
    phase: run.phase,
    artifact: paths.preflight,
    integration_worktree: worktreePaths.integration,
    next: "grade",
  };
}

// --------------------------------------------------------------------------
// Command: grade
// --------------------------------------------------------------------------

async function cmdGrade(args, io) {
  requireArg(args, "run", "--run <run-id>");
  const ctx = await resolveRunContext(args.run, io);
  if (ctx.run.phase !== Phase.INITIALIZED) {
    throw new CliError(2, `grade: run "${args.run}" is in phase "${ctx.run.phase}", expected "INITIALIZED" — phases cannot be skipped`);
  }
  return await performGrading(ctx, { armed: false });
}

// --------------------------------------------------------------------------
// Command: accept-plan
// --------------------------------------------------------------------------

async function cmdAcceptPlan(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "plan-file", "--plan-file <path>");
  requireArg(args, "graph-file", "--graph-file <path>");
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths, worktreePaths } = ctx;
  if (ctx.run.phase !== Phase.GRADED) {
    throw new CliError(2, `accept-plan: run "${args.run}" is in phase "${ctx.run.phase}", expected "GRADED"`);
  }

  const integrationWorktreePath = worktreePaths.integration;
  const planAbs = path.resolve(args["plan-file"]);
  const realIntegration = realpathSync(integrationWorktreePath);
  let realPlan;
  try {
    realPlan = realpathSync(planAbs);
  } catch (err) {
    throw new CliError(2, `accept-plan: --plan-file "${args["plan-file"]}" does not exist (${err.code ?? err.message})`);
  }
  if (realPlan !== realIntegration && !realPlan.startsWith(realIntegration + path.sep)) {
    throw new CliError(2, `accept-plan: --plan-file must resolve inside the integration worktree (${integrationWorktreePath})`);
  }
  if (!isWorktreeClean(integrationWorktreePath)) {
    throw new CliError(2, "accept-plan: the integration worktree is not clean — commit the plan before calling accept-plan");
  }
  const relPlanPath = realPlan.slice(realIntegration.length).replace(/^[/\\]/, "");
  if (!isPathTrackedAtHead(integrationWorktreePath, relPlanPath)) {
    throw new CliError(2, `accept-plan: --plan-file "${relPlanPath}" is not tracked by the integration worktree's HEAD`);
  }
  const baseCommit = readHead(integrationWorktreePath);

  const planBytes = readOpaqueFile(planAbs, PLAN_MAX_BYTES, "--plan-file");
  const graphBytes = readOpaqueFile(path.resolve(args["graph-file"]), GRAPH_MAX_BYTES, "--graph-file");

  let graph;
  try {
    graph = JSON.parse(graphBytes.toString("utf8"));
  } catch (err) {
    throw new CliError(2, `accept-plan: --graph-file is not valid JSON: ${err.message}`);
  }
  validateTaskGraph(graph, { runId, objectFormat: repoInfo.objectFormat });
  if (graph.base_commit !== baseCommit) {
    throw new CliError(2, `accept-plan: task graph base_commit "${graph.base_commit}" does not match the clean integration HEAD "${baseCommit}"`);
  }

  writeLedgerArtifactOverwrite(paths.plan, planBytes);
  writeLedgerArtifactOverwrite(paths.taskGraph, graphBytes);
  writeLedgerArtifactOverwrite(paths.approvals, Buffer.from(JSON.stringify({ run_id: runId, flags: graph.approval_flags }, null, 2), "utf8"));

  const approvalIds = graph.approval_flags.map((f) => f.id);
  const run = await updateRun(repoInfo, runId, { type: "ACCEPT_PLAN", baseCommit, approvalIds });
  return {
    run_id: runId,
    phase: run.phase,
    artifact: paths.taskGraph,
    next: run.phase === Phase.APPROVAL_PENDING ? "decide-approval" : "run-wave --wave 1",
  };
}

// --------------------------------------------------------------------------
// Command: decide-approval
// --------------------------------------------------------------------------

function updateApprovalsLedger(ctx, id, decision, evidencePath) {
  const data = JSON.parse(readFileSync(ctx.paths.approvals, "utf8"));
  const flags = (data.flags ?? []).map((f) => (f.id === id
    ? { ...f, status: decision, decided_at: new Date().toISOString(), evidence_paths: [...(f.evidence_paths ?? []), evidencePath] }
    : f));
  writeLedgerArtifactOverwrite(ctx.paths.approvals, Buffer.from(JSON.stringify({ run_id: ctx.runId, flags }, null, 2), "utf8"));
}

async function cmdDecideApproval(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "id", "--id <approval-id>");
  requireArg(args, "decision", "--decision <approve|reject>");
  requireArg(args, "evidence-file", "--evidence-file <path>");
  if (args.decision !== "approve" && args.decision !== "reject") {
    throw new CliError(2, 'decide-approval: --decision must be "approve" or "reject"');
  }
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths } = ctx;
  if (ctx.run.phase !== Phase.APPROVAL_PENDING) {
    throw new CliError(2, `decide-approval: run "${args.run}" is in phase "${ctx.run.phase}", expected "APPROVAL_PENDING"`);
  }
  validateIdentifier("approval", args.id);

  const evidenceBytes = readOpaqueFile(path.resolve(args["evidence-file"]), EVIDENCE_MAX_BYTES, "--evidence-file");
  mkdirSync(paths.reportsDir, { recursive: true });
  const evidenceDest = path.join(paths.reportsDir, `approval-${args.id}-${args.decision}.evidence`);
  writeLedgerArtifactExclusive(evidenceDest, evidenceBytes);

  const decision = args.decision === "approve" ? "APPROVED" : "REJECTED";
  const run = await updateRun(repoInfo, runId, { type: "DECIDE_APPROVAL", id: args.id, decision });
  updateApprovalsLedger(ctx, args.id, decision, evidenceDest);

  return {
    run_id: runId,
    phase: run.phase,
    artifact: paths.approvals,
    next: run.phase === Phase.PLANNED ? "run-wave --wave 1" : run.phase === Phase.GRADED ? "accept-plan" : "decide-approval",
  };
}

// --------------------------------------------------------------------------
// Command: run-wave
// --------------------------------------------------------------------------

async function cmdRunWave(args, io) {
  requireArg(args, "run", "--run <run-id>");
  const waveNum = Number(args.wave);
  if (waveNum !== 1 && waveNum !== 2) {
    throw new CliError(2, "run-wave: --wave must be 1 or 2 (no third wave is representable)");
  }
  const ctx = await resolveRunContext(args.run, io);
  const requiredPhase = waveNum === 1 ? Phase.PLANNED : Phase.REVIEWED;
  if (ctx.run.phase !== requiredPhase) {
    throw new CliError(2, `run-wave: run "${args.run}" is in phase "${ctx.run.phase}", expected "${requiredPhase}" for wave ${waveNum} — phases cannot be skipped`);
  }
  const { result } = await performWave(ctx, waveNum, {});
  return await finishWaveOutcome(ctx, waveNum, result);
}

// --------------------------------------------------------------------------
// Command: accept-review — carry-forward #1: branch on the gap
// determination BEFORE building the event.
// --------------------------------------------------------------------------

async function cmdAcceptReview(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "review-file", "--review-file <path>");
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths } = ctx;
  if (ctx.run.phase !== Phase.WAVE_1_COMPLETE) {
    throw new CliError(2, `accept-review: run "${args.run}" is in phase "${ctx.run.phase}", expected "WAVE_1_COMPLETE"`);
  }

  const graph = loadTaskGraph(ctx);
  const acceptanceIds = graph.acceptance.map((a) => a.id);

  const reviewBytes = readOpaqueFile(path.resolve(args["review-file"]), EVIDENCE_MAX_BYTES, "--review-file");
  let reviewObj;
  try {
    reviewObj = JSON.parse(reviewBytes.toString("utf8"));
  } catch (err) {
    throw new CliError(2, `accept-review: --review-file is not valid JSON: ${err.message}`);
  }
  validateClaudeReview(reviewObj, { acceptanceIds, stage: "wave-one" });
  writeLedgerArtifactExclusive(paths.review, reviewBytes);

  // Conservative gap determination: GAP or UNCERTAIN both require a
  // correction wave. Only every criterion reported SATISFIED proceeds
  // straight to verification.
  const hasGaps = reviewObj.acceptance.some((a) => a.status !== "SATISFIED");

  // ---- BRANCH BEFORE BUILDING THE EVENT (carry-forward #1). ----
  if (hasGaps) {
    if (!args["correction-graph-file"]) {
      throw new CliError(2, "accept-review: --correction-graph-file is required because the review reports a gap or uncertain item");
    }
    const nonSatisfiedAcceptanceIds = reviewObj.acceptance.filter((a) => a.status !== "SATISFIED").map((a) => a.id);
    const waveOneTasksById = Object.fromEntries(graph.tasks.map((t) => [t.id, t]));
    const graphBytes = readOpaqueFile(path.resolve(args["correction-graph-file"]), GRAPH_MAX_BYTES, "--correction-graph-file");
    let correctionGraph;
    try {
      correctionGraph = JSON.parse(graphBytes.toString("utf8"));
    } catch (err) {
      throw new CliError(2, `accept-review: --correction-graph-file is not valid JSON: ${err.message}`);
    }
    validateCorrectionGraph(correctionGraph, {
      runId,
      objectFormat: repoInfo.objectFormat,
      expectedBaseCommit: ctx.run.wave1IntegrationHead,
      waveOneTasksById,
      acceptanceIds,
      nonSatisfiedAcceptanceIds,
      claudeScore: graph.complexity_review.claude_score,
      approvalFlags: graph.approval_flags,
    });
    writeLedgerArtifactExclusive(paths.correctionGraph, graphBytes);

    // No operation: this edge does not launch a child.
    const run = await updateRun(repoInfo, runId, {
      type: "ACCEPT_REVIEW", reviewRef: "review.json", hasGaps: true, correctionGraphRef: "correction-graph.json",
    });
    return { run_id: runId, phase: run.phase, artifact: paths.correctionGraph, next: "run-wave --wave 2" };
  }

  if (args["correction-graph-file"]) {
    throw new CliError(2, "accept-review: --correction-graph-file must not be supplied when the review has no gaps");
  }
  // No-gap branch enters VERIFYING directly — a child-launch boundary just
  // like START_VERIFY, so it requires operation metadata (carry-forward #4:
  // host-scoped pid, reusing beginTrackedOperation unmodified).
  const { run } = await beginTrackedOperation({
    updateRunFn: (event) => updateRun(repoInfo, runId, event),
    eventType: "ACCEPT_REVIEW",
    kind: "verify",
    buildEventExtras: () => ({ reviewRef: "review.json", hasGaps: false }),
    spawnChild: () => ({ pid: process.pid }),
  });
  return { run_id: runId, phase: run.phase, artifact: paths.review, next: "verify" };
}

// --------------------------------------------------------------------------
// Command: accept-final-review
// --------------------------------------------------------------------------

async function cmdAcceptFinalReview(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "review-file", "--review-file <path>");
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths } = ctx;
  if (ctx.run.phase !== Phase.WAVE_2_COMPLETE) {
    throw new CliError(2, `accept-final-review: run "${args.run}" is in phase "${ctx.run.phase}", expected "WAVE_2_COMPLETE"`);
  }
  const graph = loadTaskGraph(ctx);
  const acceptanceIds = graph.acceptance.map((a) => a.id);

  const reviewBytes = readOpaqueFile(path.resolve(args["review-file"]), EVIDENCE_MAX_BYTES, "--review-file");
  let reviewObj;
  try {
    reviewObj = JSON.parse(reviewBytes.toString("utf8"));
  } catch (err) {
    throw new CliError(2, `accept-final-review: --review-file is not valid JSON: ${err.message}`);
  }
  validateClaudeReview(reviewObj, { acceptanceIds, stage: "post-correction" });
  writeLedgerArtifactExclusive(paths.finalReview, reviewBytes);

  const allSatisfied = reviewObj.acceptance.every((a) => a.status === "SATISFIED");
  if (allSatisfied) {
    const run = await updateRun(repoInfo, runId, { type: "ACCEPT_FINAL_REVIEW", allSatisfied: true, finalReviewRef: "final-review.json" });
    return { run_id: runId, phase: run.phase, artifact: paths.finalReview, next: "verify" };
  }
  const evidence = { stage: "final-review", blocked: reviewObj.acceptance.filter((a) => a.status !== "SATISFIED") };
  const { run, evidencePath } = await transitionToBlocked(ctx, { type: "ACCEPT_FINAL_REVIEW", allSatisfied: false }, evidence, "post-correction review reported a BLOCKED acceptance criterion");
  throw new CliError(1, "accept-final-review: a criterion is BLOCKED after the correction wave — never a third wave", { run_id: runId, phase: run.phase, artifact: evidencePath, next: "recover" });
}

// --------------------------------------------------------------------------
// Command: verify
// --------------------------------------------------------------------------

async function cmdVerify(args, io) {
  requireArg(args, "run", "--run <run-id>");
  const ctx = await resolveRunContext(args.run, io);
  if (ctx.run.phase !== Phase.CORRECTIONS_REVIEWED && ctx.run.phase !== Phase.VERIFYING) {
    throw new CliError(2, `verify: run "${args.run}" is in phase "${ctx.run.phase}", expected "CORRECTIONS_REVIEWED" or "VERIFYING"`);
  }
  return await performVerify(ctx, { armed: false });
}

// --------------------------------------------------------------------------
// Command: status
// --------------------------------------------------------------------------

async function cmdStatus(args, io) {
  requireArg(args, "run", "--run <run-id>");
  const ctx = await resolveRunContext(args.run, io);
  return { run_id: ctx.runId, phase: ctx.run.phase, artifact: null, next: NEXT_COMMAND[ctx.run.phase] ?? null };
}

// --------------------------------------------------------------------------
// Command: block
// --------------------------------------------------------------------------

async function cmdBlock(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "evidence-file", "--evidence-file <path>");
  const ctx = await resolveRunContext(args.run, io);
  const bytes = readOpaqueFile(path.resolve(args["evidence-file"]), EVIDENCE_MAX_BYTES, "--evidence-file");
  mkdirSync(ctx.paths.reportsDir, { recursive: true });
  const destPath = path.join(ctx.paths.reportsDir, `manual-block-${Date.now()}.evidence`);
  writeLedgerArtifactExclusive(destPath, bytes);
  const run = await updateRun(ctx.repoInfo, ctx.runId, { type: "BLOCK", evidenceBytes: bytes, reason: "operator-initiated block via CLI" });
  throw new CliError(1, "block: run is now BLOCKED", { run_id: ctx.runId, phase: run.phase, artifact: destPath, next: "recover" });
}

// --------------------------------------------------------------------------
// Command: recover
// --------------------------------------------------------------------------

async function cmdRecover(args, io) {
  requireArg(args, "run", "--run <run-id>");
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths, run } = ctx;

  let workingCtx = ctx;

  if (run.phase === Phase.BLOCKED) {
    if (!args["changed-condition-file"]) {
      throw new CliError(2, "recover: --changed-condition-file is required to recover from BLOCKED");
    }
    const bytes = readOpaqueFile(path.resolve(args["changed-condition-file"]), EVIDENCE_MAX_BYTES, "--changed-condition-file");
    mkdirSync(paths.changedConditionsDir, { recursive: true });
    const destPath = path.join(paths.changedConditionsDir, `condition-${Date.now()}.json`);
    writeLedgerArtifactExclusive(destPath, bytes);
    let recoveredRun;
    try {
      recoveredRun = await updateRun(repoInfo, runId, {
        type: "RECOVER_FROM_BLOCKED", priorPhase: run.blockedFrom, changedConditionBytes: bytes,
      });
    } catch (err) {
      throw new CliError(1, `recover: ${err.message}`);
    }
    workingCtx = { ...ctx, run: recoveredRun };
  }

  const phase = workingCtx.run.phase;
  if (!RUNNING_PHASES.has(phase)) {
    return { run_id: runId, phase, artifact: null, next: NEXT_COMMAND[phase] ?? null };
  }

  const priorPid = workingCtx.run.operation?.pid ?? null;
  if (priorPid && isProcessAliveLocal(priorPid)) {
    throw new CliError(1, `recover: the previously recorded operation (pid ${priorPid}) is still running; refusing to recover a live operation`);
  }
  const reconciledRun = await updateRun(repoInfo, runId, {
    type: "RECOVER_INTERRUPTED",
    reconciliation: { processes: true, receipts: true, worktrees: true, integrationHead: true },
    operation: { pid: process.pid, startedAt: new Date().toISOString(), kind: `recover-${phase.toLowerCase()}` },
  });
  workingCtx = { ...workingCtx, run: reconciledRun };

  if (phase === Phase.GRADING) {
    return await performGrading(workingCtx, { armed: true });
  }
  if (phase === Phase.VERIFYING) {
    return await performVerify(workingCtx, { armed: true });
  }
  const wave = phase === Phase.WAVE_1_RUNNING ? 1 : 2;
  return await recoverWave(workingCtx, wave);
}

// --------------------------------------------------------------------------
// Command: choose-finish
// --------------------------------------------------------------------------

async function cmdChooseFinish(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "choice", "--choice <keep|merge|push|pr|discard>");
  requireArg(args, "decision-file", "--decision-file <path>");
  if (!FINISH_CHOICES.has(args.choice)) {
    throw new CliError(2, `choose-finish: --choice must be one of ${[...FINISH_CHOICES].join("|")}`);
  }
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths } = ctx;
  if (ctx.run.phase !== Phase.FINISH_PENDING) {
    throw new CliError(2, `choose-finish: run "${args.run}" is in phase "${ctx.run.phase}", expected "FINISH_PENDING"`);
  }
  const bytes = readOpaqueFile(path.resolve(args["decision-file"]), EVIDENCE_MAX_BYTES, "--decision-file");
  let decision = {};
  try {
    decision = JSON.parse(bytes.toString("utf8"));
  } catch {
    // target stays null if the decision file is not JSON
  }
  writeLedgerArtifactExclusive(paths.finishChoice, bytes);

  const run = await updateRun(repoInfo, runId, { type: "CHOOSE_FINISH", choice: args.choice, target: decision.target ?? null });
  const next = args.choice === "keep"
    ? "complete-finish"
    : args.choice === "discard"
      ? "cleanup --mode discard (from the original repository)"
      : "perform the recorded action, then complete-finish";
  return { run_id: runId, phase: run.phase, artifact: paths.finishChoice, next };
}

// --------------------------------------------------------------------------
// Command: complete-finish
// --------------------------------------------------------------------------

async function cmdCompleteFinish(args, io) {
  requireArg(args, "run", "--run <run-id>");
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths, worktreePaths, run } = ctx;
  if (run.phase !== Phase.FINISH_ACTION_PENDING) {
    throw new CliError(2, `complete-finish: run "${args.run}" is in phase "${run.phase}", expected "FINISH_ACTION_PENDING"`);
  }
  if (!run.finish || run.finish.choice === "discard") {
    throw new CliError(2, 'complete-finish: not valid for choice "discard" — use `cleanup --mode discard` from the original repository');
  }

  const integrationWorktreePath = worktreePaths.integration;
  const cleanNow = existsSync(integrationWorktreePath) && isWorktreeClean(integrationWorktreePath);
  let success = cleanNow;
  const detail = { choice: run.finish.choice, target: run.finish.target, cleanIntegrationWorktree: cleanNow };

  if (run.finish.choice !== "keep") {
    if (!args["evidence-file"]) {
      success = false;
      detail.reason = "missing-evidence-file";
    } else {
      const evBytes = readOpaqueFile(path.resolve(args["evidence-file"]), EVIDENCE_MAX_BYTES, "--evidence-file");
      let evObj = {};
      try {
        evObj = JSON.parse(evBytes.toString("utf8"));
      } catch {
        // leave as {}
      }
      detail.evidence = evObj;
      if (success && run.finish.target) {
        success = isAncestorOf(integrationWorktreePath, readHead(integrationWorktreePath), run.finish.target);
        if (!success) detail.reason = `integration HEAD is not yet reachable from target "${run.finish.target}"`;
      }
    }
  }

  const evidenceBytes = Buffer.from(JSON.stringify(detail, null, 2), "utf8");
  mkdirSync(paths.reportsDir, { recursive: true });
  const evidenceDest = path.join(paths.reportsDir, `finish-evidence-${Date.now()}.json`);
  writeFileSync(evidenceDest, evidenceBytes, { mode: 0o600 });

  const updated = await updateRun(repoInfo, runId, { type: "COMPLETE_FINISH", success, evidenceRef: evidenceDest });
  writeLedgerArtifactOverwrite(paths.finishEvidence, evidenceBytes);
  if (!success) {
    throw new CliError(1, `complete-finish: verification failed (${detail.reason ?? "not clean"})`, {
      run_id: runId, phase: updated.phase, artifact: evidenceDest, next: "complete-finish (retry after fixing the recorded action)",
    });
  }
  return { run_id: runId, phase: updated.phase, artifact: paths.finishEvidence, next: "(done)" };
}

// --------------------------------------------------------------------------
// Command: cleanup
// --------------------------------------------------------------------------

async function cmdCleanup(args, io) {
  requireArg(args, "run", "--run <run-id>");
  requireArg(args, "mode", "--mode <discard|post-complete>");
  requireArg(args, "decision-file", "--decision-file <path>");
  if (args.mode !== "discard" && args.mode !== "post-complete") {
    throw new CliError(2, 'cleanup: --mode must be "discard" or "post-complete"');
  }
  const ctx = await resolveRunContext(args.run, io);
  const { repoInfo, runId, paths, worktreePaths, run } = ctx;
  const decisionBytes = readOpaqueFile(path.resolve(args["decision-file"]), EVIDENCE_MAX_BYTES, "--decision-file");
  let decision = {};
  try {
    decision = JSON.parse(decisionBytes.toString("utf8"));
  } catch {
    // validated (and rejected) below
  }

  if (args.mode === "discard") {
    if (run.phase !== Phase.FINISH_ACTION_PENDING || !run.finish || run.finish.choice !== "discard") {
      throw new CliError(2, 'cleanup --mode discard: only valid when choose-finish selected "discard" and the run is FINISH_ACTION_PENDING');
    }
    if (decision.confirm !== "discard" || decision.run_id !== runId) {
      throw new CliError(2, 'cleanup --mode discard: --decision-file must contain {"confirm":"discard","run_id":"<this run>"}');
    }
    mkdirSync(paths.reportsDir, { recursive: true });
    const evidenceDest = path.join(paths.reportsDir, `cleanup-discard-decision-${Date.now()}.json`);
    writeLedgerArtifactExclusive(evidenceDest, decisionBytes);

    const worktrees = listRunWorktrees({ repoInfo, runId });
    for (const wt of worktrees) {
      if (existsSync(wt.path) && !isWorktreeClean(wt.path)) {
        throw new CliError(1, `cleanup --mode discard: refusing to discard — worktree "${wt.path}" is not clean`);
      }
    }
    for (const wt of worktrees) {
      if (existsSync(wt.path)) {
        removeCleanWorktree({ repoInfo, path: wt.path, branchCheckCwd: repoInfo.topLevel });
      }
      if (wt.branch) {
        forceDeleteRunBranch(repoInfo.topLevel, runId, wt.branch);
      }
    }
    // Only ever removes the deterministic, run-ID-namespaced private
    // worktree root this run itself created — reconstructed and compared
    // before the recursive delete, never a caller-supplied path.
    const expectedRoot = path.join(repoInfo.topLevel, ".carefully-crafted", "worktrees", runId);
    if (worktreePaths.root === expectedRoot && existsSync(expectedRoot)) {
      rmSync(expectedRoot, { recursive: true, force: true });
    }

    const summary = { mode: "discard", worktreesRemoved: worktrees.map((w) => w.path), at: new Date().toISOString() };
    writeLedgerArtifactOverwrite(paths.cleanup, Buffer.from(JSON.stringify(summary, null, 2), "utf8"));
    const updated = await updateRun(repoInfo, runId, { type: "CLEANUP_DISCARD", evidenceRef: "cleanup.json" });
    return { run_id: runId, phase: updated.phase, artifact: paths.cleanup, next: "(done)" };
  }

  // post-complete
  if (run.phase !== Phase.COMPLETE) {
    throw new CliError(2, "cleanup --mode post-complete: the run must already be COMPLETE");
  }
  if (decision.confirm !== "post-complete" || decision.run_id !== runId) {
    throw new CliError(2, 'cleanup --mode post-complete: --decision-file must contain {"confirm":"post-complete","run_id":"<this run>"}');
  }
  mkdirSync(paths.reportsDir, { recursive: true });
  const evidenceDest = path.join(paths.reportsDir, `cleanup-post-complete-decision-${Date.now()}.json`);
  writeLedgerArtifactExclusive(evidenceDest, decisionBytes);

  // Never the kept integration worktree/branch.
  const worktrees = listRunWorktrees({ repoInfo, runId }).filter((wt) => wt.path !== worktreePaths.integration);
  const removed = [];
  for (const wt of worktrees) {
    if (existsSync(wt.path) && isWorktreeClean(wt.path)) {
      removeCleanWorktree({ repoInfo, path: wt.path, branchCheckCwd: repoInfo.topLevel });
      removed.push(wt.path);
    }
  }
  for (const wt of worktrees) {
    if (!wt.branch || !wt.head) continue;
    if (isCommitIntegrated({ repoInfo, ref: integrationBranchName(runId), commit: wt.head })) {
      forceDeleteRunBranch(repoInfo.topLevel, runId, wt.branch);
    }
  }
  const summary = { mode: "post-complete", removed, at: new Date().toISOString() };
  writeLedgerArtifactOverwrite(paths.cleanup, Buffer.from(JSON.stringify(summary, null, 2), "utf8"));
  const updated = await updateRun(repoInfo, runId, { type: "CLEANUP_POST_COMPLETE", evidenceRef: "cleanup.json" });
  return { run_id: runId, phase: updated.phase, artifact: paths.cleanup, next: "(done)" };
}

// --------------------------------------------------------------------------
// main()
// --------------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  grade: cmdGrade,
  "accept-plan": cmdAcceptPlan,
  "decide-approval": cmdDecideApproval,
  "run-wave": cmdRunWave,
  "accept-review": cmdAcceptReview,
  "accept-final-review": cmdAcceptFinalReview,
  verify: cmdVerify,
  status: cmdStatus,
  block: cmdBlock,
  recover: cmdRecover,
  "choose-finish": cmdChooseFinish,
  "complete-finish": cmdCompleteFinish,
  cleanup: cmdCleanup,
};

export async function main(argv, io = defaultIO) {
  const [cmd, ...rest] = argv ?? [];
  const args = parseFlags(rest);
  try {
    const handler = COMMANDS[cmd];
    if (!handler) {
      io.stderr.write(`unknown command "${cmd ?? ""}" — expected one of: ${Object.keys(COMMANDS).join(", ")}\n`);
      return 2;
    }
    const result = await handler(args, io);
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof CliError) {
      if (err.payload) io.stdout.write(`${JSON.stringify(err.payload)}\n`);
      io.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof ContractError) {
      io.stderr.write(`contract error: ${err.message}\n`);
      return 2;
    }
    // GitError, CodexTransportError, SchedulerError, VerifyError, or any
    // unexpected error is treated as a runtime failure.
    io.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
