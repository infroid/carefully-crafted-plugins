#!/usr/bin/env node
// result-handler.mjs — parses Codex's result file, appends a session-log pointer
// to the handoff spec, and prints a summary for Claude Code to relay.
//
// Usage:
//   node result-handler.mjs --spec-path <abs path> --type <image|text|code|data>
//
// Exit codes:
//   0  success
//   2  invocation/config error (missing args, missing files)

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

function loadStructured(resultText) {
  if (!resultText || !resultText.trim()) return null;
  const trimmed = resultText.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "")
    : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function todayCodexSessionDir() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `~/.codex/sessions/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}/`;
}

function appendSessionPointer(specPath) {
  const note = `\n---\n_Codex session logs: ${todayCodexSessionDir()}_\n`;
  appendFileSync(specPath, note, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (typeof args["spec-path"] !== "string") {
    console.error("result-handler: missing --spec-path");
    process.exit(2);
  }
  if (typeof args["type"] !== "string") {
    console.error("result-handler: missing --type (one of: image, text, code, data)");
    process.exit(2);
  }

  const specPath = resolve(args["spec-path"]);
  if (!existsSync(specPath)) {
    console.error(`result-handler: spec file not found: ${specPath}`);
    process.exit(2);
  }

  const base = basename(specPath).replace(/\.md$/, "");
  const resultPath = join(dirname(specPath), `result-${base}.txt`);

  let resultText = "";
  if (existsSync(resultPath)) {
    resultText = readFileSync(resultPath, "utf8");
  } else {
    console.error(`result-handler: no result file at ${resultPath} — Codex may not have produced output. Continuing with empty summary.`);
  }

  const structured = loadStructured(resultText);

  appendSessionPointer(specPath);

  console.log("=== Codex delegation summary ===");
  console.log(`Spec:    ${specPath}`);
  console.log(`Result:  ${resultPath}`);
  console.log(`Type:    ${args["type"]}`);

  if (structured) {
    console.log(`Status:  ${structured.status ?? "(unspecified)"}`);
    if (structured.summary) console.log(`Summary: ${structured.summary}`);
    if (Array.isArray(structured.artifacts) && structured.artifacts.length) {
      console.log("Artifacts:");
      for (const a of structured.artifacts) {
        console.log(`  - [${a.type}] ${a.path}${a.description ? " — " + a.description : ""}`);
      }
    }
    if (Array.isArray(structured.assumptions) && structured.assumptions.length) {
      console.log("Assumptions Codex made:");
      for (const a of structured.assumptions) console.log(`  - ${a}`);
    }
    if (Array.isArray(structured.errors) && structured.errors.length) {
      console.log("Warnings/errors:");
      for (const e of structured.errors) console.log(`  - ${e}`);
    }
  } else if (resultText.trim()) {
    console.log("Raw result (not JSON-conforming):");
    console.log(resultText.trim().slice(0, 4000));
    if (resultText.length > 4000) console.log(`... [truncated, full result at ${resultPath}]`);
  } else {
    console.log("(no result text)");
  }
}

main();
