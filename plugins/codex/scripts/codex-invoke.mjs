#!/usr/bin/env node
// codex-invoke.mjs — wraps `codex exec`, maps errors into stable categories,
// and keeps Codex's verbose trace out of the caller's context by default.
//
// Usage:
//   node codex-invoke.mjs --spec-path <abs path> [options]
//   node codex-invoke.mjs --raw "<prompt>"        [options]
//   node codex-invoke.mjs --resume-last --raw "<follow-up>" [--verbose]
//
// Options:
//   --imagegen               Prefix the prompt with `$imagegen` (gpt-image-2).
//   --ref <path>             Attach a reference image. May be repeated.
//   --model <name>           Pass `-m <name>` to codex. Omit to use the
//                            account default model.
//   --reasoning-effort <e>   One of: low | medium | high | xhigh.
//   --sandbox <mode>         read-only | workspace-write | danger-full-access.
//                            Default: read-only.
//   --resume-last            Resume the most recent codex session in the cwd
//                            (`codex exec resume --last`). Requires --raw.
//                            The resumed session inherits the original
//                            model, reasoning effort, and sandbox.
//   --verbose                Stream Codex's full stdout/stderr live. Off by
//                            default to protect the caller's context window.
//
// Env (a flag always wins over its env equivalent):
//   CODEX_TIMEOUT_SEC        timeout in seconds, default 120
//   CODEX_BIN                path to the codex binary, default "codex"
//   CODEX_SANDBOX            default sandbox mode, default "read-only"
//   CODEX_MODEL              default model
//   CODEX_REASONING_EFFORT   default reasoning effort
//   CODEX_VERBOSE            "1" to force verbose
//
// Exit codes:
//   0  success
//   1  codex runtime error (not-installed, not-authed, rate-limited, timeout, unknown)
//   2  invocation/config error

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function parseArgs(argv) {
  const args = { ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const hasVal = next !== undefined && !next.startsWith("--");
    if (key === "ref") {
      if (!hasVal) {
        console.error("codex-invoke: --ref requires a path argument");
        process.exit(2);
      }
      args.ref.push(next);
      i++;
    } else if (!hasVal) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function preflightCodexInstalled(codexBin) {
  const probe = spawnSync(codexBin, ["--version"], { stdio: "ignore" });
  if (probe.error && probe.error.code === "ENOENT") {
    console.error(`codex-invoke: '${codexBin}' not found on PATH.`);
    console.error("Install via 'npm install -g @openai/codex' or 'brew install codex',");
    console.error("then run 'codex login'. Or set CODEX_BIN to an explicit path.");
    process.exit(1);
  }
  if (probe.status !== 0) {
    console.error(`codex-invoke: '${codexBin} --version' exited ${probe.status}`);
    process.exit(1);
  }
}

function categorizeError(stderrText) {
  const t = stderrText.toLowerCase();
  if (/authenticat|not\s+signed|sign\s*in|login required/.test(t)) return "not-authed";
  if (/rate.?limit|too many requests|429/.test(t)) return "rate-limited";
  if (/unknown model|invalid model|no such model/.test(t)) return "bad-model";
  return "unknown";
}

// Runs codex and resolves with { code, stdout, stderr, timedOut }.
// stdout is echoed live only when `showStdout` (raw/resume modes, where stdout
// is the deliverable) or `verbose` is set. stderr is echoed live only when
// `verbose` is set. The full trace is always written to `logPath` if given.
function runCodex({ codexBin, codexArgs, timeoutMs, verbose, showStdout, logPath }) {
  return new Promise((resolveP) => {
    const child = spawn(codexBin, codexArgs, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      if (verbose || showStdout) process.stdout.write(s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      if (verbose) process.stderr.write(s);
    });

    const done = (result) => {
      clearTimeout(timer);
      if (logPath) {
        try {
          writeFileSync(
            logPath,
            `$ ${codexBin} ${codexArgs.join(" ")}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
            "utf8",
          );
        } catch {
          /* logging is best-effort; never fail the run over it */
        }
      }
      resolveP(result);
    };

    child.on("close", (code) => done({ code, stdout, stderr, timedOut }));
    child.on("error", (err) => done({ code: -1, stdout, stderr, error: err, timedOut: false }));
  });
}

function failFastOnError(result, timeoutMs, verbose) {
  if (result.timedOut) {
    console.error(`\ncodex-invoke: timed out after ${timeoutMs / 1000}s. Raise CODEX_TIMEOUT_SEC if expected.`);
    process.exit(1);
  }
  if (result.code !== 0) {
    const category = categorizeError(result.stderr || "");
    console.error(`\ncodex-invoke: codex exec failed (category: ${category}, exit ${result.code}).`);
    // stderr was suppressed during the run when not verbose — surface it now.
    if (!verbose && result.stderr && result.stderr.trim()) {
      console.error(result.stderr.trim().slice(0, 2000));
    }
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codexBin = process.env.CODEX_BIN || "codex";
  const timeoutMs = Math.max(1, Number(process.env.CODEX_TIMEOUT_SEC) || 120) * 1000;
  const verbose = args["verbose"] === true || process.env.CODEX_VERBOSE === "1";
  const resumeLast = args["resume-last"] === true;
  const useImagegen = args["imagegen"] === true;

  const sandbox = typeof args["sandbox"] === "string"
    ? args["sandbox"]
    : (process.env.CODEX_SANDBOX || "read-only");
  if (!SANDBOXES.has(sandbox)) {
    console.error(`codex-invoke: invalid --sandbox '${sandbox}'. Use one of: ${[...SANDBOXES].join(", ")}`);
    process.exit(2);
  }

  const model = typeof args["model"] === "string" ? args["model"] : (process.env.CODEX_MODEL || null);
  const reasoningEffort = typeof args["reasoning-effort"] === "string"
    ? args["reasoning-effort"]
    : (process.env.CODEX_REASONING_EFFORT || null);
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    console.error(`codex-invoke: invalid --reasoning-effort '${reasoningEffort}'. Use one of: ${[...REASONING_EFFORTS].join(", ")}`);
    process.exit(2);
  }

  preflightCodexInstalled(codexBin);

  const refPaths = (args.ref || []).map((p) => resolve(p));
  for (const p of refPaths) {
    if (!existsSync(p)) {
      console.error(`codex-invoke: --ref path does not exist: ${p}`);
      process.exit(2);
    }
  }

  // Resume: a raw follow-up to the most recent session in this directory.
  // The resumed session inherits model/effort/sandbox, so we pass none of them.
  if (resumeLast) {
    if (typeof args["raw"] !== "string") {
      console.error('codex-invoke: --resume-last requires --raw "<follow-up prompt>"');
      process.exit(2);
    }
    const codexArgs = ["exec", "--skip-git-repo-check", "resume", "--last", args["raw"]];
    const result = await runCodex({ codexBin, codexArgs, timeoutMs, verbose, showStdout: true, logPath: null });
    failFastOnError(result, timeoutMs, verbose);
    process.exit(0);
  }

  // Build the prompt.
  let prompt;
  let outputLastMessage = null;
  let logPath = null;
  let outputSchema = null;
  let rawMode = false;

  if (typeof args["raw"] === "string") {
    prompt = args["raw"];
    rawMode = true;
  } else if (typeof args["spec-path"] === "string") {
    const specPath = resolve(args["spec-path"]);
    if (!existsSync(specPath)) {
      console.error(`codex-invoke: spec file does not exist: ${specPath}`);
      process.exit(2);
    }
    prompt = `Read and execute the handoff spec at ${specPath}. Follow all referenced constraint and output-format files cited in sections 3 and 4. Return your output conforming to the JSON schema provided via --output-schema.`;
    const resultDir = dirname(specPath);
    mkdirSync(resultDir, { recursive: true });
    const base = basename(specPath).replace(/\.md$/, "");
    outputLastMessage = join(resultDir, `result-${base}.txt`);
    logPath = join(resultDir, `log-${base}.txt`);
    outputSchema = resolve(new URL("./output-schema.json", import.meta.url).pathname);
  } else {
    console.error('codex-invoke: must pass --spec-path <abs path>, --raw "<prompt>", or --resume-last --raw "<prompt>"');
    process.exit(2);
  }

  if (useImagegen) {
    // Canonical format that activates Codex's built-in image-generation skill
    // (gpt-image-2): the prompt must begin with `$imagegen` and frame the
    // request as a direct image description.
    prompt = `$imagegen Generate an image based on the following requirements:\n${prompt}`;
  }

  // Assemble the codex argv. Order: exec, global flags, prompt, output flags.
  const codexArgs = ["exec", "--skip-git-repo-check", "--sandbox", sandbox];
  if (model) codexArgs.push("-m", model);
  if (reasoningEffort) codexArgs.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  for (const p of refPaths) codexArgs.push("-i", p);
  codexArgs.push(prompt);
  if (outputLastMessage) codexArgs.push("--output-last-message", outputLastMessage);
  if (outputSchema) codexArgs.push("--output-schema", outputSchema);

  // Spec mode: the answer lands in the result file, so stdout during the run
  // is pure noise — suppress it. Raw mode: stdout IS the deliverable — show it.
  const result = await runCodex({
    codexBin,
    codexArgs,
    timeoutMs,
    verbose,
    showStdout: rawMode,
    logPath,
  });

  failFastOnError(result, timeoutMs, verbose);

  if (outputLastMessage) process.stdout.write(`\n[codex-invoke] last message saved to: ${outputLastMessage}\n`);
  if (logPath) process.stdout.write(`[codex-invoke] full trace: ${logPath}\n`);
  process.exit(0);
}

main();
