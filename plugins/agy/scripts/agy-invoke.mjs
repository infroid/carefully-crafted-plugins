#!/usr/bin/env node
// agy-invoke.mjs — wraps Google's Antigravity CLI (`agy -p`) for
// non-interactive delegation from Claude Code.
//
// Usage:
//   node agy-invoke.mjs --prompt "<task>" [--json] [--cwd <dir>] [--verbose]
//
// Flags:
//   --prompt "<task>"   the task to hand to Antigravity (required)
//   --json              request structured output (`--output-format json`)
//   --cwd <dir>         working directory for the agy process
//   --verbose           stream Antigravity's stderr trace; off by default to
//                       keep the caller's context clean
//
// Env (a flag wins over its env equivalent):
//   AGY_BIN             path to the agy binary, default "agy"
//   AGY_TIMEOUT_SEC     timeout in seconds, default 600
//   AGY_VERBOSE         "1" to force verbose
//
// Note: the Antigravity CLI is new (Antigravity 2.0, 2026). This wrapper
// targets the documented non-interactive form `agy -p "<prompt>"` with an
// optional `--output-format json`. If a future agy release changes that
// surface, update the argv assembled in main().
//
// Exit codes:
//   0  success
//   1  agy runtime error (not-installed, not-authed, rate-limited, timeout, unknown)
//   2  invocation/config error

import { spawn, spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function preflightAgyInstalled(agyBin) {
  const probe = spawnSync(agyBin, ["--version"], { stdio: "ignore" });
  // Only a missing binary is fatal here. A new CLI may not support --version,
  // so a non-zero exit is not treated as "not installed".
  if (probe.error && probe.error.code === "ENOENT") {
    console.error(`agy-invoke: '${agyBin}' not found on PATH.`);
    console.error("Install the Antigravity CLI:");
    console.error("  curl -fsSL https://antigravity.google/cli/install.sh | bash");
    console.error("Then run 'agy' once to sign in. Or set AGY_BIN to an explicit path.");
    process.exit(1);
  }
}

function categorizeError(stderrText) {
  const t = (stderrText || "").toLowerCase();
  if (/sign[\s-]?in|authoriz|not\s+authenticated|keyring|login/.test(t)) return "not-authed";
  if (/rate.?limit|quota|too many requests|429/.test(t)) return "rate-limited";
  return "unknown";
}

function runAgy({ agyBin, agyArgs, cwd, timeoutMs, verbose }) {
  return new Promise((resolveP) => {
    const child = spawn(agyBin, agyArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });

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
      process.stdout.write(s); // stdout is the deliverable — always surface it
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      if (verbose) process.stderr.write(s);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveP({ code: -1, stdout, stderr, error: err, timedOut: false });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const agyBin = process.env.AGY_BIN || "agy";
  const timeoutMs = Math.max(1, Number(process.env.AGY_TIMEOUT_SEC) || 600) * 1000;
  const verbose = args["verbose"] === true || process.env.AGY_VERBOSE === "1";

  if (typeof args["prompt"] !== "string" || args["prompt"].trim() === "") {
    console.error('agy-invoke: must pass --prompt "<task>"');
    process.exit(2);
  }

  preflightAgyInstalled(agyBin);

  const agyArgs = ["-p", args["prompt"]];
  if (args["json"] === true) agyArgs.push("--output-format", "json");

  const cwd = typeof args["cwd"] === "string" ? args["cwd"] : process.cwd();

  const result = await runAgy({ agyBin, agyArgs, cwd, timeoutMs, verbose });

  if (result.timedOut) {
    console.error(`\nagy-invoke: timed out after ${timeoutMs / 1000}s. Raise AGY_TIMEOUT_SEC if expected.`);
    process.exit(1);
  }
  if (result.code !== 0) {
    const category = categorizeError(result.stderr);
    console.error(`\nagy-invoke: agy failed (category: ${category}, exit ${result.code}).`);
    if (!verbose && result.stderr && result.stderr.trim()) {
      console.error(result.stderr.trim().slice(0, 2000));
    }
    process.exit(1);
  }
  process.exit(0);
}

main();
