#!/usr/bin/env node
// spec-builder.mjs — assembles the 5-section handoff spec and writes it to disk.
//
// Usage:
//   node spec-builder.mjs \
//     --task-slug <slug> \
//     --role <role> \
//     --task <task> \
//     --how <how> \
//     --constraints <comma-separated abs paths> \
//     --output-format <abs path> \
//     --artifact-path <repo-relative path> \
//     --clarifications <summary> \
//     [--session-artifact <abs path>] \
//     [--handoffs-dir <abs path>]   (default: <cwd>/docs/carefully-crafted-plugins/handoffs)
//
// On success: prints the absolute path of the written spec to stdout, exits 0.
// On missing referenced files: prints a human-readable list to stderr, exits 2.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

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

function requireArg(args, name) {
  if (args[name] === undefined || args[name] === true) {
    console.error(`spec-builder: missing required --${name}`);
    process.exit(2);
  }
  return args[name];
}

function isoStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isoTimestamp() {
  return new Date().toISOString();
}

function validateFiles(paths) {
  const missing = paths.filter((p) => p && !existsSync(p));
  return missing;
}

function buildSpec({
  slug,
  timestamp,
  sessionArtifact,
  role,
  task,
  how,
  constraintPaths,
  outputFormatPath,
  artifactPath,
  clarifications,
}) {
  const constraintsList = constraintPaths.length
    ? constraintPaths.map((p) => `- ${p}`).join("\n")
    : "- (none)";
  const sessionLine = sessionArtifact
    ? `Session artifact: ${sessionArtifact}`
    : "Session artifact: (none)";

  return `# Handoff Spec: ${slug}
Generated: ${timestamp}
${sessionLine}

## 1. What To Do
Role: ${role}
Task: ${task}

## 2. How To Do
${how}

## 3. Constraints
<!-- Reference only. Read each file directly; do not paraphrase. -->
${constraintsList}

## 4. Expected Output
<!-- Reference only. Read this file directly for the output contract. -->
- ${outputFormatPath}
Output artifact path: ${artifactPath}

## 5. Pre-flight Clarifications
<!-- Resolved with the user before this spec was written. Informational. -->
${clarifications}
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const slug = requireArg(args, "task-slug");
  const role = requireArg(args, "role");
  const task = requireArg(args, "task");
  const how = requireArg(args, "how");
  const constraintsRaw = requireArg(args, "constraints");
  const outputFormat = requireArg(args, "output-format");
  const artifactPath = requireArg(args, "artifact-path");
  const clarifications = requireArg(args, "clarifications");
  const sessionArtifact = typeof args["session-artifact"] === "string" ? args["session-artifact"] : null;

  const constraintPaths = constraintsRaw === "none" || constraintsRaw === ""
    ? []
    : constraintsRaw.split(",").map((p) => p.trim()).filter(Boolean);

  const referencedFiles = [...constraintPaths, outputFormat];
  const missing = validateFiles(referencedFiles);
  if (missing.length) {
    console.error("spec-builder: referenced files do not exist:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("\nResolve with the user (create the file or remove the reference), then re-run.");
    process.exit(2);
  }

  const handoffsDir = typeof args["handoffs-dir"] === "string"
    ? resolve(args["handoffs-dir"])
    : resolve(process.cwd(), "docs/carefully-crafted-plugins/handoffs");

  mkdirSync(handoffsDir, { recursive: true });

  const stamp = isoStamp();
  const filename = `${stamp}-${slug}.md`;
  const specPath = join(handoffsDir, filename);

  const body = buildSpec({
    slug,
    timestamp: isoTimestamp(),
    sessionArtifact,
    role,
    task,
    how,
    constraintPaths,
    outputFormatPath: outputFormat,
    artifactPath,
    clarifications,
  });

  writeFileSync(specPath, body, "utf8");
  process.stdout.write(specPath + "\n");
}

main();
