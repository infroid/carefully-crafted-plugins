#!/usr/bin/env node
// result-handler.mjs — parses Codex's result file, appends a session-log pointer
// to the handoff spec, and prints a summary for Claude Code to relay.
//
// Usage:
//   node result-handler.mjs --spec-path <abs path> --type <image|text|code|data|review>
//
// --type review is a distinct, stricter contract: the result file must be a
// structured code-review evidence object (see
// reference/schemas/code-review.schema.json). The raw result file is never
// modified — result-handler only reads it — and a validation failure (missing,
// empty, malformed, or schema/semantic violation) is reported as a failure,
// never silently downgraded to a "no findings" outcome. On success, a bounded
// (<= 8192 UTF-8 bytes) compact index is printed to stdout that names the full
// result path and accounts for every finding ID exactly once.
//
// Exit codes:
//   0  success
//   1  --type review: result content failed validation (never becomes NO_FINDINGS)
//   2  invocation/config error (missing args, missing files)

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// --- --type review: bounded, provenance-preserving structured evidence contract ---

const REVIEW_STATUSES = new Set(["FINDINGS", "NO_FINDINGS", "INCOMPLETE"]);
const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const REVIEW_CONFIDENCES = new Set(["high", "medium", "low"]);
const REVIEW_TOP_FIELDS = ["status", "scope", "findings", "limitations"];
const REVIEW_FINDING_FIELDS = [
  "id", "severity", "title", "path", "line", "claim", "evidence", "impact", "confidence", "minimal_fix",
];
const MAX_FINDINGS = 20;
const MAX_TITLE_LEN = 160;
const MAX_TEXT_LEN = 480; // scope, claim, evidence, impact, minimal_fix
const MAX_LIMITATIONS = 8;
const MAX_LIMITATION_LEN = 240;
const MAX_INDEX_BYTES = 8192;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBoundedString(v, maxLen) {
  return typeof v === "string" && v.length >= 1 && v.length <= maxLen;
}

function validateFinding(f, idx, errors) {
  if (!isPlainObject(f)) {
    errors.push(`findings[${idx}] must be an object`);
    return;
  }
  for (const k of Object.keys(f)) {
    if (!REVIEW_FINDING_FIELDS.includes(k)) errors.push(`findings[${idx}] has unknown field "${k}"`);
  }
  for (const k of REVIEW_FINDING_FIELDS) {
    if (!(k in f)) errors.push(`findings[${idx}] missing required field "${k}"`);
  }
  if (typeof f.id !== "string" || !/^F-\d{3}$/.test(f.id)) {
    errors.push(`findings[${idx}].id must match the pattern F-NNN`);
  }
  if (typeof f.severity !== "string" || !REVIEW_SEVERITIES.has(f.severity)) {
    errors.push(`findings[${idx}].severity must be one of ${[...REVIEW_SEVERITIES].join("|")}`);
  }
  if (!isBoundedString(f.title, MAX_TITLE_LEN)) {
    errors.push(`findings[${idx}].title must be 1-${MAX_TITLE_LEN} characters`);
  }
  if (typeof f.path !== "string" || f.path.length < 1) {
    errors.push(`findings[${idx}].path must be a non-empty string`);
  }
  if (!(f.line === null || (Number.isInteger(f.line) && f.line >= 1))) {
    errors.push(`findings[${idx}].line must be a positive integer or null`);
  }
  if (!isBoundedString(f.claim, MAX_TEXT_LEN)) {
    errors.push(`findings[${idx}].claim must be 1-${MAX_TEXT_LEN} characters`);
  }
  if (!isBoundedString(f.evidence, MAX_TEXT_LEN)) {
    errors.push(`findings[${idx}].evidence must be 1-${MAX_TEXT_LEN} characters`);
  }
  if (!isBoundedString(f.impact, MAX_TEXT_LEN)) {
    errors.push(`findings[${idx}].impact must be 1-${MAX_TEXT_LEN} characters`);
  }
  if (typeof f.confidence !== "string" || !REVIEW_CONFIDENCES.has(f.confidence)) {
    errors.push(`findings[${idx}].confidence must be one of ${[...REVIEW_CONFIDENCES].join("|")}`);
  }
  if (!isBoundedString(f.minimal_fix, MAX_TEXT_LEN)) {
    errors.push(`findings[${idx}].minimal_fix must be 1-${MAX_TEXT_LEN} characters`);
  }
}

// Validates both shape (types, required/unknown fields, enums, length/count
// limits) and the semantic rules from the task brief (sequential unique IDs,
// status/findings/limitations coherence). Hand-written on purpose — no
// JSON-Schema library is available in this environment.
function validateReview(obj) {
  const errors = [];
  if (!isPlainObject(obj)) return ["review result is not a JSON object"];

  for (const k of Object.keys(obj)) {
    if (!REVIEW_TOP_FIELDS.includes(k)) errors.push(`unknown top-level field "${k}"`);
  }
  for (const k of REVIEW_TOP_FIELDS) {
    if (!(k in obj)) errors.push(`missing required top-level field "${k}"`);
  }

  if (typeof obj.status !== "string" || !REVIEW_STATUSES.has(obj.status)) {
    errors.push(`status must be one of ${[...REVIEW_STATUSES].join("|")}`);
  }
  if (!isBoundedString(obj.scope, MAX_TEXT_LEN)) {
    errors.push(`scope must be 1-${MAX_TEXT_LEN} characters`);
  }

  let findings = null;
  if (!Array.isArray(obj.findings)) {
    errors.push("findings must be an array");
  } else {
    findings = obj.findings;
    if (findings.length > MAX_FINDINGS) {
      errors.push(`findings has ${findings.length} entries; max ${MAX_FINDINGS}`);
    }
    findings.forEach((f, i) => validateFinding(f, i, errors));
    // Sequential-unique-starting-at-F-001 check. This single positional
    // comparison catches duplicates, gaps, and out-of-order IDs alike: any
    // deviation from the expected sequence fails at the first offending index.
    findings.forEach((f, i) => {
      const expected = `F-${String(i + 1).padStart(3, "0")}`;
      const actual = isPlainObject(f) ? f.id : undefined;
      if (actual !== expected) {
        errors.push(
          `findings[${i}].id expected "${expected}" but got "${actual}" — IDs must be sequential and unique, starting at F-001`,
        );
      }
    });
  }

  let limitations = null;
  if (!Array.isArray(obj.limitations)) {
    errors.push("limitations must be an array");
  } else {
    limitations = obj.limitations;
    if (limitations.length > MAX_LIMITATIONS) {
      errors.push(`limitations has ${limitations.length} entries; max ${MAX_LIMITATIONS}`);
    }
    limitations.forEach((l, i) => {
      if (!isBoundedString(l, MAX_LIMITATION_LEN)) {
        errors.push(`limitations[${i}] must be 1-${MAX_LIMITATION_LEN} characters`);
      }
    });
  }

  if (findings !== null && typeof obj.status === "string" && REVIEW_STATUSES.has(obj.status)) {
    if (obj.status === "FINDINGS" && findings.length < 1) {
      errors.push('status "FINDINGS" requires at least one finding');
    }
    if (obj.status === "NO_FINDINGS" && findings.length !== 0) {
      errors.push('status "NO_FINDINGS" requires zero findings');
    }
  }
  if (limitations !== null && typeof obj.status === "string" && REVIEW_STATUSES.has(obj.status)) {
    if (obj.status === "INCOMPLETE" && limitations.length < 1) {
      errors.push('status "INCOMPLETE" requires at least one non-empty limitation explaining what failed or was truncated');
    }
  }

  return errors;
}

const byteLen = (s) => Buffer.byteLength(s, "utf8");

// All display truncation below budgets in UTF-8 BYTES, not characters. The
// schema's field limits are in characters, which only coincide with bytes for
// ASCII — a schema-valid 480-character CJK scope is 1440 bytes. Iterating by
// code point (`for...of`, not `.slice`) keeps surrogate pairs intact, so a
// truncated field is never invalid UTF-8.
const ELLIPSIS = "…";
const ELLIPSIS_BYTES = byteLen(ELLIPSIS);

function truncateToBytes(s, maxBytes) {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  const useEllipsis = maxBytes >= ELLIPSIS_BYTES;
  const budget = useEllipsis ? maxBytes - ELLIPSIS_BYTES : maxBytes;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = byteLen(ch);
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return useEllipsis ? out + ELLIPSIS : out;
}

// Middle truncation keeps both ends of a path visible (`src/a/…/file.ts`),
// which is more useful than a head-only cut for deeply nested files.
function truncateMiddleToBytes(s, maxBytes) {
  if (maxBytes <= 0) return "";
  if (byteLen(s) <= maxBytes) return s;
  if (maxBytes < ELLIPSIS_BYTES) return truncateToBytes(s, maxBytes);
  const budget = maxBytes - ELLIPSIS_BYTES;
  const headBudget = Math.ceil(budget * 0.6);
  const tailBudget = budget - headBudget;
  const chars = Array.from(s);
  let head = "";
  let headUsed = 0;
  for (const ch of chars) {
    const b = byteLen(ch);
    if (headUsed + b > headBudget) break;
    head += ch;
    headUsed += b;
  }
  let tail = "";
  let tailUsed = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const b = byteLen(chars[i]);
    if (tailUsed + b > tailBudget) break;
    tail = chars[i] + tail;
    tailUsed += b;
  }
  return head + ELLIPSIS + tail;
}

// `caps` bounds every free-text field in bytes: scope, each limitation, and
// each finding's path and title. Infinity means "print verbatim".
function renderReviewIndex(review, resultPath, caps) {
  const lines = [];
  lines.push("=== Codex Review Result ===");
  lines.push(`Status: ${review.status}`);
  lines.push(`Scope: ${truncateToBytes(review.scope, caps.scopeCap)}`);
  lines.push(`Full result: ${resultPath}`);
  lines.push(`Findings: ${review.findings.length}`);
  if (review.limitations.length) {
    lines.push("Limitations:");
    for (const l of review.limitations) lines.push(`  - ${truncateToBytes(l, caps.limitationCap)}`);
  } else {
    lines.push("Limitations: (none)");
  }
  lines.push("");
  if (review.findings.length) {
    for (const f of review.findings) {
      const path = truncateMiddleToBytes(f.path, caps.pathCap);
      const title = truncateToBytes(f.title, caps.titleCap);
      const line = f.line === null ? "null" : f.line;
      lines.push(`${f.id} ${f.severity}/${f.confidence} ${path}:${line} ${title}`);
    }
  } else {
    lines.push("(no findings)");
  }
  return lines.join("\n") + "\n";
}

// Builds the compact index within MAX_INDEX_BYTES.
//
// Guarantee: the output is <= MAX_INDEX_BYTES whenever the mandatory skeleton
// itself fits. The skeleton is never truncated to make room — it carries the
// two properties the index exists to provide: the full-result path is always
// named, and every finding contributes exactly one line keyed by its ID. Only
// free text (scope, limitations, paths, titles) is shrunk, and no finding is
// ever dropped. If a pathological result path made even the skeleton exceed
// the cap, the skeleton still wins over the byte budget — losing the artifact
// path or a finding ID would defeat the purpose of the index.
function buildReviewIndex(review, resultPath) {
  const UNCAPPED = {
    scopeCap: Infinity, limitationCap: Infinity, pathCap: Infinity, titleCap: Infinity,
  };
  const verbatim = renderReviewIndex(review, resultPath, UNCAPPED);
  if (byteLen(verbatim) <= MAX_INDEX_BYTES) return verbatim;

  const { findings, limitations } = review;

  // Measure the mandatory skeleton exactly: every byte the renderer emits
  // that is NOT a free-text field.
  let mandatory = 0;
  mandatory += byteLen("=== Codex Review Result ===\n");
  mandatory += byteLen(`Status: ${review.status}\n`);
  mandatory += byteLen("Scope: \n");
  mandatory += byteLen(`Full result: ${resultPath}\n`);
  mandatory += byteLen(`Findings: ${findings.length}\n`);
  if (limitations.length) {
    mandatory += byteLen("Limitations:\n") + limitations.length * byteLen("  - \n");
  } else {
    mandatory += byteLen("Limitations: (none)\n");
  }
  mandatory += byteLen("\n");
  if (findings.length) {
    for (const f of findings) {
      const line = f.line === null ? "null" : f.line;
      mandatory += byteLen(`${f.id} ${f.severity}/${f.confidence} :${line} \n`);
    }
  } else {
    mandatory += byteLen("(no findings)\n");
  }

  // Split what's left across the free-text fields. Because each field is
  // truncated to at most its cap and the caps sum to at most `free`, the
  // rendered total is at most mandatory + free = MAX_INDEX_BYTES.
  const free = Math.max(0, MAX_INDEX_BYTES - mandatory);
  const scopeCap = Math.floor(free * 0.12);
  const limitationsBudget = Math.floor(free * 0.28);
  const limitationCap = limitations.length ? Math.floor(limitationsBudget / limitations.length) : 0;
  const findingsBudget = free - scopeCap - limitationsBudget;
  const perFinding = findings.length ? Math.floor(findingsBudget / findings.length) : 0;
  const pathCap = Math.floor(perFinding * 0.4);
  const titleCap = perFinding - pathCap;

  return renderReviewIndex(review, resultPath, { scopeCap, limitationCap, pathCap, titleCap });
}

function runReviewType({ specPath, resultPath }) {
  if (!existsSync(resultPath)) {
    console.error(`result-handler: review validation failed — no result file at ${resultPath}. Codex may not have produced output.`);
    console.error(`Full artifact: ${resultPath}`);
    process.exit(1);
  }

  const resultText = readFileSync(resultPath, "utf8");
  if (!resultText.trim()) {
    console.error(`result-handler: review validation failed — result file is empty: ${resultPath}`);
    console.error(`Full artifact: ${resultPath}`);
    process.exit(1);
  }

  const parsed = loadStructured(resultText);
  if (parsed === null) {
    console.error(`result-handler: review validation failed — result is not valid JSON: ${resultPath}`);
    console.error(`Full artifact: ${resultPath}`);
    process.exit(1);
  }

  const errors = validateReview(parsed);
  if (errors.length) {
    console.error(`result-handler: review validation failed for ${resultPath}:`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`Full artifact: ${resultPath}`);
    process.exit(1);
  }

  // The source file was only ever read above — never written. Provenance is
  // preserved: it stays byte-for-byte unchanged on disk.
  appendSessionPointer(specPath);

  process.stdout.write(buildReviewIndex(parsed, resultPath));
  process.exit(0);
}

// Same shape as codex-invoke.mjs's KNOWN_FLAGS: an unrecognized flag must be
// a hard error, not a silently-ignored no-op — a typo'd flag name (e.g.
// `--specpath` for `--spec-path`) must not be able to slip past validation
// under a key nothing ever reads.
const KNOWN_FLAGS = new Set(["spec-path", "type"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (!KNOWN_FLAGS.has(key)) {
      console.error(`result-handler: unknown flag --${key}`);
      console.error(`Known flags: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(", ")}`);
      process.exit(2);
    }
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
    console.error("result-handler: missing --type (one of: image, text, code, data, review)");
    process.exit(2);
  }

  const specPath = resolve(args["spec-path"]);
  if (!existsSync(specPath)) {
    console.error(`result-handler: spec file not found: ${specPath}`);
    process.exit(2);
  }

  const base = basename(specPath).replace(/\.md$/, "");
  const resultPath = join(dirname(specPath), `result-${base}.txt`);

  if (args["type"] === "review") {
    runReviewType({ specPath, resultPath });
    return;
  }

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
