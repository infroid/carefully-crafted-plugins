// Unit tests for plugins/forge/scripts/forge-write.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "forge", "scripts", "forge-write.mjs");

function setup() {
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), "forge-test-")) };
}

function teardown(ctx) {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

function run(args, stdin, ctx) {
  return spawnSync("node", [SCRIPT, ...args, "--cwd", ctx.dir], {
    encoding: "utf8",
    input: stdin,
  });
}

test("writes a spec artifact with body from stdin", () => {
  const ctx = setup();
  try {
    const body = "# Spec: Recently Viewed\n\nGoal: track viewed items.\n";
    const res = run(["--phase", "spec", "--slug", "recently-viewed"], body, ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const outPath = res.stdout.trim();
    assert.ok(outPath.endsWith("-recently-viewed.md"));
    assert.ok(outPath.includes("/forge/spec/"));
    assert.equal(fs.readFileSync(outPath, "utf8"), body);
  } finally {
    teardown(ctx);
  }
});

test("writes a plan artifact", () => {
  const ctx = setup();
  try {
    const res = run(["--phase", "plan", "--slug", "jwt-migration"], "plan body\n", ctx);
    assert.equal(res.status, 0);
    assert.ok(res.stdout.trim().includes("/forge/plan/"));
  } finally {
    teardown(ctx);
  }
});

test("rejects invalid phase", () => {
  const ctx = setup();
  try {
    const res = run(["--phase", "deploy", "--slug", "x"], "body", ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--phase must be one of/);
  } finally {
    teardown(ctx);
  }
});

test("rejects missing slug", () => {
  const ctx = setup();
  try {
    const res = run(["--phase", "spec"], "body", ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--slug is required/);
  } finally {
    teardown(ctx);
  }
});

test("rejects empty body", () => {
  const ctx = setup();
  try {
    const res = run(["--phase", "spec", "--slug", "x"], "   \n", ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /body \(stdin\) is empty/);
  } finally {
    teardown(ctx);
  }
});

test("ensures trailing newline on body", () => {
  const ctx = setup();
  try {
    const res = run(["--phase", "tdd", "--slug", "x"], "body without newline", ctx);
    assert.equal(res.status, 0);
    const content = fs.readFileSync(res.stdout.trim(), "utf8");
    assert.ok(content.endsWith("\n"));
  } finally {
    teardown(ctx);
  }
});
