// codex.mjs — the PRIVATE structured Codex transport for /contexthub:supervise.
//
// This is a standalone module. It must NOT invoke the public /codex:exec
// skill and must NOT import plugins/codex/scripts/codex-invoke.mjs —
// separately cached plugins have no stable sibling filesystem relationship,
// so this file owns its own argv construction, spawn, JSONL parsing, and
// capability preflight end to end. Node 20+ standard library only.
//
// Three behaviours drive most of the design here (all verified against a
// live Codex CLI 0.144.5, none of them documented by Codex itself):
//
//   1. `-c model_reasoning_effort=<v>` is a raw, UNVALIDATED TOML override.
//      The CLI accepts and bills any string, including "ultra". Effort
//      rejection is therefore entirely this module's responsibility, and it
//      must happen before anything is ever spawned — see
//      assertSandboxEffort() and its callers in buildFreshCodexArgs /
//      buildResumeCodexArgs.
//
//   2. Codex blocks on "Reading additional input from stdin…" even when the
//      prompt is supplied as an argv element, unless stdin is closed. Every
//      spawn in this file sets stdio[0] to "ignore" — see runCodex() and
//      checkCodexPrerequisites(). This is a live-hang risk, not merely an
//      error path: an inherited/piped stdin would silently burn the full
//      worker timeout on every single call.
//
//   3. The JSONL event set is OPEN, not closed. Live runs emit thread.started
//      and turn.completed (authoritative, parsed below) but also
//      turn.started, item.completed, and presumably others across CLI
//      versions. parseCodexEvent() logs and ignores any well-formed-but-
//      unrecognized event; only JSON that fails to parse at all counts as
//      malformed, and the malformed rule is applied to stdout only — stderr
//      is diagnostics (a healthy run can emit an unrelated models-cache
//      warning there) and never fails a run by itself.
//
// Mutation safety (the core safety property of this module): runCodex()
// always returns `threadId` and `failureCategory` from the SAME evidence
// (the parsed JSONL accumulator), regardless of success or failure. A
// caller can therefore derive mutation-ambiguity with nothing more than
// these two fields: once `threadId` is non-null, ANY non-null
// `failureCategory` (timeout, transport, missing-completion, ...) means the
// worker may have already mutated the worktree, and the correct move is
// BLOCKED with the evidence preserved — never an automatic second writing
// worker. Only when `threadId` is still null is a failure structurally safe
// to retry (and even then only after the caller independently proves the
// worktree is still clean at its assigned base — a git-level check that
// belongs to the caller/scheduler, not this transport).

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export class CodexTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexTransportError";
  }
}

// --------------------------------------------------------------------------
// Efforts, sandboxes, models
// --------------------------------------------------------------------------

// The full, official reasoning-effort vocabulary. Anything outside this set
// is rejected before argv is ever built (see fact #1 above).
export const SUPPORTED_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

const DEFAULT_MODEL = "gpt-5.6-sol";

// The model is gated exactly as strictly as the effort is. Without this,
// `requireNonEmptyString` was the only check and a caller could route a
// supervisor call to an arbitrary model (`-m gpt-3.5-turbo`, `-m o3-mini`)
// while effort remained rigorously validated — an asymmetry that silently
// defeats the model-pinning acceptance criteria. Add a model here only
// when it is a deliberate, reviewed supervisor-tier choice.
export const SUPPORTED_MODELS = new Set(["gpt-5.6-sol"]);

// Verbosity is fixed, never caller-selectable: every argv shape in the brief
// carries exactly `-c model_verbosity=low`.
const FIXED_VERBOSITY = "low";

const GRADER_SANDBOX = "read-only";
const WORKER_SANDBOX = "workspace-write";

// The ONLY failure categories a caller may ever retry, and then only for a
// read-only grader (a writing worker additionally requires no thread.started
// plus independent git proof that the worktree is clean — see the
// mutation-safety note at the top of this file).
//
// This lives here, exported, rather than as a literal inside a test: it is a
// safety-relevant policy that Task 9's scheduler must consume as a shared
// symbol, not re-derive from prose. "auth", "malformed-jsonl",
// "missing-output", "missing-thread-started", "missing-turn-completed",
// "timeout", and "nonzero-exit" are all deliberately absent.
export const RETRYABLE_CATEGORIES = Object.freeze(new Set(["rate-limited", "transport"]));

function requireSupportedModel(model, name) {
  requireNonEmptyString(model, name);
  if (!SUPPORTED_MODELS.has(model)) {
    throw new CodexTransportError(
      `${name} must be one of ${[...SUPPORTED_MODELS].join("|")}, got ${JSON.stringify(model)} — the supervisor never routes a call to an unreviewed model`,
    );
  }
  return model;
}

// The ENTIRE set of sandbox values this transport will ever pass to Codex.
// "danger-full-access" is not a member of this map and there is no other
// code path that can add a third key — that is what makes it structurally
// impossible for this module to emit "danger-full-access", not merely
// policy-forbidden.
const SANDBOX_EFFORT_POLICY = new Map([
  // The grader is read-only and its effort is fixed, not caller-selectable
  // (mirrors timeoutForCall's fixed 180s grader bound).
  [GRADER_SANDBOX, new Set(["medium"])],
  // Workers (fresh or resumed) never run below "high" — this mirrors
  // contracts.mjs's TASK_EFFORTS set exactly.
  [WORKER_SANDBOX, new Set(["high", "xhigh", "max"])],
]);

function requireNonEmptyString(v, name) {
  if (typeof v !== "string" || v.length === 0) {
    throw new CodexTransportError(`${name} must be a non-empty string`);
  }
  return v;
}

function requireAbsolutePath(v, name) {
  requireNonEmptyString(v, name);
  if (!v.startsWith("/")) {
    throw new CodexTransportError(`${name} must be an absolute path, got ${JSON.stringify(v)}`);
  }
  return v;
}

// The single gate that decides which (sandbox, effort) pairs may ever reach
// argv. Every disallowed combination — an unknown sandbox, an unknown
// effort, or a known effort that simply isn't permitted for this sandbox —
// throws here, before any spawn is constructed.
function assertSandboxEffort(sandbox, effort) {
  const allowed = SANDBOX_EFFORT_POLICY.get(sandbox);
  if (!allowed) {
    throw new CodexTransportError(
      `unsupported sandbox ${JSON.stringify(sandbox)} — only ${[...SANDBOX_EFFORT_POLICY.keys()].join(", ")} are ever constructed by this transport ("danger-full-access" is never a permitted value)`,
    );
  }
  if (!SUPPORTED_EFFORTS.has(effort)) {
    throw new CodexTransportError(`unsupported effort ${JSON.stringify(effort)} — must be one of ${[...SUPPORTED_EFFORTS].join("|")}`);
  }
  if (!allowed.has(effort)) {
    throw new CodexTransportError(
      `sandbox ${JSON.stringify(sandbox)} does not permit effort ${JSON.stringify(effort)} — allowed for this sandbox: ${[...allowed].join("|")}`,
    );
  }
}

// --------------------------------------------------------------------------
// Argv builders — fresh vs resume are kept structurally separate. Resume
// never accepts a cwd/sandbox option at all (the real `codex exec resume`
// interface exposes neither -C nor -s/--sandbox — verified), so there is no
// field here that could smuggle either flag into a resume argv.
//
// SANDBOX PINNING. A fresh call pins its sandbox with `--sandbox <mode>`,
// which beats user config. Resume has no such flag, so for a while this
// module passed NO sandbox information at all on resume — meaning the
// effective sandbox resolved from the session record and/or the user's
// ~/.codex/config.toml. If a user's config set `sandbox_mode =
// "danger-full-access"`, a resumed supervisor worker would have run
// UNSANDBOXED against a real worktree, without this module ever emitting
// that string. The fixed argv shape proved we don't PASS a bad sandbox; it
// never proved the run IS workspace-write.
//
// The fix is the `-c sandbox_mode=<mode>` override below. Verified against
// the real 0.144.5 CLI:
//   - `-c/--config` IS available on `exec resume` (per its own --help).
//   - `sandbox_mode` is a VALIDATED config key — unlike the unvalidated
//     `model_reasoning_effort`, an invalid value is rejected outright:
//       Error loading config.toml: unknown variant `not-a-real-mode`,
//       expected one of `read-only`, `workspace-write`, `danger-full-access`
//     so the CLI itself enforces the pin rather than silently accepting it.
// This is one scoped key, NOT `--ignore-user-config` (which the plan
// forbids): it overrides exactly the sandbox and nothing else.
// --------------------------------------------------------------------------

// Fresh execution: `exec --json --sandbox <sandbox> -C <cwd> -m <model>
// -c model_reasoning_effort=<effort> -c model_verbosity=low <prompt>
// --output-schema <schemaPath> --output-last-message <outputPath>`.
//
// Fresh deliberately does NOT carry a redundant `-c sandbox_mode=` override:
// the explicit `--sandbox` flag already beats user config, and the brief
// specifies this exact grader/worker argv. Only resume, which has no
// sandbox flag at all, needs the config-key pin.
export function buildFreshCodexArgs(options) {
  const { cwd, prompt, schemaPath, outputPath, model = DEFAULT_MODEL, effort, sandbox } = options ?? {};
  requireAbsolutePath(cwd, "options.cwd");
  requireNonEmptyString(prompt, "options.prompt");
  requireAbsolutePath(schemaPath, "options.schemaPath");
  requireAbsolutePath(outputPath, "options.outputPath");
  requireSupportedModel(model, "options.model");
  assertSandboxEffort(sandbox, effort);

  return [
    "exec", "--json", "--sandbox", sandbox, "-C", cwd,
    "-m", model,
    "-c", `model_reasoning_effort=${effort}`,
    "-c", `model_verbosity=${FIXED_VERBOSITY}`,
    prompt,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
  ];
}

// Resume: `exec resume --json -m <model> -c model_reasoning_effort=<effort>
// -c model_verbosity=low -c sandbox_mode=workspace-write
// --output-schema <schemaPath> --output-last-message <outputPath>
// <threadId> <prompt>`. No -C, no --sandbox, no --last: resume is always the
// exact thread, confined by the caller setting the CHILD PROCESS's cwd (not
// an argv flag) to the original absolute worktree — see runCodex() — AND by
// the explicit sandbox_mode pin (see the SANDBOX PINNING note above).
export function buildResumeCodexArgs(options) {
  const { threadId, prompt, schemaPath, outputPath, model = DEFAULT_MODEL, effort } = options ?? {};
  requireNonEmptyString(threadId, "options.threadId");
  requireNonEmptyString(prompt, "options.prompt");
  requireAbsolutePath(schemaPath, "options.schemaPath");
  requireAbsolutePath(outputPath, "options.outputPath");
  requireSupportedModel(model, "options.model");
  // Resume is only ever legal for a task that already ran as a writing
  // worker, so the same high|xhigh|max policy applies — and the sandbox it
  // is pinned to below is exactly that worker sandbox.
  const workerEfforts = SANDBOX_EFFORT_POLICY.get(WORKER_SANDBOX);
  if (!SUPPORTED_EFFORTS.has(effort) || !workerEfforts.has(effort)) {
    throw new CodexTransportError(`resume effort must be one of ${[...workerEfforts].join("|")}, got ${JSON.stringify(effort)}`);
  }

  return [
    "exec", "resume", "--json",
    "-m", model,
    "-c", `model_reasoning_effort=${effort}`,
    "-c", `model_verbosity=${FIXED_VERBOSITY}`,
    // The pin. WORKER_SANDBOX is the same constant the fresh path uses, so
    // this can never drift to a different mode, and "danger-full-access" is
    // not a value any code path in this module can reach.
    "-c", `sandbox_mode=${WORKER_SANDBOX}`,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    threadId, prompt,
  ];
}

// --------------------------------------------------------------------------
// Timeouts — derived from call kind + validated effort. The grader's bound
// is fixed regardless of effort (its effort is itself fixed at "medium");
// worker/resume bounds are keyed by the same high|xhigh|max tiers as
// contracts.mjs's task-effort vocabulary. The task graph cannot raise these
// — this is the single source of truth the scheduler must consult.
// --------------------------------------------------------------------------

const TIMEOUT_MS = Object.freeze({
  grader: 180_000,
  high: 900_000,
  xhigh: 1_800_000,
  max: 2_700_000,
});

export function timeoutForCall(kind, effort) {
  if (kind === "grader") {
    if (effort !== undefined && effort !== "medium") {
      throw new CodexTransportError(`timeoutForCall: grader effort must be "medium" (fixed), got ${JSON.stringify(effort)}`);
    }
    return TIMEOUT_MS.grader;
  }
  if (kind === "worker" || kind === "resume") {
    if (effort !== "high" && effort !== "xhigh" && effort !== "max") {
      throw new CodexTransportError(`timeoutForCall: ${kind} effort must be one of high|xhigh|max, got ${JSON.stringify(effort)}`);
    }
    return TIMEOUT_MS[effort];
  }
  throw new CodexTransportError(`timeoutForCall: kind must be "grader", "worker", or "resume", got ${JSON.stringify(kind)}`);
}

// --------------------------------------------------------------------------
// JSONL event parsing — see fact #3 above. `accumulator` is mutated in
// place and returned, so a caller can fold an entire stream through this
// function with `acc = parseCodexEvent(line, acc)` (or ignore the return
// value entirely once seeded, since mutation is in place).
// --------------------------------------------------------------------------

export function freshCodexEventAccumulator() {
  return {
    threadId: null,
    usage: null,
    sawThreadStarted: false,
    sawTurnCompleted: false,
    malformed: false,
    malformedLine: null,
    unknownEventTypes: [],
    eventCount: 0,
  };
}

export function parseCodexEvent(line, accumulator) {
  const acc = accumulator ?? freshCodexEventAccumulator();
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (trimmed.length === 0) return acc; // blank lines are not events, not malformed

  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Only unparseable JSON counts as malformed (brief, Step 3).
    acc.malformed = true;
    acc.malformedLine = trimmed;
    return acc;
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.type !== "string") {
    // Well-formed JSON that isn't a typed event envelope: logged, ignored,
    // never fatal.
    acc.unknownEventTypes.push(typeof obj?.type === "string" ? obj.type : "<untyped>");
    acc.eventCount += 1;
    return acc;
  }

  acc.eventCount += 1;

  if (obj.type === "thread.started") {
    if (typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
      acc.sawThreadStarted = true;
      acc.threadId = obj.thread_id;
    } else {
      // Well-formed JSON, recognized type, but the shape inside is off.
      // Still not "malformed" per the brief's literal rule — logged as
      // unknown so downstream missing-thread.started detection stays
      // correct rather than silently trusting a garbled ID.
      acc.unknownEventTypes.push(obj.type);
    }
    return acc;
  }

  if (obj.type === "turn.completed") {
    const u = obj.usage;
    if (
      u && typeof u === "object"
      && Number.isInteger(u.input_tokens)
      && Number.isInteger(u.cached_input_tokens)
      && Number.isInteger(u.output_tokens)
      && Number.isInteger(u.reasoning_output_tokens)
    ) {
      acc.sawTurnCompleted = true;
      acc.usage = {
        inputTokens: u.input_tokens,
        cachedInputTokens: u.cached_input_tokens,
        outputTokens: u.output_tokens,
        reasoningOutputTokens: u.reasoning_output_tokens,
      };
    } else {
      acc.unknownEventTypes.push(obj.type);
    }
    return acc;
  }

  // The open part of the event set: turn.started, item.completed, and
  // whatever else a future CLI version emits. Logged, ignored, never fatal.
  acc.unknownEventTypes.push(obj.type);
  return acc;
}

// --------------------------------------------------------------------------
// Failure categorization for a completed/failed run. Grader-retry-eligible
// categories are exactly "rate-limited" and "transport" (brief, Step 4:
// "a categorized transient rate-limit or transport failure").
// --------------------------------------------------------------------------

function categorizeStderr(text) {
  const t = (text || "").toLowerCase();
  if (/authenticat|not\s+signed|sign\s*in|login required|unauthorized/.test(t)) return "auth";
  if (/rate.?limit|too many requests|\b429\b/.test(t)) return "rate-limited";
  if (/network|econnrefused|enotfound|etimedout|socket hang up|fetch failed|econnreset/.test(t)) return "transport";
  return "nonzero-exit";
}

// --------------------------------------------------------------------------
// runCodex — spawn, timeout, JSONL parsing, mutation-safety evidence.
// --------------------------------------------------------------------------

// Which call kind a given (sandbox, resumeThreadId) pair represents. The
// caller does not get to declare this — it is derived from the same fields
// that determine the argv, so the timeout bound and the argv can never
// disagree about what kind of call this is.
function deriveCallKind(sandbox, resumeThreadId) {
  if (resumeThreadId) return "resume";
  if (sandbox === GRADER_SANDBOX) return "grader";
  if (sandbox === WORKER_SANDBOX) return "worker";
  throw new CodexTransportError(`cannot derive a call kind from sandbox ${JSON.stringify(sandbox)}`);
}

export async function runCodex(options) {
  const {
    cwd, prompt, schemaPath, outputPath, logPath,
    model = DEFAULT_MODEL, effort, sandbox, resumeThreadId = null,
    timeoutMs, env,
    codexBin = process.env.CODEX_BIN || "codex",
    spawnImpl = spawn,
    // Bounded grace period between SIGTERM and SIGKILL escalation. Kept
    // small and overridable (tests use a tiny value) so a hung fake/real
    // Codex process cannot itself stall the test suite or blow past the
    // worker's own timeout budget.
    killGraceMs = 5000,
  } = options ?? {};

  requireAbsolutePath(cwd, "options.cwd");
  requireNonEmptyString(prompt, "options.prompt");
  requireAbsolutePath(schemaPath, "options.schemaPath");
  requireAbsolutePath(outputPath, "options.outputPath");
  requireAbsolutePath(logPath, "options.logPath");

  // THE TIMEOUT BOUND IS DERIVED, NEVER RAISABLE BY INPUT.
  //
  // Previously `timeoutMs` was taken at face value, so a caller could pass
  // 86_400_000 for a `high` worker and the log would faithfully record that
  // 24-hour value as the "selected bound" while timeoutForCall("worker",
  // "high") said 900_000. The scheduler's bound was advisory, not enforced.
  //
  // Now the ceiling always comes from the same (kind, effort) derivation the
  // scheduler uses, and `timeoutMs` may only ever LOWER it, never raise it.
  // Lowering is safe in the direction that matters — it can only produce an
  // earlier, correctly-categorized timeout, never a longer-running process
  // holding a writable worktree — and it is what lets the timeout/SIGKILL
  // wiring be tested in milliseconds instead of 900 real seconds. Any
  // attempt to exceed the derived ceiling is rejected pre-spawn.
  const callKind = deriveCallKind(sandbox, resumeThreadId);
  const derivedTimeoutMs = timeoutForCall(callKind, callKind === "grader" ? undefined : effort);
  let effectiveTimeoutMs = derivedTimeoutMs;
  if (timeoutMs !== undefined) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CodexTransportError("options.timeoutMs must be a positive integer");
    }
    if (timeoutMs > derivedTimeoutMs) {
      throw new CodexTransportError(
        `options.timeoutMs ${timeoutMs} exceeds the derived bound for a "${callKind}" call at effort ${JSON.stringify(effort)} (${derivedTimeoutMs}ms). The timeout is derived from call kind and validated effort and can never be raised by input.`,
      );
    }
    effectiveTimeoutMs = timeoutMs;
  }

  // Every effort/sandbox rejection happens HERE, synchronously, before
  // anything is spawned — this is what makes "never invoked" provable for
  // every disallowed effort (fact #1).
  const argv = resumeThreadId
    ? buildResumeCodexArgs({ threadId: resumeThreadId, prompt, schemaPath, outputPath, model, effort })
    : buildFreshCodexArgs({ cwd, prompt, schemaPath, outputPath, model, effort, sandbox });

  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(codexBin, argv, {
        cwd, // resume is confined to the exact original worktree via cwd,
        // never via -C — see buildResumeCodexArgs. Fresh execution also
        // spawns here (both -C and cwd point at the same directory).
        env: env ?? process.env,
        // Fact #2: stdin MUST be closed on every spawn, or Codex blocks
        // forever on "Reading additional input from stdin…" even though the
        // prompt was supplied as an argv element.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({
        threadId: null,
        usage: null,
        finalOutputPath: null,
        logPath,
        exitCode: null,
        failureCategory: "transport",
      });
      return;
    }

    const acc = freshCodexEventAccumulator();
    const stdoutLines = [];
    let stderrBuf = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      stdoutLines.push(line);
      parseCodexEvent(line, acc);
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* not supported / already gone */ }
      }, killGraceMs);
    }, effectiveTimeoutMs);

    function writeLog(failureCategory, exitCode) {
      const text = [
        `$ ${codexBin} ${argv.join(" ")}`,
        `cwd: ${cwd}`,
        `callKind: ${callKind}`,
        `derivedTimeoutMs: ${derivedTimeoutMs}`,
        `timeoutMs: ${effectiveTimeoutMs}`,
        `exitCode: ${exitCode}`,
        `failureCategory: ${failureCategory ?? "null"}`,
        "",
        "=== stdout (jsonl) ===",
        stdoutLines.join("\n"),
        "",
        "=== stderr ===",
        stderrBuf,
        "",
      ].join("\n");
      try {
        writeFileSync(logPath, text, "utf8");
      } catch {
        // logging is best-effort; never fail the run over it
      }
    }

    function finalize(exitCode, forcedCategory) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try { rl.close(); } catch { /* already closed */ }

      let failureCategory = forcedCategory ?? null;
      if (!failureCategory) {
        if (timedOut) {
          failureCategory = "timeout";
        } else if (acc.malformed) {
          failureCategory = "malformed-jsonl";
        } else if (exitCode !== 0) {
          failureCategory = categorizeStderr(stderrBuf);
        } else if (!acc.sawThreadStarted) {
          failureCategory = "missing-thread-started";
        } else if (!acc.sawTurnCompleted) {
          failureCategory = "missing-turn-completed";
        } else if (!existsSync(outputPath)) {
          // A run can emit both authoritative events and exit 0 while never
          // actually writing the --output-last-message file. Reporting
          // success with a path to a nonexistent file would hand Task 9 a
          // path it expects to read the structured grade/report from; it
          // must be a categorized failure, not a success.
          failureCategory = "missing-output";
        }
      }

      writeLog(failureCategory, exitCode);

      // Mutation-safety evidence: threadId and failureCategory always come
      // from the same accumulator, regardless of the outcome. A non-null
      // threadId alongside a non-null failureCategory is, by construction,
      // the mutation-ambiguous case described at the top of this file.
      resolvePromise({
        threadId: acc.threadId,
        usage: acc.usage,
        finalOutputPath: failureCategory === null ? outputPath : null,
        logPath,
        exitCode,
        failureCategory,
      });
    }

    child.on("close", (code) => finalize(code));
    child.on("error", () => finalize(null, "transport"));
  });
}

// --------------------------------------------------------------------------
// Worker-side Superpowers preflight — read-only, never mutating. Never
// invokes `codex plugin add`, never invokes a login command, never
// recommends a nonexistent `codex plugin enable` command.
// --------------------------------------------------------------------------

export function parsePluginList(json) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch (err) {
    throw new CodexTransportError(`parsePluginList: invalid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.installed)) {
    throw new CodexTransportError('parsePluginList: expected an object with an "installed" array');
  }
  for (const entry of parsed.installed) {
    if (
      !entry || typeof entry !== "object"
      || typeof entry.pluginId !== "string"
      || typeof entry.installed !== "boolean"
      || typeof entry.enabled !== "boolean"
    ) {
      throw new CodexTransportError('parsePluginList: each installed[] entry must have string "pluginId" and boolean "installed"/"enabled"');
    }
  }
  return parsed;
}

export const REQUIRED_SUPERPOWERS_SKILLS = Object.freeze([
  "test-driven-development",
  "systematic-debugging",
  "verification-before-completion",
  "receiving-code-review",
]);

const SORTED_REQUIRED_SKILLS = [...REQUIRED_SUPERPOWERS_SKILLS].sort();

export function inspectSuperpowersSkills(pluginEntry) {
  if (!pluginEntry || typeof pluginEntry !== "object") {
    return { ok: false, reason: "no-entry", missingSkills: SORTED_REQUIRED_SKILLS, sourcePath: null, requiredSkills: SORTED_REQUIRED_SKILLS };
  }
  const source = pluginEntry.source;
  // The path must be ABSOLUTE, not merely non-empty. A relative path would
  // be join()ed against process.cwd() below, silently running the skill
  // inventory check against the user's own checkout instead of the plugin's
  // real install directory — which could spuriously "find" four
  // same-named directories that have nothing to do with the Codex plugin.
  // Brief Step 5: reject a non-local *or missing* path.
  if (
    !source || source.source !== "local"
    || typeof source.path !== "string" || source.path.length === 0
    || !source.path.startsWith("/")
  ) {
    return {
      ok: false,
      reason: "non-local-or-missing-source",
      missingSkills: SORTED_REQUIRED_SKILLS,
      sourcePath: source && typeof source.path === "string" ? source.path : null,
      requiredSkills: SORTED_REQUIRED_SKILLS,
    };
  }
  const skillsDir = join(source.path, "skills");
  const missingSkills = SORTED_REQUIRED_SKILLS.filter((name) => {
    try {
      return !statSync(join(skillsDir, name)).isDirectory();
    } catch {
      return true;
    }
  });
  return {
    ok: missingSkills.length === 0,
    reason: missingSkills.length === 0 ? null : "missing-skills",
    missingSkills,
    sourcePath: source.path,
    requiredSkills: SORTED_REQUIRED_SKILLS,
  };
}

const SUPERPOWERS_PLUGIN_ID = "superpowers@openai-curated";

// Capability probes, not version-string comparison, are the compatibility
// authority (brief, ambiguity resolution #5). 0.144.5 is the tested fixture
// baseline, never a version gate.
const EXEC_HELP_REQUIRED = [
  { name: "json-output", pattern: /--json\b/ },
  { name: "sandbox-selection", pattern: /(-s|--sandbox)\b[\s\S]*?read-only[\s\S]*?workspace-write/ },
  { name: "cd-flag", pattern: /(-C|--cd)\b/ },
  { name: "model-override", pattern: /(-m|--model)\b/ },
  { name: "config-override", pattern: /(-c|--config)\b/ },
  { name: "output-schema", pattern: /--output-schema\b/ },
  { name: "output-last-message", pattern: /(-o|--output-last-message)\b/ },
];
// Resume-only capabilities. A gap here does NOT hard-fail the preflight:
// fresh execution still works, and the brief documents a fresh-corrections
// fallback ("if the installed CLI cannot preserve that guarantee, preflight
// disables resume and requires fresh corrections"). These gaps therefore
// degrade `resumeSupported` to false instead of collapsing into
// `unsupported-codex-cli`, so Task 9 has a first-class field to branch on
// rather than having to string-match a prose message.
//
// Note that `config-override` is load-bearing here, not cosmetic: it is what
// carries the `-c sandbox_mode=workspace-write` pin. A resume interface
// without `-c` cannot be sandbox-pinned at all, so resume MUST be disabled
// in that case rather than run with an unpinned sandbox.
const RESUME_HELP_REQUIRED = [
  { name: "session-id-positional", pattern: /SESSION_ID/i },
  { name: "json-output", pattern: /--json\b/ },
  { name: "model-override", pattern: /(-m|--model)\b/ },
  { name: "config-override", pattern: /(-c|--config)\b/ },
  { name: "output-schema", pattern: /--output-schema\b/ },
  { name: "output-last-message", pattern: /(-o|--output-last-message)\b/ },
];
const PLUGIN_HELP_REQUIRED = [
  { name: "plugin-add-command-advertised", pattern: /\badd\b/ },
  { name: "plugin-list-command-advertised", pattern: /\blist\b/ },
];
const PLUGIN_LIST_HELP_REQUIRED = [
  { name: "plugin-list-json-flag", pattern: /--json\b/ },
];

const HELP_PROBES = [
  { argv: ["plugin", "--help"], required: PLUGIN_HELP_REQUIRED, label: "plugin --help", resumeOnly: false },
  { argv: ["plugin", "list", "--help"], required: PLUGIN_LIST_HELP_REQUIRED, label: "plugin list --help", resumeOnly: false },
  { argv: ["exec", "--help"], required: EXEC_HELP_REQUIRED, label: "exec --help", resumeOnly: false },
  { argv: ["exec", "resume", "--help"], required: RESUME_HELP_REQUIRED, label: "exec resume --help", resumeOnly: true },
];

function missingCapabilitiesFromHelp(text, required) {
  const missing = [];
  for (const req of required) {
    if (!req.pattern.test(text || "")) missing.push(req.name);
  }
  return missing;
}

function evidence(overrides) {
  return {
    ok: false,
    failureCategory: null,
    missingCapabilities: [],
    // Degraded-capability channel, distinct from the hard-failure channel.
    // Defaults to false so an early return (missing-codex, not-authenticated,
    // ...) never implies resume is usable; only a run that actually cleared
    // the resume probes sets it true.
    resumeSupported: false,
    missingResumeCapabilities: [],
    codexVersion: null,
    authSource: null,
    plugin: null,
    requiredSkills: SORTED_REQUIRED_SKILLS,
    missingSkills: [],
    message: null,
    ...overrides,
  };
}

export async function checkCodexPrerequisites(options) {
  const {
    codexBin = process.env.CODEX_BIN || "codex",
    cwd = process.cwd(),
    env,
    spawnSyncImpl = spawnSync,
  } = options ?? {};

  const effectiveEnv = env ?? process.env;
  const probe = (args) => spawnSyncImpl(codexBin, args, {
    cwd,
    env: effectiveEnv,
    // Read-only probes still close stdin, for the same reason every other
    // spawn in this module does (fact #2).
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  const versionResult = probe(["--version"]);
  if (versionResult.error || versionResult.status !== 0) {
    return evidence({
      failureCategory: "missing-codex",
      message: `codex CLI not found or not runnable at "${codexBin}". Install it and ensure it is on PATH.`,
    });
  }
  const codexVersion = (versionResult.stdout || "").trim();

  // Two separate buckets: a gap in a fresh-execution capability is a hard
  // failure, a gap in a resume-only capability merely disables resume.
  const missingCapabilities = [];
  const missingResumeCapabilities = [];
  for (const p of HELP_PROBES) {
    const bucket = p.resumeOnly ? missingResumeCapabilities : missingCapabilities;
    const res = probe(p.argv);
    if (res.error || res.status !== 0) {
      bucket.push(`${p.label}: probe failed`);
      continue;
    }
    const text = `${res.stdout || ""}\n${res.stderr || ""}`;
    for (const name of missingCapabilitiesFromHelp(text, p.required)) {
      bucket.push(`${p.label}: ${name}`);
    }
  }
  const resumeSupported = missingResumeCapabilities.length === 0;

  const pluginListJsonResult = probe(["plugin", "list", "--json"]);
  let pluginList = null;
  if (pluginListJsonResult.error || pluginListJsonResult.status !== 0) {
    missingCapabilities.push("plugin list --json: probe failed");
  } else {
    try {
      pluginList = parsePluginList(pluginListJsonResult.stdout);
    } catch {
      missingCapabilities.push("plugin list --json: invalid output shape");
    }
  }

  if (missingCapabilities.length > 0) {
    return evidence({
      failureCategory: "unsupported-codex-cli",
      missingCapabilities,
      resumeSupported,
      missingResumeCapabilities,
      codexVersion,
      message: `The installed Codex CLI (${codexVersion || "unknown version"}) is missing required capabilities: ${missingCapabilities.join("; ")}.`,
    });
  }

  // Auth: a read-only status check only. Never invoke a login command.
  const loginStatusResult = probe(["login", "status"]);
  let authSource;
  if (!loginStatusResult.error && loginStatusResult.status === 0) {
    authSource = "login";
  } else {
    // Non-zero login status: fall back to a non-empty CODEX_API_KEY. The
    // value itself is never read into the evidence object, logged, or
    // persisted below — only the fact of its presence is recorded.
    const apiKey = effectiveEnv.CODEX_API_KEY;
    if (typeof apiKey === "string" && apiKey.length > 0) {
      authSource = "environment";
    } else {
      return evidence({
        failureCategory: "not-authenticated",
        codexVersion,
        message: "codex login status failed and no CODEX_API_KEY environment variable is set. Run `codex login` yourself, or set CODEX_API_KEY — this script never runs a login command on your behalf.",
      });
    }
  }

  const entry = (pluginList?.installed ?? []).find((e) => e.pluginId === SUPERPOWERS_PLUGIN_ID) ?? null;
  if (!entry || entry.installed !== true) {
    return evidence({
      failureCategory: "missing-superpowers",
      resumeSupported,
      missingResumeCapabilities,
      codexVersion,
      authSource,
      message: `The "${SUPERPOWERS_PLUGIN_ID}" Codex plugin is not installed. Run \`codex plugin add ${SUPERPOWERS_PLUGIN_ID}\` yourself — this script never installs plugins on your behalf.`,
    });
  }
  if (entry.enabled !== true) {
    return evidence({
      failureCategory: "disabled-superpowers",
      resumeSupported,
      missingResumeCapabilities,
      codexVersion,
      authSource,
      plugin: { pluginId: entry.pluginId, version: entry.version ?? null, sourcePath: entry.source?.path ?? null },
      // Deliberately does NOT recommend a nonexistent `codex plugin enable`
      // command (brief, Step 5) — there isn't one.
      message: `The "${SUPERPOWERS_PLUGIN_ID}" Codex plugin is installed but disabled. Re-enable it yourself via the Codex CLI's own plugin management — this script never changes plugin state on your behalf.`,
    });
  }

  const skillsCheck = inspectSuperpowersSkills(entry);
  const pluginEvidence = { pluginId: entry.pluginId, version: entry.version ?? null, sourcePath: skillsCheck.sourcePath };
  if (!skillsCheck.ok) {
    return evidence({
      failureCategory: "incomplete-superpowers",
      resumeSupported,
      missingResumeCapabilities,
      codexVersion,
      authSource,
      plugin: pluginEvidence,
      requiredSkills: skillsCheck.requiredSkills,
      missingSkills: skillsCheck.missingSkills,
      message: `The "${SUPERPOWERS_PLUGIN_ID}" Codex plugin is installed and enabled, but its skill inventory is incomplete (${skillsCheck.reason}): ${skillsCheck.missingSkills.join(", ") || "no local source path"}.`,
    });
  }

  return evidence({
    ok: true,
    failureCategory: null,
    resumeSupported,
    missingResumeCapabilities,
    codexVersion,
    authSource,
    plugin: pluginEvidence,
    requiredSkills: skillsCheck.requiredSkills,
  });
}
