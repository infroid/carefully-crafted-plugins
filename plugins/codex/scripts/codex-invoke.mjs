#!/usr/bin/env node
// codex-invoke.mjs — wraps `codex exec` and maps errors into stable categories.
//
// Usage:
//   node codex-invoke.mjs --spec-path <abs path> [--imagegen] [--ref <path> ...]
//   node codex-invoke.mjs --raw "<prompt>"           [--imagegen] [--ref <path> ...]
//
// Flags:
//   --imagegen          Prefix the prompt with `$imagegen` so Codex routes to
//                       its built-in image-generation skill (gpt-image-2).
//   --ref <path>        Attach a reference image. May be repeated.
//
// Env:
//   CODEX_TIMEOUT_SEC   timeout in seconds, default 120
//   CODEX_BIN           path to codex binary, default "codex"
//   CODEX_SANDBOX       sandbox mode, default "workspace-write"
//                       (read-only | workspace-write | danger-full-access)
//
// Exit codes:
//   0  success
//   1  codex runtime error (one of: not-installed, not-authed, rate-limited, timeout, unknown)
//   2  invocation/config error

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
    console.error("then run 'codex auth'. Or set CODEX_BIN to an explicit path.");
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
  return "unknown";
}

function runCodex({ codexBin, prompt, outputLastMessage, outputSchema, sandbox, refPaths, timeoutMs }) {
  return new Promise((resolveP) => {
    const codexArgs = ["exec"];
    if (sandbox) codexArgs.push("--sandbox", sandbox);
    for (const p of refPaths || []) codexArgs.push("-i", p);
    codexArgs.push(prompt);
    if (outputLastMessage) codexArgs.push("--output-last-message", outputLastMessage);
    if (outputSchema) codexArgs.push("--output-schema", outputSchema);

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
      process.stdout.write(s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      process.stderr.write(s);
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
  const codexBin = process.env.CODEX_BIN || "codex";
  const timeoutMs = Math.max(1, Number(process.env.CODEX_TIMEOUT_SEC) || 120) * 1000;
  const sandbox = process.env.CODEX_SANDBOX || "workspace-write";

  preflightCodexInstalled(codexBin);

  let prompt;
  let outputLastMessage = null;
  const outputSchema = resolve(new URL("./output-schema.json", import.meta.url).pathname);
  const useImagegen = args["imagegen"] === true;
  const refPaths = (args.ref || []).map((p) => resolve(p));

  for (const p of refPaths) {
    if (!existsSync(p)) {
      console.error(`codex-invoke: --ref path does not exist: ${p}`);
      process.exit(2);
    }
  }

  if (typeof args["raw"] === "string") {
    prompt = args["raw"];
  } else if (typeof args["spec-path"] === "string") {
    const specPath = resolve(args["spec-path"]);
    if (!existsSync(specPath)) {
      console.error(`codex-invoke: spec file does not exist: ${specPath}`);
      process.exit(2);
    }
    prompt = `Read and execute the handoff spec at ${specPath}. Follow all referenced constraint and output-format files cited in sections 3 and 4. Return your output conforming to the JSON schema provided via --output-schema.`;
    const resultDir = join(dirname(specPath));
    mkdirSync(resultDir, { recursive: true });
    const base = specPath.split("/").pop().replace(/\.md$/, "");
    outputLastMessage = join(resultDir, `result-${base}.txt`);
  } else {
    console.error("codex-invoke: must pass --spec-path <abs path> or --raw \"<prompt>\"");
    process.exit(2);
  }

  if (useImagegen) {
    // Canonical format that activates Codex's built-in image-generation skill
    // (gpt-image-2). Verified working in codex-cli 0.130 — prompt must begin
    // with `$imagegen` and frame the request as a direct image description.
    prompt = `$imagegen Generate an image based on the following requirements:\n${prompt}`;
  }

  const { code, stderr, timedOut } = await runCodex({
    codexBin,
    prompt,
    outputLastMessage,
    outputSchema: args["raw"] ? null : outputSchema,
    sandbox,
    refPaths,
    timeoutMs,
  });

  if (timedOut) {
    console.error(`\ncodex-invoke: timed out after ${timeoutMs / 1000}s. Raise CODEX_TIMEOUT_SEC if expected.`);
    process.exit(1);
  }

  if (code !== 0) {
    const category = categorizeError(stderr);
    console.error(`\ncodex-invoke: codex exec failed (category: ${category}, exit ${code}).`);
    process.exit(1);
  }

  if (outputLastMessage) process.stdout.write(`\n[codex-invoke] last message saved to: ${outputLastMessage}\n`);
  process.exit(0);
}

main();
