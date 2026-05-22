// Unit tests for plugins/codex/scripts/setup.mjs (--ensure mode)
// Run with: node --test tests/unit/setup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../plugins/codex/scripts/setup.mjs");

function run(args, cwd) {
  return spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("--ensure scaffolds the docs tree on a fresh repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-ensure-test-"));
  try {
    const res = run(["--ensure"], dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(existsSync(join(dir, "docs/carefully-crafted-plugins/constraints")));
    assert.ok(existsSync(join(dir, "docs/carefully-crafted-plugins/output-formats")));
    assert.ok(existsSync(join(dir, "docs/carefully-crafted-plugins/handoffs")));
    assert.match(res.stdout, /one-time setup/i);
    assert.doesNotMatch(res.stdout, /already set up/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ensure is a quiet no-op when already set up", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-ensure-test-"));
  try {
    run(["--ensure"], dir); // first run scaffolds
    const res = run(["--ensure"], dir); // second run should be a no-op
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /already set up/i);
    assert.doesNotMatch(res.stdout, /one-time setup/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit (no-arg) setup still prints the full summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-explicit-test-"));
  try {
    const res = run([], dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /=== \/codex:setup ===/);
    assert.match(res.stdout, /Next steps:/);
    assert.ok(existsSync(join(dir, "docs/carefully-crafted-plugins/constraints")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
