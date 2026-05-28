// Unit tests for plugins/contexthub/scripts/agent-availability.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "contexthub", "scripts", "agent-availability.mjs");
const { detect, probe } = await import(SCRIPT);

function fakeBinDir(names, { exit = 0, sleepSec = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
  for (const name of names) {
    const body = sleepSec ? `#!/bin/sh\n/bin/sleep ${sleepSec}\nexit ${exit}\n` : `#!/bin/sh\nexit ${exit}\n`;
    fs.writeFileSync(path.join(dir, name), body);
    fs.chmodSync(path.join(dir, name), 0o755);
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

test("present but --version fails => unavailable", () => {
  const dir = fakeBinDir(["codex"], { exit: 1 });
  try { assert.equal(probe("codex", { env: { PATH: dir } }), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hanging agent is killed by timeout => unavailable", () => {
  const dir = fakeBinDir(["codex"], { sleepSec: 5 });
  try { assert.equal(probe("codex", { env: { PATH: dir }, timeoutMs: 300 }), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI prints valid JSON and exits 0", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout);
  assert.equal(obj.claude, true);
  assert.equal(typeof obj.count, "number");
});
