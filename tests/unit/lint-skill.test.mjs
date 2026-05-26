// Runs tools/lint-skill.mjs against every SKILL.md in the marketplace
// and asserts the lint passes. This is how the quality bar gets
// enforced in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINT = path.join(REPO_ROOT, "tools", "lint-skill.mjs");

test("all SKILL.md files pass the quality bar lint", () => {
  const res = spawnSync("node", [LINT], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(
    res.status,
    0,
    `lint-skill failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`
  );
});

test("lint rejects a SKILL.md with no closing claim", () => {
  // Inline-fixture test: write a temp SKILL.md without "default ... path"
  // or "slash-command only", confirm lint errors.
  const tmpDir = path.join(REPO_ROOT, "tests", "_tmp_lint_skill");
  const tmpFile = path.join(tmpDir, "SKILL.md");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    fs.writeFileSync(
      tmpFile,
      `---
name: probe
description: Generate things and stuff for various reasons across many domains, including but not limited to widgets, gizmos, and assorted contraptions that fill the gap between requirements and reality in a most agreeable fashion.
---

# probe

body
`
    );
    const res = spawnSync("node", [LINT, tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 1, "expected lint to fail");
    assert.match(res.stdout, /must end with a closing claim/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("lint rejects an over-long body", () => {
  const tmpDir = path.join(REPO_ROOT, "tests", "_tmp_lint_skill_body");
  const tmpFile = path.join(tmpDir, "SKILL.md");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const longBody = Array.from({ length: 300 }, () => "filler line").join("\n");
    fs.writeFileSync(
      tmpFile,
      `---
name: bloat
description: Test fixture that uses Codex via the long route. Use whenever the user mentions filler, padding, or any kind of artificial line bloat. Default bloat path in this marketplace.
---

# bloat

${longBody}
`
    );
    const res = spawnSync("node", [LINT, tmpFile], { encoding: "utf8" });
    assert.equal(res.status, 1, "expected lint to fail");
    assert.match(res.stdout, /split detail into references/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
