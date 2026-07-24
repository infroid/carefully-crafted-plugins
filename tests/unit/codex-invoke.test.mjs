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
  const env = {
    ...process.env,
    CODEX_BIN: fakeCodex,
    FAKE_CODEX_RECORD: recordFile,
    ...extraEnv,
  };
  if (!("CODEX_SANDBOX" in extraEnv)) delete env.CODEX_SANDBOX;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env,
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
      // Deliberately an arbitrary, obviously-fake model name: this test
      // asserts --model pass-through, not any particular default. (It
      // previously used the former default, "gpt-5.5", which read as though
      // it were encoding a stale default rather than an opaque value.)
      ["--spec-path", specPath, "--model", "o3-mini-fake", "--reasoning-effort", "high", "--sandbox", "workspace-write"],
      ctx,
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    assert.equal(argv[0], "exec");
    assert.equal(argv[1], "--skip-git-repo-check");
    assert.equal(argv[2], "--sandbox");
    assert.equal(argv[3], "workspace-write");
    assert.equal(argv[4], "-m");
    assert.equal(argv[5], "o3-mini-fake");
    assert.equal(argv[6], "-c");
    assert.equal(argv[7], "model_reasoning_effort=high");
    assert.ok(argv.includes("--output-schema"));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("resume mode pins read-only sandbox and builds `exec resume --last <prompt>`", () => {
  const ctx = setup();
  try {
    const res = run(["--resume-last", "--raw", "tighten the error handling"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), [
      "exec",
      "--skip-git-repo-check",
      "resume",
      "-c",
      "sandbox_mode=read-only",
      "--last",
      "tighten the error handling",
    ]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("resume mode honors an explicit validated sandbox over ambient config", () => {
  const ctx = setup();
  try {
    const res = run(
      ["--resume-last", "--raw", "continue editing", "--sandbox", "workspace-write"],
      { ...ctx, extraEnv: { CODEX_SANDBOX: "danger-full-access" } },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), [
      "exec",
      "--skip-git-repo-check",
      "resume",
      "-c",
      "sandbox_mode=workspace-write",
      "--last",
      "continue editing",
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
      "gpt-5.6-sol",
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

test("a raw prompt value beginning with -- is passed through literally", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "--help"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    assert.equal(argv.at(-1), "--help");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const OFFICIAL_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

for (const effort of OFFICIAL_EFFORTS) {
  test(`accepts official --reasoning-effort ${effort}`, () => {
    const ctx = setup();
    try {
      const res = run(["--raw", "hello", "--reasoning-effort", effort], ctx);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      const argv = recordedArgv(ctx.recordFile);
      assert.ok(argv.includes(`model_reasoning_effort=${effort}`));
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
}

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

// The real Codex CLI performs NO validation on `-c model_reasoning_effort=<v>`
// — `ultra` is silently accepted and billed. So the wrapper itself must be
// the gate: every value outside OFFICIAL_EFFORTS must be rejected BEFORE
// codex is ever spawned. We prove this by asserting the record file — which
// the fake Codex only ever writes when it is actually invoked for a real
// `exec` run — never gets created.
for (const badEffort of ["ultra", "extreme", "very-high", "MEDIUM", ""]) {
  test(`rejects non-official --reasoning-effort '${badEffort}' pre-spawn (Codex never invoked)`, () => {
    const ctx = setup();
    try {
      const res = run(["--raw", "x", "--reasoning-effort", badEffort], ctx);
      assert.equal(res.status, 2, `stderr: ${res.stderr}`);
      assert.match(res.stderr, /invalid --reasoning-effort/);
      assert.equal(existsSync(ctx.recordFile), false, "fake Codex must never have been invoked for a real run");
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
}

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

test("--resume <session-id> builds `exec --skip-git-repo-check resume <id> <prompt>`", () => {
  const ctx = setup();
  try {
    const res = run(["--resume", "9f2c1e3a-...-uuid", "--raw", "tighten the error handling"], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(recordedArgv(ctx.recordFile), [
      "exec",
      "--skip-git-repo-check",
      "resume",
      "-c",
      "sandbox_mode=read-only",
      "9f2c1e3a-...-uuid",
      "tighten the error handling",
    ]);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--resume without --raw exits 2", () => {
  const ctx = setup();
  try {
    const res = run(["--resume", "some-session-id"], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--resume requires --raw/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--resume and --resume-last together exit 2 pre-spawn (mutually exclusive)", () => {
  const ctx = setup();
  try {
    const res = run(["--resume", "abc", "--resume-last", "--raw", "x"], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /mutually exclusive/);
    assert.equal(existsSync(ctx.recordFile), false);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("explicit --sandbox wins over ambient CODEX_SANDBOX env", () => {
  const ctx = setup();
  try {
    const res = run(["--raw", "hello", "--sandbox", "read-only"], {
      ...ctx,
      extraEnv: { CODEX_SANDBOX: "workspace-write" },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    assert.equal(argv[2], "--sandbox");
    assert.equal(argv[3], "read-only");
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--output-schema in spec mode overrides the packaged default and propagates exactly", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const schemaPath = join(ctx.dir, "custom-schema.json");
    writeFileSync(schemaPath, "{}", "utf8");
    const res = run(["--spec-path", specPath, "--output-schema", schemaPath], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    const oi = argv.indexOf("--output-schema");
    assert.ok(oi >= 0);
    assert.equal(argv[oi + 1], schemaPath);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--output-schema pointing at a missing path exits 2", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const res = run(["--spec-path", specPath, "--output-schema", join(ctx.dir, "nope.json")], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--output-schema.*does not exist/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--output-schema pointing at a directory exits 2", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const res = run(["--spec-path", specPath, "--output-schema", ctx.dir], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--output-schema.*must be a file, not a directory/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--output-schema with --raw exits 2 pre-spawn (only valid in spec mode)", () => {
  const ctx = setup();
  try {
    const schemaPath = join(ctx.dir, "s.json");
    writeFileSync(schemaPath, "{}", "utf8");
    const res = run(["--raw", "hello", "--output-schema", schemaPath], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--output-schema is only valid in spec mode/);
    assert.equal(existsSync(ctx.recordFile), false);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("--output-schema with --resume-last exits 2 pre-spawn (only valid in spec mode)", () => {
  const ctx = setup();
  try {
    const schemaPath = join(ctx.dir, "s.json");
    writeFileSync(schemaPath, "{}", "utf8");
    const res = run(["--resume-last", "--raw", "hello", "--output-schema", schemaPath], ctx);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--output-schema is only valid in spec mode/);
    assert.equal(existsSync(ctx.recordFile), false);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("spec mode without explicit --output-schema falls back to the packaged output-schema.json", () => {
  const ctx = setup();
  try {
    const specPath = writeSpec(ctx.dir);
    const res = run(["--spec-path", specPath], ctx);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const argv = recordedArgv(ctx.recordFile);
    const oi = argv.indexOf("--output-schema");
    assert.ok(oi >= 0);
    assert.match(argv[oi + 1], /output-schema\.json$/);
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
