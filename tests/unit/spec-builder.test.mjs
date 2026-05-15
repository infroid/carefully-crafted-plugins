// Unit tests for plugins/codex/scripts/spec-builder.mjs
// Run with: node --test tests/unit/spec-builder.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../plugins/codex/scripts/spec-builder.mjs");

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "spec-builder-test-"));
  return dir;
}

function writeFixtureFiles(dir, files) {
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, content, "utf8");
    paths[name] = p;
  }
  return paths;
}

function runSpecBuilder(args, cwd) {
  return spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("writes a spec with all 5 sections when inputs are valid", () => {
  const dir = makeTempRepo();
  try {
    const fx = writeFixtureFiles(dir, {
      "code-style.md": "# code style",
      "image-icon.md": "# icon format",
    });

    const handoffsDir = join(dir, "handoffs");
    const res = runSpecBuilder(
      [
        "--task-slug", "test-icon",
        "--role", "Image generator",
        "--task", "Make a logo for a fictional product.",
        "--how", "Delegate, figure it out.",
        "--constraints", fx["code-style.md"],
        "--output-format", fx["image-icon.md"],
        "--artifact-path", "docs/foo/out.png",
        "--clarifications", "None — spec was unambiguous",
        "--handoffs-dir", handoffsDir,
      ],
      dir,
    );

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const specPath = res.stdout.trim();
    assert.ok(specPath.endsWith(".md"));
    assert.ok(existsSync(specPath));

    const body = readFileSync(specPath, "utf8");
    assert.match(body, /^# Handoff Spec: test-icon/m);
    assert.match(body, /^Generated: \d{4}-\d{2}-\d{2}T/m);
    assert.match(body, /^## 1\. What To Do$/m);
    assert.match(body, /^## 2\. How To Do$/m);
    assert.match(body, /^## 3\. Constraints$/m);
    assert.match(body, /^## 4\. Expected Output$/m);
    assert.match(body, /^## 5\. Pre-flight Clarifications$/m);
    assert.match(body, new RegExp(fx["code-style.md"].replace(/\//g, "\\/")));
    assert.match(body, new RegExp(fx["image-icon.md"].replace(/\//g, "\\/")));
    assert.match(body, /Role: Image generator/);
    assert.match(body, /Delegate, figure it out\./);
    assert.match(body, /Output artifact path: docs\/foo\/out\.png/);
    assert.match(body, /None — spec was unambiguous/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exits 2 and lists missing files when constraint path does not exist", () => {
  const dir = makeTempRepo();
  try {
    const fx = writeFixtureFiles(dir, { "image-icon.md": "# icon" });

    const missing = join(dir, "does-not-exist.md");
    const res = runSpecBuilder(
      [
        "--task-slug", "missing-test",
        "--role", "X",
        "--task", "Y",
        "--how", "Z",
        "--constraints", missing,
        "--output-format", fx["image-icon.md"],
        "--artifact-path", "a/b.png",
        "--clarifications", "n",
        "--handoffs-dir", join(dir, "h"),
      ],
      dir,
    );

    assert.equal(res.status, 2);
    assert.match(res.stderr, /referenced files do not exist/);
    assert.match(res.stderr, new RegExp(missing.replace(/\//g, "\\/")));
    assert.equal(existsSync(join(dir, "h")), false, "handoffs dir should NOT be created on validation failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exits 2 when required argument is missing", () => {
  const dir = makeTempRepo();
  try {
    const res = runSpecBuilder([], dir);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /missing required --task-slug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts --constraints none to mean empty list", () => {
  const dir = makeTempRepo();
  try {
    const fx = writeFixtureFiles(dir, { "out.md": "# out" });

    const res = runSpecBuilder(
      [
        "--task-slug", "no-constraints",
        "--role", "R",
        "--task", "T",
        "--how", "H",
        "--constraints", "none",
        "--output-format", fx["out.md"],
        "--artifact-path", "a/b",
        "--clarifications", "n",
        "--handoffs-dir", join(dir, "h"),
      ],
      dir,
    );

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const body = readFileSync(res.stdout.trim(), "utf8");
    assert.match(body, /^- \(none\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filename uses YYYY-MM-DD-HHMMSS-<slug>.md format", () => {
  const dir = makeTempRepo();
  try {
    const fx = writeFixtureFiles(dir, { "x.md": "x" });

    const res = runSpecBuilder(
      [
        "--task-slug", "format-check",
        "--role", "R",
        "--task", "T",
        "--how", "H",
        "--constraints", "none",
        "--output-format", fx["x.md"],
        "--artifact-path", "a",
        "--clarifications", "n",
        "--handoffs-dir", join(dir, "h"),
      ],
      dir,
    );

    assert.equal(res.status, 0);
    const files = readdirSync(join(dir, "h"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}-\d{6}-format-check\.md$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("includes session artifact line when --session-artifact passed", () => {
  const dir = makeTempRepo();
  try {
    const fx = writeFixtureFiles(dir, { "out.md": "x" });
    const sessionPath = join(dir, "session-spec.md");
    writeFileSync(sessionPath, "# session", "utf8");

    const res = runSpecBuilder(
      [
        "--task-slug", "sess",
        "--role", "R",
        "--task", "T",
        "--how", "H",
        "--constraints", "none",
        "--output-format", fx["out.md"],
        "--artifact-path", "a",
        "--clarifications", "n",
        "--session-artifact", sessionPath,
        "--handoffs-dir", join(dir, "h"),
      ],
      dir,
    );

    assert.equal(res.status, 0);
    const body = readFileSync(res.stdout.trim(), "utf8");
    assert.match(body, new RegExp(`Session artifact: ${sessionPath.replace(/\//g, "\\/")}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
