// Unit tests for plugins/codex/scripts/result-handler.mjs
// Run with: node --test tests/unit/result-handler.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../plugins/codex/scripts/result-handler.mjs");

function setupCase({ resultContent, resultFileName }) {
  const dir = mkdtempSync(join(tmpdir(), "result-handler-test-"));
  const specName = "2026-05-15-120000-task.md";
  const specPath = join(dir, specName);
  writeFileSync(specPath, "# Handoff Spec: task\n\n## 1. What To Do\n", "utf8");
  if (resultContent !== null) {
    const rn = resultFileName ?? `result-${specName.replace(/\.md$/, "")}.txt`;
    writeFileSync(join(dir, rn), resultContent, "utf8");
  }
  return { dir, specPath };
}

function run(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

test("appends Codex session pointer to the spec file", () => {
  const { dir, specPath } = setupCase({ resultContent: '{"status":"success","summary":"done"}' });
  try {
    const res = run(["--spec-path", specPath, "--type", "image"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const body = readFileSync(specPath, "utf8");
    assert.match(body, /_Codex session logs: ~\/\.codex\/sessions\/\d{4}\/\d{2}\/\d{2}\/_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses structured JSON output and prints summary fields", () => {
  const { dir, specPath } = setupCase({
    resultContent: JSON.stringify({
      status: "success",
      summary: "Generated a 256x256 icon.",
      artifacts: [{ path: "docs/foo.png", type: "image", description: "icon" }],
      assumptions: ["assumed a transparent background"],
      errors: [],
    }),
  });
  try {
    const res = run(["--spec-path", specPath, "--type", "image"]);
    assert.match(res.stdout, /Status:\s+success/);
    assert.match(res.stdout, /Summary: Generated a 256x256 icon\./);
    assert.match(res.stdout, /\[image\] docs\/foo\.png — icon/);
    assert.match(res.stdout, /assumed a transparent background/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parses JSON wrapped in markdown code fences", () => {
  const fenced = '```json\n{"status":"partial","summary":"ok"}\n```';
  const { dir, specPath } = setupCase({ resultContent: fenced });
  try {
    const res = run(["--spec-path", specPath, "--type", "text"]);
    assert.match(res.stdout, /Status:\s+partial/);
    assert.match(res.stdout, /Summary: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to raw text when result is not JSON", () => {
  const { dir, specPath } = setupCase({ resultContent: "this is a plain text result" });
  try {
    const res = run(["--spec-path", specPath, "--type", "text"]);
    assert.match(res.stdout, /Raw result \(not JSON-conforming\)/);
    assert.match(res.stdout, /this is a plain text result/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handles missing result file without crashing", () => {
  const { dir, specPath } = setupCase({ resultContent: null });
  try {
    const res = run(["--spec-path", specPath, "--type", "text"]);
    assert.match(res.stderr, /no result file at/);
    assert.match(res.stdout, /\(no result text\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exits 2 when --spec-path is missing", () => {
  const res = run(["--type", "image"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /missing --spec-path/);
});

test("exits 2 when --type is missing", () => {
  const { dir, specPath } = setupCase({ resultContent: "" });
  try {
    const res = run(["--spec-path", specPath]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /missing --type/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exits 2 when spec file does not exist", () => {
  const res = run(["--spec-path", "/tmp/does-not-exist-spec-xyz.md", "--type", "text"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /spec file not found/);
});

// --- --type review: bounded, provenance-preserving structured evidence contract ---

function makeFinding(n, overrides = {}) {
  const id = `F-${String(n).padStart(3, "0")}`;
  return {
    id,
    severity: "high",
    title: `Finding number ${n}`,
    path: `src/module-${n}/file.ts`,
    line: 10 + n,
    claim: `Claim text for finding ${n}.`,
    evidence: `Evidence text for finding ${n}.`,
    impact: `Impact text for finding ${n}.`,
    confidence: "high",
    minimal_fix: `Minimal fix for finding ${n}.`,
    ...overrides,
  };
}

function makeReview(overrides = {}) {
  return {
    status: "FINDINGS",
    scope: "staged, unstaged, and named untracked changes",
    findings: [makeFinding(1)],
    limitations: [],
    ...overrides,
  };
}

function setupReviewCase(resultContent) {
  const dir = mkdtempSync(join(tmpdir(), "result-handler-review-test-"));
  const specName = "2026-05-15-120000-review.md";
  const specPath = join(dir, specName);
  writeFileSync(specPath, "# Handoff Spec: review\n\n## 1. What To Do\n", "utf8");
  const resultPath = join(dir, `result-${specName.replace(/\.md$/, "")}.txt`);
  if (resultContent !== null) {
    writeFileSync(resultPath, resultContent, "utf8");
  }
  return { dir, specPath, resultPath };
}

test("review: a valid review leaves the exact result bytes unchanged", () => {
  const content = JSON.stringify(makeReview());
  const { dir, specPath, resultPath } = setupReviewCase(content);
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const after = readFileSync(resultPath, "utf8");
    assert.equal(after, content, "result file bytes must be byte-for-byte unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: every F-NNN finding appears in the compact index exactly once", () => {
  const review = makeReview({
    findings: [makeFinding(1), makeFinding(2), makeFinding(3)],
  });
  const { dir, specPath, resultPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    for (const id of ["F-001", "F-002", "F-003"]) {
      const occurrences = (res.stdout.match(new RegExp(id, "g")) || []).length;
      assert.equal(occurrences, 1, `${id} should appear exactly once, found ${occurrences}`);
    }
    assert.match(res.stdout, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: duplicate finding IDs fail validation", () => {
  const review = makeReview({
    findings: [makeFinding(1), makeFinding(1, { title: "Duplicate" })],
  });
  const { dir, specPath, resultPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /sequential/);
    assert.match(res.stderr, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: skipped finding IDs fail validation", () => {
  const review = makeReview({
    findings: [makeFinding(1), makeFinding(3)],
  });
  const { dir, specPath, resultPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /sequential/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: out-of-order finding IDs fail validation", () => {
  // F-002 listed before F-001 — out of order relative to required sequential order.
  const review = makeReview({ findings: [makeFinding(2), makeFinding(1)] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /sequential/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: unknown top-level field fails validation", () => {
  const review = { ...makeReview(), extra: "not allowed" };
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unknown/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: unknown finding field fails validation", () => {
  const review = makeReview({ findings: [{ ...makeFinding(1), extra: "nope" }] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unknown/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: more than 20 findings fails validation", () => {
  const findings = Array.from({ length: 21 }, (_, i) => makeFinding(i + 1));
  const review = makeReview({ findings });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /20/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: title over 160 chars fails validation", () => {
  const review = makeReview({ findings: [makeFinding(1, { title: "x".repeat(161) })] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /title/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const field of ["claim", "evidence", "impact", "minimal_fix"]) {
  test(`review: ${field} over 480 chars fails validation`, () => {
    const review = makeReview({ findings: [makeFinding(1, { [field]: "x".repeat(481) })] });
    const { dir, specPath } = setupReviewCase(JSON.stringify(review));
    try {
      const res = run(["--spec-path", specPath, "--type", "review"]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, new RegExp(field, "i"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("review: scope over 480 chars fails validation", () => {
  const review = makeReview({ scope: "x".repeat(481) });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /scope/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: more than 8 limitations fails validation", () => {
  const review = makeReview({
    status: "INCOMPLETE",
    findings: [],
    limitations: Array.from({ length: 9 }, (_, i) => `limitation ${i}`),
  });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /limitations/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: limitation over 240 chars fails validation", () => {
  const review = makeReview({
    status: "INCOMPLETE",
    findings: [],
    limitations: ["x".repeat(241)],
  });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /limitations/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: invalid status enum value fails validation", () => {
  const review = makeReview({ status: "PARTIAL" });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /status/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: FINDINGS status with zero findings fails validation", () => {
  const review = makeReview({ status: "FINDINGS", findings: [] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /FINDINGS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: valid NO_FINDINGS result is distinct from FINDINGS/INCOMPLETE and succeeds", () => {
  const review = makeReview({ status: "NO_FINDINGS", findings: [], limitations: [] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /NO_FINDINGS/);
    assert.doesNotMatch(res.stdout, /\bFINDINGS\b(?!.*NO_FINDINGS)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: NO_FINDINGS status with a non-empty findings array fails validation", () => {
  const review = makeReview({ status: "NO_FINDINGS", findings: [makeFinding(1)] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /NO_FINDINGS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: valid INCOMPLETE result (non-empty limitation) succeeds and is distinct from NO_FINDINGS", () => {
  const review = makeReview({
    status: "INCOMPLETE",
    findings: [],
    limitations: ["Codex ran out of budget before reviewing the full diff."],
  });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /INCOMPLETE/);
    assert.doesNotMatch(res.stdout, /NO_FINDINGS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: INCOMPLETE status without any limitation fails validation", () => {
  const review = makeReview({ status: "INCOMPLETE", findings: [], limitations: [] });
  const { dir, specPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /INCOMPLETE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: missing result file fails validation (never becomes NO_FINDINGS)", () => {
  const { dir, specPath, resultPath } = setupReviewCase(null);
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.doesNotMatch(res.stdout, /NO_FINDINGS/);
    assert.match(res.stderr, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: empty result file fails validation (never becomes NO_FINDINGS)", () => {
  const { dir, specPath, resultPath } = setupReviewCase("");
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.doesNotMatch(res.stdout, /NO_FINDINGS/);
    assert.match(res.stderr, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: malformed (non-JSON) result fails validation (never becomes NO_FINDINGS)", () => {
  const { dir, specPath, resultPath } = setupReviewCase("not json at all {{{");
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.notEqual(res.status, 0);
    assert.doesNotMatch(res.stdout, /NO_FINDINGS/);
    assert.match(res.stderr, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review: the largest valid index is at most 8192 UTF-8 bytes and names the full result path", () => {
  const findings = Array.from({ length: 20 }, (_, i) =>
    makeFinding(i + 1, {
      title: "T".repeat(160),
      path: "src/" + "deep/".repeat(30) + "very-long-file-name-for-testing-truncation.ts",
      claim: "C".repeat(480),
      evidence: "E".repeat(480),
      impact: "I".repeat(480),
      minimal_fix: "M".repeat(480),
      severity: "critical",
      confidence: "medium",
    }));
  const review = {
    status: "FINDINGS",
    scope: "S".repeat(480),
    findings,
    limitations: Array.from({ length: 8 }, () => "L".repeat(240)),
  };
  const { dir, specPath, resultPath } = setupReviewCase(JSON.stringify(review));
  try {
    const res = run(["--spec-path", specPath, "--type", "review"]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const byteLength = Buffer.byteLength(res.stdout, "utf8");
    assert.ok(byteLength <= 8192, `index is ${byteLength} bytes, must be <= 8192`);
    assert.match(res.stdout, new RegExp(resultPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    for (let i = 1; i <= 20; i++) {
      const id = `F-${String(i).padStart(3, "0")}`;
      const occurrences = (res.stdout.match(new RegExp(id, "g")) || []).length;
      assert.equal(occurrences, 1, `${id} should appear exactly once`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
