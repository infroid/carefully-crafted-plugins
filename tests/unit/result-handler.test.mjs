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
