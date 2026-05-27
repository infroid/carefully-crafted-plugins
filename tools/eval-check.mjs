#!/usr/bin/env node
// Validates the structure of every plugins/*/skills/*/evals/evals.json,
// going beyond the lint's minimal "exists + has assertions" check.
//
// Per file:
//   - top-level: skill_name (string), evals (array)
//   - per eval: id, prompt (non-empty), expected_outcome (non-empty), assertions (array)
//   - per assertion: name (kebab-case), type (one of a known set), description
//   - assertion names unique within an eval
//
// Surfaces stats: total evals, total assertions, types used, prompts under
// a reasonable length, etc. Exits 0 if all valid, 1 otherwise.
//
// Usage:
//   node tools/eval-check.mjs            # walk all evals
//   node tools/eval-check.mjs <file> ... # validate specific files

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Known assertion types — extend as we add more.
const ASSERTION_TYPES = new Set([
  "command-trace",      // a subprocess was (or was not) invoked with specific args
  "spec-content",       // the 5-section spec contains a specific field/value
  "artifact-content",   // the written artifact contains specific content
  "artifact",           // the triage/forge JSON artifact has a specific field/value
  "file-exists",        // a file exists at a path matching a pattern
  "conversation",       // Claude's reply to the user matches a pattern
]);

const PROMPT_MIN_CHARS = 8;
const PROMPT_MAX_CHARS = 500;

function findEvalFiles() {
  const files = [];
  const pluginsDir = path.join(REPO_ROOT, "plugins");
  if (!fs.existsSync(pluginsDir)) return files;
  for (const plugin of fs.readdirSync(pluginsDir).sort()) {
    const skillsDir = path.join(pluginsDir, plugin, "skills");
    if (!fs.existsSync(skillsDir)) continue;
    for (const skill of fs.readdirSync(skillsDir).sort()) {
      const f = path.join(skillsDir, skill, "evals", "evals.json");
      if (fs.existsSync(f)) files.push(f);
    }
  }
  return files;
}

function validateOne(filePath) {
  const findings = { errors: [], warnings: [] };
  const stats = { evals: 0, assertions: 0, types: new Map() };

  let content;
  try {
    content = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    findings.errors.push(`invalid JSON: ${e.message}`);
    return { findings, stats };
  }

  if (typeof content.skill_name !== "string" || !content.skill_name) {
    findings.errors.push("missing skill_name");
  }

  if (!Array.isArray(content.evals)) {
    findings.errors.push("evals must be an array");
    return { findings, stats };
  }

  const seenIds = new Set();
  for (const e of content.evals) {
    stats.evals++;

    const tag = `eval ${e.id ?? "?"}`;
    if (e.id === undefined || e.id === null) {
      findings.errors.push(`${tag}: missing id`);
    } else if (seenIds.has(e.id)) {
      findings.errors.push(`${tag}: duplicate id`);
    } else {
      seenIds.add(e.id);
    }

    if (typeof e.prompt !== "string" || e.prompt.trim().length === 0) {
      findings.errors.push(`${tag}: missing prompt`);
    } else if (e.prompt.length < PROMPT_MIN_CHARS) {
      findings.warnings.push(`${tag}: prompt is only ${e.prompt.length} chars — unrealistic for a real user task`);
    } else if (e.prompt.length > PROMPT_MAX_CHARS) {
      findings.warnings.push(`${tag}: prompt is ${e.prompt.length} chars — consider tightening`);
    }

    if (typeof e.expected_outcome !== "string" || !e.expected_outcome) {
      findings.warnings.push(`${tag}: missing expected_outcome (recommended but not required)`);
    }

    if (!Array.isArray(e.assertions) || e.assertions.length === 0) {
      findings.errors.push(`${tag}: must have at least one assertion`);
      continue;
    }

    const assertionNames = new Set();
    for (const a of e.assertions) {
      stats.assertions++;

      if (typeof a.name !== "string" || !a.name) {
        findings.errors.push(`${tag}: assertion missing name`);
        continue;
      }
      if (!/^[a-z][a-z0-9_]*$/.test(a.name)) {
        findings.errors.push(`${tag}: assertion name "${a.name}" must be lowercase letters/digits/underscores, starting with a letter`);
      }
      if (assertionNames.has(a.name)) {
        findings.errors.push(`${tag}: duplicate assertion name "${a.name}"`);
      }
      assertionNames.add(a.name);

      if (a.type !== undefined && !ASSERTION_TYPES.has(a.type)) {
        findings.warnings.push(`${tag} assertion "${a.name}": unknown type "${a.type}" (known: ${[...ASSERTION_TYPES].join(", ")})`);
      }
      if (a.type) {
        stats.types.set(a.type, (stats.types.get(a.type) || 0) + 1);
      }

      if (typeof a.description !== "string" || a.description.trim().length < 10) {
        findings.errors.push(`${tag} assertion "${a.name}": description must be a non-trivial string (>=10 chars)`);
      }
    }
  }

  return { findings, stats };
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => path.resolve(a)) : findEvalFiles();

  if (files.length === 0) {
    console.error("no evals.json files found");
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalEvals = 0;
  let totalAssertions = 0;
  const typeUsage = new Map();

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const { findings, stats } = validateOne(file);

    totalEvals += stats.evals;
    totalAssertions += stats.assertions;
    for (const [t, n] of stats.types) {
      typeUsage.set(t, (typeUsage.get(t) || 0) + n);
    }

    if (findings.errors.length === 0 && findings.warnings.length === 0) {
      console.log(`  ok    ${rel} (${stats.evals} evals, ${stats.assertions} assertions)`);
    } else {
      const marker = findings.errors.length > 0 ? "FAIL" : "warn";
      console.log(`  ${marker}  ${rel} (${stats.evals} evals, ${stats.assertions} assertions)`);
      for (const e of findings.errors) console.log(`         error: ${e}`);
      for (const w of findings.warnings) console.log(`         warn:  ${w}`);
    }
    totalErrors += findings.errors.length;
    totalWarnings += findings.warnings.length;
  }

  console.log(`\n${files.length} file(s), ${totalEvals} evals, ${totalAssertions} assertions`);
  if (typeUsage.size > 0) {
    const sorted = [...typeUsage.entries()].sort((a, b) => b[1] - a[1]);
    console.log("Assertion types: " + sorted.map(([t, n]) => `${t}=${n}`).join(", "));
  }
  console.log(`${totalErrors} error(s), ${totalWarnings} warning(s)`);
  process.exit(totalErrors > 0 ? 1 : 0);
}

main();
