// Unit tests for plugins/agy/scripts/agy-invoke.mjs
// Run with: node --test tests/unit/agy-invoke.test.mjs
//
// These tests use a fake `agy` executable (pointed at via AGY_BIN) that
// records the argv it was called with, so we can assert exactly what
// agy-invoke.mjs would hand to the real CLI — without running it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../plugins/agy/scripts/agy-invoke.mjs");

const FAKE_AGY = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("agy 1.0.1-fake\\n"); process.exit(0); }
const rec = process.env.FAKE_AGY_RECORD;
if (rec) writeFileSync(rec, JSON.stringify(argv), "utf8");
if (process.env.FAKE_AGY_FAIL === "1") {
  process.stderr.write("Error: please sign in to continue\\n");
  process.exit(1);
}
process.stdout.write("FAKE_AGY_STDOUT_MARKER\\n");
process.exit(0);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agy-invoke-test-"));
  const fakeAgy = join(dir, "fake-agy.mjs");
  writeFileSync(fakeAgy, FAKE_AGY, "utf8");
  chmodSync(fakeAgy, 0o755);
  return { dir, fakeAgy, recordFile: join(dir, "argv.json") };
}

function run(args, { fakeAgy, recordFile, dir, extraEnv = {} }) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, AGY_BIN: fakeAgy, FAKE_AGY_RECORD: recordFile, ...extraEnv },
  });
}

function recordedArgv(recordFile) {
  return JSON.parse(readFileSync(recordFile, "utf8"));
}

test("builds `agy -p <prompt>` for a plain task", () => {
  const ctx = setup();
  try {
    const res = run(["--prompt", "refactor the auth module"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), ["-p", "refactor the auth module"]);
    assert.match(res.stdout, /FAKE_AGY_STDOUT_MARKER/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--json appends --output-format json", () => {
  const ctx = setup();
  try {
    const res = run(["--prompt", "audit src/", "--json"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), ["-p", "audit src/", "--output-format", "json"]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("missing --prompt exits 2", () => {
  const ctx = setup();
  try {
    const res = run([], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /must pass --prompt/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("a prompt value beginning with -- is accepted, not misparsed", () => {
  const ctx = setup();
  try {
    const res = run(["--prompt", "--make a banana, no text"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), ["-p", "--make a banana, no text"]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--prompt=value form is supported", () => {
  const ctx = setup();
  try {
    const res = run(["--prompt=hello world"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), ["-p", "hello world"]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("non-zero agy exit is categorized and surfaced", () => {
  const ctx = setup();
  try {
    const res = run(["--prompt", "x"], { ...ctx, extraEnv: { FAKE_AGY_FAIL: "1" } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /category: not-authed/);
    assert.match(res.stderr, /please sign in/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
