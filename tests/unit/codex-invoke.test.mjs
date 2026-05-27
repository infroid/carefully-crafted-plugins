// Unit tests for plugins/codex/scripts/codex-invoke.mjs
// Run with: node --test tests/unit/codex-invoke.test.mjs
//
// These tests use a fake `codex` executable (pointed at via CODEX_BIN) that
// records the argv it was called with, so we can assert exactly what
// codex-invoke.mjs would hand to the real CLI — without running it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../plugins/codex/scripts/codex-invoke.mjs");

const FAKE_CODEX = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("codex 0.0.0-fake\\n"); process.exit(0); }
const rec = process.env.FAKE_CODEX_RECORD;
if (rec) writeFileSync(rec, JSON.stringify(argv), "utf8");
const oi = argv.indexOf("--output-last-message");
if (oi >= 0 && argv[oi + 1]) {
  writeFileSync(argv[oi + 1], JSON.stringify({ status: "success", summary: "fake", artifacts: [], assumptions: [], errors: [] }), "utf8");
}
if (process.env.FAKE_CODEX_FAIL === "1") {
  process.stderr.write("Error: authentication required — please sign in\\n");
  process.exit(1);
}
process.stdout.write("FAKE_CODEX_STDOUT_MARKER\\n");
process.exit(0);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "codex-invoke-test-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  writeFileSync(fakeCodex, FAKE_CODEX, "utf8");
  chmodSync(fakeCodex, 0o755);
  const recordFile = join(dir, "argv.json");
  return { dir, fakeCodex, recordFile };
}

function run(args, { fakeCodex, recordFile, dir, extraEnv = {} }) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CODEX_BIN: fakeCodex, FAKE_CODEX_RECORD: recordFile, ...extraEnv },
  });
}

function recordedArgv(recordFile) {
  return JSON.parse(readFileSync(recordFile, "utf8"));
}

function writeSpec(dir) {
  const specPath = join(dir, "2026-05-22-120000-task.md");
  writeFileSync(specPath, "# Handoff Spec: task\n", "utf8");
  return specPath;
}

test("spec mode passes model, reasoning effort, sandbox, and skip-git-repo-check", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const res = run(
      ["--spec-path", specPath, "--model", "gpt-5.5", "--reasoning-effort", "high", "--sandbox", "workspace-write"],
      ctx,
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "--skip-git-repo-check");
    assert.equal(argv[2], "--sandbox");
    assert.equal(argv[3], "workspace-write");
    assert.equal(argv[4], "-m");
    assert.equal(argv[5], "gpt-5.5");
    assert.equal(argv[6], "-c");
    assert.equal(argv[7], "model_reasoning_effort=high");
    assert.ok(argv.includes("--output-schema"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("resume mode builds `exec --skip-git-repo-check resume --last <prompt>`", () => {
  const ctx = setup();
  try {
    const res = run(["--resume-last", "--raw", "tighten the error handling"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), [
      "exec",
      "--skip-git-repo-check",
      "resume",
      "--last",
      "tighten the error handling",
    ]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("sandbox defaults to read-only when not specified", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "hello"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    assert.deepEqual(argv, [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-m",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=medium",
      "-c",
      "model_verbosity=low",
      "hello",
    ]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("invalid --reasoning-effort exits 2", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "x", "--reasoning-effort", "ultra"], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /invalid --reasoning-effort/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("invalid --sandbox exits 2", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "x", "--sandbox", "yolo"], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /invalid --sandbox/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("empty --spec-path exits 2 (does not silently use cwd)", () => {
  const ctx = setup();
  try {
    const res = run(["--spec-path", ""], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--spec-path is empty/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--spec-path pointing at a directory exits 2", () => {
  const ctx = setup();
  try {
    const res = run(["--spec-path", ctx.dir], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /must be a file, not a directory/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--resume-last without --raw exits 2", () => {
  const ctx = setup();
  try {
    const res = run(["--resume-last"], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--resume-last requires --raw/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("spec mode is quiet by default and --verbose streams Codex stdout", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const quiet = run(["--spec-path", specPath], ctx);
    assert.equal(quiet.status, 0, `stderr: ${quiet.stderr}`);
    assert.doesNotMatch(quiet.stdout, /FAKE_CODEX_STDOUT_MARKER/);
    assert.match(quiet.stdout, /last message saved to/);

    const loud = run(["--spec-path", specPath, "--verbose"], ctx);
    assert.equal(loud.status, 0, `stderr: ${loud.stderr}`);
    assert.match(loud.stdout, /FAKE_CODEX_STDOUT_MARKER/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("raw mode streams Codex stdout (the deliverable) without --verbose", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "hello"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /FAKE_CODEX_STDOUT_MARKER/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("non-zero codex exit is categorized and surfaced", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "x"], { ...ctx, extraEnv: { FAKE_CODEX_FAIL: "1" } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /category: not-authed/);
    assert.match(res.stderr, /authentication required/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("spec mode writes a full-trace log file next to the result", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const res = run(["--spec-path", specPath], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(existsSync(join(ctx.dir, "log-2026-05-22-120000-task.txt")));
    assert.ok(existsSync(join(ctx.dir, "result-2026-05-22-120000-task.txt")));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
