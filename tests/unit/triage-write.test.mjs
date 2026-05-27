// Unit tests for plugins/triage/scripts/triage-write.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "triage", "scripts", "triage-write.mjs");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-test-"));
  return { dir };
}

function teardown(ctx) {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

function run(args, ctx, stdin) {
  return spawnSync("node", [SCRIPT, ...args, "--cwd", ctx.dir], {
    encoding: "utf8",
    input: stdin,
  });
}

test("writes a single-task plan via flag args", () => {
  const ctx = setup();
  try {
    const res = run(
      [
        "--decomposition", "single",
        "--task-id", "t1",
        "--summary", "audit src/auth.ts for race conditions",
        "--difficulty", "hard",
        "--specialist", "codex",
        "--effort", "xhigh",
        "--model", "gpt-5.5",
      ],
      ctx
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const outPath = res.stdout.trim();
    assert.ok(outPath, "expected artifact path on stdout");
    const plan = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(plan.version, 1);
    assert.equal(plan.decomposition, "single");
    assert.equal(plan.tasks.length, 1);
    assert.deepEqual(plan.tasks[0], {
      id: "t1",
      summary: "audit src/auth.ts for race conditions",
      difficulty: "hard",
      suggested_specialist: "codex",
      suggested_effort: "xhigh",
      suggested_model: "gpt-5.5",
    });
    assert.ok(outPath.includes("audit-src-auth-ts"), `path slug missing: ${outPath}`);
  } finally {
    teardown(ctx);
  }
});

test("writes a subtasks plan via flag args", () => {
  const ctx = setup();
  try {
    const res = run(
      [
        "--decomposition", "subtasks",
        "--task-id", "t1", "--summary", "rename function", "--difficulty", "low",
        "--specialist", "claude", "--effort", "low",
        "--task-id", "t2", "--summary", "audit monorepo for callsites",
        "--difficulty", "hard", "--specialist", "agy", "--effort", "high",
      ],
      ctx
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const plan = JSON.parse(fs.readFileSync(res.stdout.trim(), "utf8"));
    assert.equal(plan.decomposition, "subtasks");
    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.tasks[0].id, "t1");
    assert.equal(plan.tasks[1].suggested_specialist, "agy");
  } finally {
    teardown(ctx);
  }
});

test("accepts a plan via --stdin", () => {
  const ctx = setup();
  try {
    const stdinPlan = JSON.stringify({
      decomposition: "single",
      tasks: [
        {
          id: "t1",
          summary: "generate a hero image",
          difficulty: "medium",
          suggested_specialist: "codex",
          suggested_effort: "medium",
        },
      ],
    });
    const res = spawnSync(
      "node",
      [SCRIPT, "--stdin", "--cwd", ctx.dir],
      { encoding: "utf8", input: stdinPlan }
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const plan = JSON.parse(fs.readFileSync(res.stdout.trim(), "utf8"));
    assert.equal(plan.tasks[0].suggested_specialist, "codex");
  } finally {
    teardown(ctx);
  }
});

test("rejects invalid difficulty", () => {
  const ctx = setup();
  try {
    const res = run(
      [
        "--decomposition", "single",
        "--task-id", "t1", "--summary", "x",
        "--difficulty", "ultra",
        "--specialist", "codex", "--effort", "medium",
      ],
      ctx
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /difficulty must be one of/);
  } finally {
    teardown(ctx);
  }
});

test("rejects invalid specialist", () => {
  const ctx = setup();
  try {
    const res = run(
      [
        "--decomposition", "single",
        "--task-id", "t1", "--summary", "x",
        "--difficulty", "medium",
        "--specialist", "gemini-cli", "--effort", "medium",
      ],
      ctx
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /specialist must be one of/);
  } finally {
    teardown(ctx);
  }
});

test("rejects subtasks decomposition with only one task", () => {
  const ctx = setup();
  try {
    const res = run(
      [
        "--decomposition", "single",
        "--task-id", "t1", "--summary", "x", "--difficulty", "low",
        "--specialist", "claude", "--effort", "low",
        "--task-id", "t2", "--summary", "y", "--difficulty", "low",
        "--specialist", "claude", "--effort", "low",
      ],
      ctx
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /"single" but 2 tasks given/);
  } finally {
    teardown(ctx);
  }
});

test("rejects duplicate task ids", () => {
  const ctx = setup();
  try {
    const res = run(
      [
        "--decomposition", "subtasks",
        "--task-id", "t1", "--summary", "x", "--difficulty", "low",
        "--specialist", "claude", "--effort", "low",
        "--task-id", "t1", "--summary", "y", "--difficulty", "low",
        "--specialist", "claude", "--effort", "low",
      ],
      ctx
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /duplicate task id/);
  } finally {
    teardown(ctx);
  }
});
