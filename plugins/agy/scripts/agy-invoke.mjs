#!/usr/bin/env node
// agy-invoke.mjs — wraps Google's Antigravity CLI (`agy -p`) for
// non-interactive delegation from Claude Code.
//
// Usage:
//   node agy-invoke.mjs --prompt "<task>" [--json] [--cwd <dir>] [--verbose]
//                       [--collect <dir>]
//
// Flags:
//   --prompt "<task>"   the task to hand to Antigravity (required)
//   --json              request structured output (`--output-format json`)
//   --cwd <dir>         working directory for the agy process
//   --verbose           stream Antigravity's stderr trace; off by default to
//                       keep the caller's context clean
//   --collect <dir>     after a successful run, scan agy's stdout for produced
//                       artifact paths (file:// links or absolute media paths)
//                       and copy them into <dir>. Antigravity writes images to
//                       its own sandbox (~/.gemini/antigravity-cli/scratch/) and
//                       ignores prompt-stated save paths, so this is how the
//                       agy-direct image fallback lands artifacts where the
//                       caller asked. Prints "collected: <dest>" per file.
//
// Env (a flag wins over its env equivalent):
//   AGY_BIN             path to the agy binary, default "agy"
//   AGY_TIMEOUT_SEC     timeout in seconds, default 600
//   AGY_VERBOSE         "1" to force verbose
//
// Note on model / effort / verbosity:
//   The sibling codex-invoke.mjs defaults to "best model + highest effort +
//   lowest verbosity". This wrapper would like to do the same, but as of
//   agy 1.0.2 the non-interactive `agy -p` surface exposes NO --model,
//   --reasoning-effort, or --verbosity flags. Model selection and
//   thinking-mode live in the Antigravity client/IDE
//   (Settings → Model / Reasoning), and the CLI inherits whatever is set
//   there — verify the IDE is configured to your preferred model + highest
//   reasoning level + terse output. If a future agy release adds real CLI
//   flags for these, plumb them through `runAgy()` below; this wrapper
//   deliberately does not mutate the prompt with "be terse" / "think harder"
//   directives, since those are unreliable and silently change behavior.
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
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Media extensions agy might produce. Used to spot bare absolute paths in prose.
const MEDIA_RE = /\.(png|jpe?g|webp|gif|svg|bmp|tiff?|mp4|mov|webm|m4v|avif)$/i;

// Scan agy's stdout for artifact paths it reports. Antigravity surfaces results
// as markdown links `[name](file:///abs/path)` and sometimes as bare absolute
// paths in prose. Returns a de-duplicated list of existing local file paths.
export function parseArtifacts(stdout) {
  const found = new Set();
  const text = stdout || "";

  // file:// URIs (decode %20 etc.)
  for (const m of text.matchAll(/file:\/\/(\/[^\s)'"<>]+)/g)) {
    try {
      found.add(decodeURIComponent(m[1]));
    } catch {
      found.add(m[1]);
    }
  }
  // Bare absolute media paths (POSIX). Trim trailing markdown/punctuation
  // (closing parens/brackets, quotes, commas, periods, asterisks, backticks).
  for (const m of text.matchAll(/(?:^|[\s('"`*[])(\/[^\s)'"<>`]+)/g)) {
    const p = m[1].replace(/[)\].,'"`*]+$/, "");
    if (MEDIA_RE.test(p)) found.add(p);
  }

  return [...found].filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

// Copy collected artifacts into destDir without clobbering: on a name clash add
// a numeric suffix. Returns the list of destination paths written.
export function collectArtifacts(stdout, destDir) {
  const artifacts = parseArtifacts(stdout);
  if (artifacts.length === 0) return [];
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const src of artifacts) {
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let dest = path.join(destDir, base + ext);
    let n = 1;
    while (fs.existsSync(dest) && fs.realpathSync(dest) !== safeRealpath(src)) {
      dest = path.join(destDir, `${base}-${n}${ext}`);
      n++;
    }
    if (!(fs.existsSync(dest) && fs.realpathSync(dest) === safeRealpath(src))) {
      fs.copyFileSync(src, dest);
    }
    written.push(dest);
  }
  return written;
}

function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// valueFlags are flags that always take the following token as their value —
// even if that token itself starts with "--" (e.g. a prompt that begins with a
// dash). `--key=value` is also accepted. Unknown flags keep the boolean
// heuristic (a following "--…" token starts a new flag).
function parseArgs(argv, valueFlags = new Set()) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const key = body;
    const next = argv[i + 1];
    if (valueFlags.has(key)) {
      if (next === undefined) args[key] = true;
      else { args[key] = next; i++; }
    } else if (next === undefined || next.startsWith("--")) {
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
  const args = parseArgs(process.argv.slice(2), new Set(["prompt", "cwd", "collect"]));
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

  if (typeof args["collect"] === "string") {
    try {
      const written = collectArtifacts(result.stdout, args["collect"]);
      if (written.length === 0) {
        console.error("agy-invoke: --collect found no artifact paths in agy output.");
      } else {
        for (const dest of written) console.log(`collected: ${dest}`);
      }
    } catch (err) {
      console.error(`agy-invoke: --collect failed: ${err.message}`);
    }
  }

  process.exit(0);
}

// Only run the CLI when executed directly, so tests can import the exported
// helpers (parseArtifacts/collectArtifacts) without triggering a real run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
