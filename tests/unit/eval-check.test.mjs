// Runs tools/eval-check.mjs against every evals.json and asserts pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = path.join(REPO_ROOT, "tools", "eval-check.mjs");

test("all evals.json files pass structural validation", () => {
  const res = spawnSync("node", [CHECK], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(
    res.status,
    0,
    `eval-check failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`
  );
});

test("eval-check rejects duplicate assertion names within an eval", () => {
  const tmpDir = path.join(REPO_ROOT, "tests", "_tmp_evalcheck_dup");
  const tmpFile = path.join(tmpDir, "evals.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        skill_name: "x",
        evals: [
          {
            id: 1,
            prompt: "prompt body",
            expected_outcome: "do the thing",
            assertions: [
              { name: "dup", description: "description text here" },
              { name: "dup", description: "another description text" },
            ],
          },
        ],
      })
    );
    const res = spawnSync("node", [CHECK, tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /duplicate assertion name "dup"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("eval-check rejects bad assertion name format", () => {
  const tmpDir = path.join(REPO_ROOT, "tests", "_tmp_evalcheck_badname");
  const tmpFile = path.join(tmpDir, "evals.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        skill_name: "x",
        evals: [
          {
            id: 1,
            prompt: "prompt body",
            assertions: [
              { name: "Has-Caps", description: "name has caps and hyphens" },
            ],
          },
        ],
      })
    );
    const res = spawnSync("node", [CHECK, tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /must be lowercase letters\/digits\/underscores/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("eval-check rejects short prompt and short description", () => {
  const tmpDir = path.join(REPO_ROOT, "tests", "_tmp_evalcheck_short");
  const tmpFile = path.join(tmpDir, "evals.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        skill_name: "x",
        evals: [
          {
            id: 1,
            prompt: "hi",
            assertions: [{ name: "x", description: "short" }],
          },
        ],
      })
    );
    const res = spawnSync("node", [CHECK, tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /description must be a non-trivial string/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
