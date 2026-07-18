// Locks the exact post-prune skill inventory for the v6 marketplace surface.
// Reads plugins/<plugin>/skills/<skill>/SKILL.md discovery convention and
// compares it against EXPECTED_SKILLS. Task 10 extends this same object
// from nine skills to ten by adding "supervise" to the contexthub array.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_DIR = path.join(REPO_ROOT, "plugins");

const EXPECTED_SKILLS = Object.freeze({
  agy: ["exec", "nanobanana"],
  codex: ["exec", "imagegen", "reason", "resume", "review", "setup"],
  contexthub: ["converge"],
});

const REMOVED_SKILL_DIRS = Object.freeze([
  "plugins/codex/skills/playwright",
  "plugins/agy/skills/longctx",
  "plugins/agy/skills/setup",
  "plugins/agy/skills/veo",
  "plugins/contexthub/skills/spec",
  "plugins/contexthub/skills/plan",
  "plugins/contexthub/skills/tdd",
  "plugins/contexthub/skills/review",
  "plugins/contexthub/skills/verify",
  "plugins/contexthub/skills/debug",
  "plugins/contexthub/skills/ship",
  "plugins/contexthub/skills/triage",
]);

function discoverSkills() {
  const plugins = fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const inventory = {};
  for (const plugin of plugins) {
    const skillsDir = path.join(PLUGINS_DIR, plugin, "skills");
    if (!fs.existsSync(skillsDir)) continue;
    const skills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    inventory[plugin] = skills;
  }
  return inventory;
}

test("plugin skill inventory matches the locked v6 surface exactly", () => {
  const actual = discoverSkills();
  assert.deepEqual(actual, EXPECTED_SKILLS);
});

test("every retained skill directory has a SKILL.md", () => {
  for (const [plugin, skills] of Object.entries(EXPECTED_SKILLS)) {
    for (const skill of skills) {
      const skillMd = path.join(PLUGINS_DIR, plugin, "skills", skill, "SKILL.md");
      assert.ok(
        fs.existsSync(skillMd),
        `expected ${path.relative(REPO_ROOT, skillMd)} to exist`
      );
    }
  }
});

test("the twelve retired skill directories no longer exist", () => {
  for (const relDir of REMOVED_SKILL_DIRS) {
    const dir = path.join(REPO_ROOT, relDir);
    assert.equal(fs.existsSync(dir), false, `expected ${relDir} to have been removed`);
  }
});
