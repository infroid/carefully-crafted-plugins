// Unit tests for plugins/contexthub/scripts/agent-availability.mjs.
//
// This module performs bounded PATH/PATHEXT executable *resolution*
// only — it never spawns the codex/agy binary, so a present-but-hanging
// or present-but-broken binary can never block or crash detection. Auth
// and capability are intentionally NOT checked here; the actual
// Codex/Agy delegation calls made by skills are already bounded and
// handle lazy auth failure themselves (drop the agent, warn, continue).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "contexthub", "scripts", "agent-availability.mjs");
const { detect, resolve } = await import(SCRIPT);

function fakeBinDir(names, { exit = 0, sleepSec = 0, executable = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
  for (const name of names) {
    const body = sleepSec ? `#!/bin/sh\n/bin/sleep ${sleepSec}\nexit ${exit}\n` : `#!/bin/sh\nexit ${exit}\n`;
    fs.writeFileSync(path.join(dir, name), body);
    fs.chmodSync(path.join(dir, name), executable ? 0o755 : 0o644);
  }
  return dir;
}

test("both agents present and healthy", () => {
  const dir = fakeBinDir(["codex", "agy"]);
  try {
    assert.deepEqual(detect({ env: { PATH: dir } }),
      { claude: true, codex: true, agy: true, count: 3, externalCount: 2 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only codex present", () => {
  const dir = fakeBinDir(["codex"]);
  try {
    const r = detect({ env: { PATH: dir } });
    assert.equal(r.codex, true); assert.equal(r.agy, false);
    assert.equal(r.count, 2); assert.equal(r.externalCount, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no external agents", () => {
  const dir = fakeBinDir([]);
  try {
    assert.deepEqual(detect({ env: { PATH: dir } }),
      { claude: true, codex: false, agy: false, count: 1, externalCount: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("empty PATH resolves nothing", () => {
  assert.equal(resolve("codex", { env: { PATH: "" } }), false);
});

test("candidate resolution does not depend on --version exit code", () => {
  // A binary that would fail `--version` if ever spawned is still a
  // valid candidate — presence/executability is all that's checked now.
  const dir = fakeBinDir(["codex"], { exit: 1 });
  try { assert.equal(resolve("codex", { env: { PATH: dir } }), true); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("present but not executable is not a candidate (POSIX)", () => {
  const dir = fakeBinDir(["codex"], { executable: false });
  try { assert.equal(resolve("codex", { env: { PATH: dir }, platform: "linux" }), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test(
  "a hanging --version never blocks discovery — resolve() never spawns the binary",
  { timeout: 5000 },
  () => {
    // sleepSec is large enough that spawning it would make this test
    // either time out or take multiple seconds. resolve() must return
    // almost instantly because it only stats/checks the file — it must
    // never execute it.
    const dir = fakeBinDir(["agy"], { sleepSec: 30 });
    try {
      const start = Date.now();
      const found = resolve("agy", { env: { PATH: dir } });
      const elapsedMs = Date.now() - start;
      assert.equal(found, true, "a present executable must be discoverable regardless of its --version behavior");
      assert.ok(
        elapsedMs < 1000,
        `resolve() took ${elapsedMs}ms for a binary that sleeps 30s on invocation — this indicates it was spawned, not just stat'd`
      );
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
);

test("detect() with a hanging agy candidate still reports it available, instantly", { timeout: 5000 }, () => {
  const dir = fakeBinDir(["codex", "agy"], { sleepSec: 30 });
  try {
    const start = Date.now();
    const r = detect({ env: { PATH: dir } });
    const elapsedMs = Date.now() - start;
    assert.deepEqual(r, { claude: true, codex: true, agy: true, count: 3, externalCount: 2 });
    assert.ok(elapsedMs < 1000, `detect() took ${elapsedMs}ms — looks like it spawned a hanging candidate`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("win32: resolves via PATHEXT match, no exec bit required", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
  try {
    fs.writeFileSync(path.join(dir, "codex.EXE"), "not a real binary");
    const found = resolve("codex", {
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32",
    });
    assert.equal(found, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("win32: a bare name with no PATHEXT extension does not match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
  try {
    fs.writeFileSync(path.join(dir, "codex"), "not a real binary"); // no extension
    const found = resolve("codex", {
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32",
    });
    assert.equal(found, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI prints valid JSON and exits 0", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout);
  assert.equal(obj.claude, true);
  assert.equal(typeof obj.count, "number");
});
