#!/usr/bin/env node
// run-supervise-live-evals.mjs — the Task 13, Step 4 paid Claude release-eval
// runner for /contexthub:supervise.
//
// THIS SCRIPT NEVER RUNS AGAINST A REAL PROVIDER ON ITS OWN. It is a Node
// standard-library CLI that (a) validates a declarative cases fixture, (b)
// builds the exact, isolated, bounded argv a real `claude` invocation would
// use, and (c) — only when explicitly invoked without --dry-run, with a
// positive total budget and a real credential source — spawns `claude`
// sequentially, one disposable Git repository per case, tracking a TOTAL RUN
// BUDGET (never a per-case budget) across the whole run. It is deliberately
// NOT wired into `/contexthub:supervise` itself: this is a release-evidence
// tool, run by a human with fresh authorization, never part of ordinary
// supervision execution.
//
// THE BUDGET CONTRACT (read this before touching runLiveEvals): --max-budget-usd
// is the TOTAL cap across every case, not a per-case cap. Each case is handed
// the CURRENT REMAINING amount via its own --max-budget-usd flag; the case's
// JSON-reported cost is parsed and subtracted from that remaining amount;
// processing STOPS (no further case is attempted, and no argv is built for
// it) the moment the remaining amount is not strictly positive. Missing,
// malformed, negative, or over-cap cost data FAILS CLOSED: the run stops
// immediately, exactly like running out of budget, and every output already
// collected is preserved on disk for audit rather than discarded — "cost data
// unavailable" is treated as "spend is unknown and therefore unbounded," and
// an unbounded spend can never be accepted silently.
//
// Node 20+ standard library only.

import { spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class LiveEvalError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveEvalError";
  }
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// EXACTLY WHAT THE CASES NEED, AND NOTHING THAT CAN EXECUTE CODE.
//
// This list previously included `Bash(node:*)`, `Bash(git add:*)` and
// `Bash(git commit:*)`. `Bash(node:*)` was a REAL HOLE, not a stylistic one:
// under `--permission-mode dontAsk`, `node -e '<anything>'` is precisely as
// powerful as `Bash(*)` — arbitrary filesystem writes outside the disposable
// repository, and outright network access. A test asserting "`Bash(*)` is not
// allowlisted" gave false comfort about a boundary that was not actually
// there, because the dangerous grant was spelled differently from the
// spellings the test enumerated.
//
// All three boundary cases in tests/evals/supervise-boundary-cases.json are
// READ-AND-REPORT-JSON planning prompts: they read seeded files and emit a
// JSON verdict. None of them executes anything, and none of them writes or
// commits. So the honest allowlist is the read-only file/search tools plus
// two read-only `git` queries for repository orientation.
//
// What this permits, stated plainly: the eval subject can READ repository
// files and run `git status` / `git log`. It cannot execute code, write or
// modify any file, install anything, or reach the network.
//
// If a future case genuinely needs execution, DO NOT re-add a bare
// interpreter grant. Add a narrowly-scoped grant naming a specific script
// path that the fixture itself seeds, and extend the bound test in
// tests/unit/supervise-live-evals.test.mjs to match — that test asserts the
// closed property (every entry is read-only), so it will fail loudly rather
// than silently accepting a new interpreter.
//
// This is the SAME allowlist both the dry-run argv build and the real run
// use — there is only one allowlist in this file, not one for tests and a
// looser one for production.
export const ALLOWED_TOOLS = Object.freeze([
  "Read", "Glob", "Grep",
  "Bash(git status:*)",
  "Bash(git log:*)",
]);

// The three assertion kinds this eval's declarative cases fixture may ever
// name (Task 13 brief, Step 4): a tightly coupled ask must plan as one work
// order rather than artificial parallelism; an override of a misleading
// grade must always carry a non-empty reason; and explicit Converge evidence
// must become a planning CONSTRAINT without Converge itself launching
// implementation.
//
// Each type's REQUIRED PARAMETERS are declared alongside it and enforced by
// validateCasesFixture, so a case cannot declare an assertion whose
// parameters the evaluator would then be unable to use. Without this the
// parameters were inert decoration: a fixture could say
// `{"type": "single_work_order"}` with no `max_task_count` and nothing
// anywhere would notice until grading silently had nothing to compare.
export const ASSERTION_TYPES = Object.freeze([
  "single_work_order",
  "override_requires_reason",
  "converge_evidence_constrains_planning_without_launch",
]);

const ASSERTION_PARAM_VALIDATORS = Object.freeze({
  single_work_order(a, ctx) {
    if (!Number.isInteger(a.max_task_count) || a.max_task_count < 1) {
      throw new LiveEvalError(`${ctx}.assertion.max_task_count must be an integer >= 1 for "single_work_order"`);
    }
  },
  override_requires_reason(a, ctx) {
    if (!Number.isInteger(a.grader_score) || a.grader_score < 1 || a.grader_score > 5) {
      throw new LiveEvalError(`${ctx}.assertion.grader_score must be an integer 1-5 for "override_requires_reason"`);
    }
  },
  converge_evidence_constrains_planning_without_launch(a, ctx) {
    if (typeof a.expected_strategy_pattern !== "string" || a.expected_strategy_pattern.trim().length === 0) {
      throw new LiveEvalError(`${ctx}.assertion.expected_strategy_pattern must be a non-empty string for "converge_evidence_constrains_planning_without_launch"`);
    }
    try {
      new RegExp(a.expected_strategy_pattern, "i");
    } catch (err) {
      throw new LiveEvalError(`${ctx}.assertion.expected_strategy_pattern is not a valid regular expression: ${err.message}`);
    }
  },
});

const CASE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PROMPT_CHARS = 20000;
const MAX_CASES = 20;

// --------------------------------------------------------------------------
// Fixture validation — Step 2 (no provider usage; pure data validation)
// --------------------------------------------------------------------------

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Validates the shape of a parsed supervise-boundary-cases.json document.
// Throws LiveEvalError on anything malformed; never mutates its input.
export function validateCasesFixture(raw) {
  if (!isPlainObject(raw)) {
    throw new LiveEvalError(`cases fixture must be a JSON object, got ${typeof raw}`);
  }
  if (raw.version !== 1) {
    throw new LiveEvalError(`cases fixture.version must be exactly 1, got ${JSON.stringify(raw.version)}`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new LiveEvalError("cases fixture.cases must be a non-empty array");
  }
  if (raw.cases.length > MAX_CASES) {
    throw new LiveEvalError(`cases fixture.cases has ${raw.cases.length} entries, max ${MAX_CASES}`);
  }

  const seenIds = new Set();
  const cases = raw.cases.map((c, i) => {
    const ctx = `cases fixture.cases[${i}]`;
    if (!isPlainObject(c)) {
      throw new LiveEvalError(`${ctx} must be an object`);
    }
    if (typeof c.id !== "string" || !CASE_ID_RE.test(c.id)) {
      throw new LiveEvalError(`${ctx}.id must match ${CASE_ID_RE}, got ${JSON.stringify(c.id)}`);
    }
    if (seenIds.has(c.id)) {
      throw new LiveEvalError(`cases fixture.cases contains duplicate id "${c.id}"`);
    }
    seenIds.add(c.id);
    if (typeof c.description !== "string" || c.description.length === 0 || c.description.length > 480) {
      throw new LiveEvalError(`${ctx}.description must be a non-empty string of at most 480 characters`);
    }
    if (typeof c.prompt !== "string" || c.prompt.length === 0 || c.prompt.length > MAX_PROMPT_CHARS) {
      throw new LiveEvalError(`${ctx}.prompt must be a non-empty string of at most ${MAX_PROMPT_CHARS} characters`);
    }
    if (c.setup !== undefined) {
      if (!isPlainObject(c.setup) || !isPlainObject(c.setup.files ?? {})) {
        throw new LiveEvalError(`${ctx}.setup, when present, must be an object with an optional "files" object`);
      }
      for (const [relPath, content] of Object.entries(c.setup.files ?? {})) {
        if (typeof content !== "string") {
          throw new LiveEvalError(`${ctx}.setup.files["${relPath}"] must be a string`);
        }
        if (relPath.startsWith("/") || relPath.includes("..") || relPath.includes("\0")) {
          throw new LiveEvalError(`${ctx}.setup.files has an unsafe path "${relPath}" — paths must be relative and must not contain ".." segments`);
        }
      }
    }
    if (!isPlainObject(c.assertion) || typeof c.assertion.type !== "string") {
      throw new LiveEvalError(`${ctx}.assertion must be an object with a string "type"`);
    }
    if (!ASSERTION_TYPES.includes(c.assertion.type)) {
      throw new LiveEvalError(`${ctx}.assertion.type "${c.assertion.type}" is unknown — must be one of ${ASSERTION_TYPES.join(", ")}`);
    }
    ASSERTION_PARAM_VALIDATORS[c.assertion.type](c.assertion, ctx);
    return c;
  });

  return { version: 1, cases };
}

// --------------------------------------------------------------------------
// Preflight guards
// --------------------------------------------------------------------------

// The runner must refuse to start without an explicit POSITIVE total cap —
// missing, zero, negative, non-numeric, and non-finite all fail closed here,
// before anything else runs.
export function assertPositiveBudget(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new LiveEvalError(`--max-budget-usd must be an explicit positive number, got ${JSON.stringify(value)}`);
  }
  return n;
}

// A "safe disposable root" is one this tool is willing to create files in
// and eventually recommend deleting: it must resolve inside the OS temp
// directory. Any other target — a real checkout, a home directory, "." — is
// refused outright rather than trusted because it merely "looks temporary."
//
// Checked in two passes so a target that is obviously NOT disposable is
// rejected WITHOUT ever creating a directory for it: first a textual
// containment check against `path.resolve` (no filesystem mutation), and
// only once that passes does this function create the directory and re-check
// via `realpathSync` on both sides (closing a symlink-escape hole a plain
// string-prefix check would miss).
export function assertDisposableRoot(targetRoot) {
  if (typeof targetRoot !== "string" || targetRoot.length === 0) {
    throw new LiveEvalError("target root must be a non-empty path");
  }
  // Pass 1 (pre-creation, no filesystem mutation): compare against the
  // UNRESOLVED `os.tmpdir()` value. On macOS `os.tmpdir()` itself returns a
  // symlink (/var/folders/... -> /private/var/folders/...), and the target
  // may not exist yet, so it cannot be realpath-resolved for this pass —
  // this check only needs to reject the OBVIOUS case (a real checkout, ".",
  // a home directory) cheaply, before creating anything.
  const rawTmp = path.resolve(tmpdir());
  const resolved = path.resolve(targetRoot);
  if (resolved !== rawTmp && !resolved.startsWith(rawTmp + path.sep)) {
    throw new LiveEvalError(`target root "${targetRoot}" is not a disposable path — it must resolve inside the OS temp directory (${rawTmp}), not a real checkout or arbitrary directory`);
  }
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  // Pass 2 (authoritative): now that the directory exists, resolve symlinks
  // on BOTH sides and re-check — this is what actually closes a
  // symlink-escape hole a plain string-prefix check would miss.
  const realTmp = realpathSync(tmpdir());
  const realTarget = realpathSync(resolved);
  if (realTarget !== realTmp && !realTarget.startsWith(realTmp + path.sep)) {
    throw new LiveEvalError(`target root "${targetRoot}" resolves (after following symlinks) outside the OS temp directory (${realTmp}) — refusing to treat it as disposable`);
  }
  return realTarget;
}

// `--bare` strips user/project Claude configuration, so a real run's ONLY
// credential source is an explicit environment variable — never an ambient
// OAuth session, never a config file this tool happens to find. This check
// is intentionally single-source: it does not attempt to model every
// possible bare-mode credential mechanism (Bedrock/Vertex/etc.), only the
// one this tool actually uses.
export function assertCredentialSource(env) {
  if (typeof env?.ANTHROPIC_API_KEY !== "string" || env.ANTHROPIC_API_KEY.trim().length === 0) {
    throw new LiveEvalError("no bare-mode credential source: ANTHROPIC_API_KEY must be set in the environment (this tool recognizes no other credential source)");
  }
}

// The local Contexthub plugin directory this tool's own file lives beside —
// resolved from THIS SCRIPT's own path, never from cwd, so it cannot be
// spoofed by running the tool from an unexpected directory.
export function resolveContexthubPluginDir() {
  return path.join(REPO_ROOT, "plugins", "contexthub");
}

// --------------------------------------------------------------------------
// Claude argv construction — Step 2
// --------------------------------------------------------------------------

// Two decimal places is the natural USD unit, but repeated subtraction from
// a starting budget can produce sub-cent floating point residue (e.g.
// 6.999999999999999); round to a stable six-decimal-place value rather than
// truncate, so a genuinely tiny positive remainder is never rounded down to
// the zero that would incorrectly trigger early stop.
export function formatUsd(n) {
  return String(Math.round(n * 1e6) / 1e6);
}

// Builds the exact argv (WITHOUT the binary name — the caller spawns
// `claudeBin` separately, mirroring supervise/codex.mjs's
// buildFreshCodexArgs convention) for one case's Claude invocation:
//
//   --bare --print --output-format json --no-session-persistence
//   --plugin-dir <local Contexthub> --plugin-dir <supplied Superpowers path>
//   --max-budget-usd <remaining> --permission-mode dontAsk
//   --allowedTools <ALLOWED_TOOLS, comma-joined>
//   <prompt>
//
// `--bare` is what makes every other isolation property possible: it is the
// switch that suppresses user/project plugins, CLAUDE.md, hooks, and MCP
// servers so the two explicit `--plugin-dir` entries are the ONLY plugin
// surface Claude ever sees, and so a user or project configuration's own
// (possibly multiplied) budget setting can never combine with this run's
// cap.
export function buildClaudeArgv({ prompt, contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd }) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new LiveEvalError("buildClaudeArgv: options.prompt must be a non-empty string");
  }
  if (typeof contexthubPluginDir !== "string" || contexthubPluginDir.length === 0) {
    throw new LiveEvalError("buildClaudeArgv: options.contexthubPluginDir is required");
  }
  if (typeof superpowersPluginDir !== "string" || superpowersPluginDir.length === 0) {
    throw new LiveEvalError("buildClaudeArgv: options.superpowersPluginDir is required");
  }
  const remaining = assertPositiveBudget(remainingBudgetUsd);

  return [
    "--bare",
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--plugin-dir", contexthubPluginDir,
    "--plugin-dir", superpowersPluginDir,
    "--max-budget-usd", formatUsd(remaining),
    "--permission-mode", "dontAsk",
    "--allowedTools", ALLOWED_TOOLS.join(","),
    prompt,
  ];
}

// --------------------------------------------------------------------------
// Cost parsing — fail-closed by construction
// --------------------------------------------------------------------------

// Claude Code's `--print --output-format json` mode reports a single JSON
// result object whose `total_cost_usd` field is the run's own accounting of
// what it spent. Missing, non-numeric, non-finite, or negative values are
// NOT "assume zero" — they are "cost is unknown," which this function always
// reports as a failure rather than guessing. The over-cap check (comparing
// against the remaining budget that call was granted) is the CALLER's job,
// since only the caller knows what cap that specific call was handed.
export function parseClaudeCostResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, reason: `malformed-json: ${err.message}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "result is not a JSON object" };
  }
  const cost = parsed.total_cost_usd;
  if (typeof cost !== "number" || !Number.isFinite(cost)) {
    return { ok: false, reason: `missing or non-numeric total_cost_usd (got ${JSON.stringify(cost)})` };
  }
  if (cost < 0) {
    return { ok: false, reason: `negative total_cost_usd (${cost})` };
  }
  return { ok: true, costUsd: cost, raw: parsed };
}

// --------------------------------------------------------------------------
// Assertion grading — the per-case VERDICT
// --------------------------------------------------------------------------

export const VERDICT = Object.freeze({ PASS: "PASS", FAIL: "FAIL", INCONCLUSIVE: "INCONCLUSIVE" });

const pass = (reason, observed) => ({ verdict: VERDICT.PASS, reason, observed });
const fail = (reason, observed) => ({ verdict: VERDICT.FAIL, reason, observed });
// EVERY path that cannot actually evaluate the declared property lands here.
// "I could not tell" is never reported as success — see the fallthrough note
// on evaluateCaseAssertion below.
const inconclusive = (reason, observed = null) => ({ verdict: VERDICT.INCONCLUSIVE, reason, observed });

// Models reliably emit their JSON either bare or inside a fenced block, so
// both are accepted. Anything else is INCONCLUSIVE rather than coerced.
function extractModelJson(resultText) {
  if (typeof resultText !== "string" || resultText.trim().length === 0) return null;
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(resultText);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = resultText.indexOf("{");
  const lastBrace = resultText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(resultText.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Grades ONE case's captured Claude result envelope against that case's own
// declared assertion, returning {verdict, reason, observed}.
//
// THE FALLTHROUGH RULE, APPLIED TO THIS FUNCTION ITSELF. Every branch that
// cannot evaluate the property — no result text, no JSON, a missing or
// wrongly-typed field, or an assertion type this evaluator does not
// implement — returns INCONCLUSIVE. There is deliberately no `default:` that
// falls through to PASS, and the unknown-type branch does NOT delegate its
// safety to validateCasesFixture having already rejected unknown types: a
// recipient that cannot fail is not a guard, so this function fails closed on
// its own regardless of what validated the fixture upstream.
export function evaluateCaseAssertion(caseObj, envelope) {
  const assertion = caseObj?.assertion;
  if (!isPlainObject(assertion) || typeof assertion.type !== "string") {
    return inconclusive("case has no usable assertion declaration");
  }
  if (!isPlainObject(envelope)) {
    return inconclusive("no result envelope was captured for this case");
  }
  const model = extractModelJson(envelope.result);
  if (model === null) {
    return inconclusive("the captured result contained no parseable JSON object to grade");
  }

  switch (assertion.type) {
    case "single_work_order": {
      const n = model.task_count;
      if (!Number.isInteger(n) || n < 1) {
        return inconclusive(`task_count is missing or not an integer >= 1 (got ${JSON.stringify(n)})`, model);
      }
      return n <= assertion.max_task_count
        ? pass(`task_count ${n} is within the declared maximum of ${assertion.max_task_count}`, model)
        : fail(`task_count ${n} exceeds the declared maximum of ${assertion.max_task_count} — coupled work was split into artificial parallelism`, model);
    }

    case "override_requires_reason": {
      const score = model.claude_score;
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return inconclusive(`claude_score is missing or outside 1-5 (got ${JSON.stringify(score)})`, model);
      }
      const reason = model.override_reason;
      const hasReason = typeof reason === "string" && reason.trim().length > 0;
      if (!(reason === null || typeof reason === "string")) {
        return inconclusive(`override_reason must be a string or null (got ${JSON.stringify(reason)})`, model);
      }
      if (score === assertion.grader_score) {
        return hasReason
          ? fail(`claude_score ${score} agrees with the grader, so override_reason must be null`, model)
          : pass(`claude_score ${score} agrees with the grader and carries no override reason`, model);
      }
      return hasReason
        ? pass(`claude_score ${score} overrides the grader's ${assertion.grader_score} with a non-empty reason`, model)
        : fail(`claude_score ${score} overrides the grader's ${assertion.grader_score} without a non-empty override_reason`, model);
    }

    case "converge_evidence_constrains_planning_without_launch": {
      const launched = model.converge_launched;
      if (typeof launched !== "boolean") {
        return inconclusive(`converge_launched is missing or not a boolean (got ${JSON.stringify(launched)})`, model);
      }
      const strategy = model.invalidation_strategy;
      if (typeof strategy !== "string" || strategy.trim().length === 0) {
        return inconclusive(`invalidation_strategy is missing or empty (got ${JSON.stringify(strategy)})`, model);
      }
      if (launched) {
        return fail("Converge was launched during a planning-only step", model);
      }
      return new RegExp(assertion.expected_strategy_pattern, "i").test(strategy)
        ? pass(`planning adopted the recorded strategy ("${strategy}") without launching Converge`, model)
        : fail(`planning ignored the recorded Converge evidence — strategy "${strategy}" does not match /${assertion.expected_strategy_pattern}/i`, model);
    }

    default:
      return inconclusive(`no evaluator is implemented for assertion type "${assertion.type}"`, model);
  }
}

// --------------------------------------------------------------------------
// Disposable per-case repositories
// --------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// One fresh, empty Git repository per case, seeded only with that case's own
// `setup.files` — never the tool repository's own working tree, never
// anything shared across cases.
export function createDisposableCaseRepo(disposableRoot, caseObj) {
  const caseRoot = path.join(disposableRoot, `case-${caseObj.id}`);
  if (existsSync(caseRoot)) {
    throw new LiveEvalError(`createDisposableCaseRepo: "${caseRoot}" already exists — refusing to reuse a case directory`);
  }
  mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
  git(caseRoot, ["init", "-q", "-b", "main"]);
  git(caseRoot, ["config", "user.email", "supervise-live-eval@example.invalid"]);
  git(caseRoot, ["config", "user.name", "Supervise Live Eval"]);
  const files = caseObj.setup?.files ?? {};
  for (const [relPath, content] of Object.entries(files)) {
    const dest = path.join(caseRoot, relPath);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  if (Object.keys(files).length > 0) {
    git(caseRoot, ["add", "-A"]);
    git(caseRoot, ["commit", "-qm", "seed"]);
  }
  return caseRoot;
}

// --------------------------------------------------------------------------
// Audit output preservation
// --------------------------------------------------------------------------

export function writeCaseOutput(outputsDir, caseId, payload) {
  mkdirSync(outputsDir, { recursive: true, mode: 0o700 });
  const dest = path.join(outputsDir, `${caseId}.json`);
  writeFileSync(dest, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return dest;
}

// --------------------------------------------------------------------------
// runLiveEvals — the sequential, total-budget-tracking core loop
// --------------------------------------------------------------------------

// `spawnImpl(claudeBin, argv, {cwd, env})` must return (or resolve to)
// `{ stdout }`. In production this wraps a real `child_process.spawn`
// promise; every deterministic test injects a fake that never touches a
// real `claude` binary. `dryRun: true` NEVER calls `spawnImpl` at all — it
// only builds and records argv, which is the entire point of dry-run mode.
export async function runLiveEvals(options) {
  const {
    cases, contexthubPluginDir, superpowersPluginDir, maxBudgetUsd,
    disposableRoot, outputsDir, dryRun = false, spawnImpl, claudeBin = "claude", env = process.env,
  } = options ?? {};

  if (!Array.isArray(cases) || cases.length === 0) {
    throw new LiveEvalError("runLiveEvals: options.cases must be a non-empty array (pass the validated fixture's .cases)");
  }
  const totalBudget = assertPositiveBudget(maxBudgetUsd);
  if (!dryRun) {
    if (typeof spawnImpl !== "function") {
      throw new LiveEvalError("runLiveEvals: options.spawnImpl is required unless dryRun is true");
    }
    if (typeof disposableRoot !== "string" || disposableRoot.length === 0) {
      throw new LiveEvalError("runLiveEvals: options.disposableRoot is required unless dryRun is true");
    }
  }

  let remaining = totalBudget;
  const results = [];
  let stoppedEarly = false;
  let failedClosed = null;

  for (const c of cases) {
    // STOP BEFORE THE NEXT CASE THE MOMENT NO POSITIVE BUDGET REMAINS — no
    // argv is built and no case directory is created for a case this run
    // will never attempt.
    if (remaining <= 0) {
      stoppedEarly = true;
      break;
    }

    const argv = buildClaudeArgv({
      prompt: c.prompt, contexthubPluginDir, superpowersPluginDir, remainingBudgetUsd: remaining,
    });

    if (dryRun) {
      results.push({ caseId: c.id, dryRun: true, argv });
      continue;
    }

    const caseRoot = createDisposableCaseRepo(disposableRoot, c);
    const spawnResult = await spawnImpl(claudeBin, argv, { cwd: caseRoot, env });
    const parsedCost = parseClaudeCostResult(spawnResult?.stdout ?? "");

    // GRADE THE CASE. Done before the cost gates below so that a case whose
    // cost data is untrustworthy still leaves its own graded verdict on disk
    // for audit — the two judgements are independent, and losing the verdict
    // because the accounting was malformed would discard evidence that was
    // already paid for.
    const verdict = evaluateCaseAssertion(c, parsedCost.ok ? parsedCost.raw : null);

    if (outputsDir) {
      writeCaseOutput(outputsDir, c.id, {
        caseId: c.id, argv, caseRoot, remainingBudgetBeforeUsd: remaining,
        stdout: spawnResult?.stdout ?? null, parsedCost, verdict,
      });
    }

    // FAIL CLOSED: missing/malformed/negative cost data.
    if (!parsedCost.ok) {
      failedClosed = { caseId: c.id, reason: parsedCost.reason };
      break;
    }
    // FAIL CLOSED: a case reporting it spent MORE than the cap it was
    // actually handed is cost data this run can no longer trust — treated
    // exactly like malformed data, not silently clamped to the cap.
    if (parsedCost.costUsd > remaining) {
      failedClosed = { caseId: c.id, reason: `over-cap cost: reported ${parsedCost.costUsd} against a remaining cap of ${remaining}` };
      break;
    }

    remaining -= parsedCost.costUsd;
    results.push({
      caseId: c.id, dryRun: false, argv, costUsd: parsedCost.costUsd, remainingAfterUsd: remaining, caseRoot,
      verdict: verdict.verdict, verdictReason: verdict.reason, observed: verdict.observed,
    });
  }

  const verdictCounts = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
  for (const r of results) {
    if (r.verdict) verdictCounts[r.verdict] += 1;
  }

  // `allAssertionsPassed` is a CLAIM ABOUT THE WHOLE RUN, so it requires the
  // whole run: every declared case attempted, every one graded PASS, nothing
  // inconclusive, no early stop, and no fail-closed. A run that ran out of
  // budget after two of three cases has not shown that the third case passes,
  // and must never say it did. Dry-run grades nothing, so it is never true
  // there either.
  const allAssertionsPassed = !dryRun
    && !stoppedEarly
    && failedClosed === null
    && results.length === cases.length
    && verdictCounts.PASS === cases.length;

  return {
    totalBudgetUsd: totalBudget,
    cumulativeSpendUsd: Math.round((totalBudget - remaining) * 1e6) / 1e6,
    remainingBudgetUsd: Math.max(0, Math.round(remaining * 1e6) / 1e6),
    stoppedEarly,
    failedClosed,
    verdictCounts,
    allAssertionsPassed,
    results,
  };
}

// --------------------------------------------------------------------------
// CLI
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

async function realSpawnImpl(bin, argv, { cwd, env }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, env: process.env }) {
  const args = parseFlags(argv ?? []);
  try {
    if (!args.cases || args.cases === true) {
      throw new LiveEvalError("--cases <path-to-supervise-boundary-cases.json> is required");
    }
    if (!args["superpowers-plugin-dir"] || args["superpowers-plugin-dir"] === true) {
      throw new LiveEvalError("--superpowers-plugin-dir <path> is required");
    }
    const superpowersPluginDir = path.resolve(args["superpowers-plugin-dir"]);
    if (!existsSync(superpowersPluginDir)) {
      throw new LiveEvalError(`--superpowers-plugin-dir "${superpowersPluginDir}" does not exist`);
    }
    const dryRun = args["dry-run"] === true;
    const maxBudgetUsd = assertPositiveBudget(args["max-budget-usd"]);

    const raw = JSON.parse(readFileSync(path.resolve(args.cases), "utf8"));
    const fixture = validateCasesFixture(raw);
    const contexthubPluginDir = resolveContexthubPluginDir();

    if (dryRun) {
      const result = await runLiveEvals({
        cases: fixture.cases, contexthubPluginDir, superpowersPluginDir, maxBudgetUsd, dryRun: true,
      });
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    assertCredentialSource(io.env);
    const disposableRoot = args["target-root"]
      ? assertDisposableRoot(args["target-root"])
      : mkdtempSync(path.join(tmpdir(), "supervise-live-evals-"));
    const outputsDir = path.join(disposableRoot, "outputs");

    const result = await runLiveEvals({
      cases: fixture.cases, contexthubPluginDir, superpowersPluginDir, maxBudgetUsd,
      disposableRoot, outputsDir, dryRun: false, spawnImpl: realSpawnImpl, env: io.env,
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    io.stdout.write(`\noutputs preserved at: ${outputsDir}\n`);
    // A non-zero exit for anything short of "every case attempted and graded
    // PASS": a fail-closed cost problem, a FAILED assertion, or an
    // INCONCLUSIVE one. An inconclusive verdict is deliberately NOT treated
    // as success — the eval did not demonstrate the property it exists to
    // demonstrate.
    return result.allAssertionsPassed ? 0 : 1;
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return err instanceof LiveEvalError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
