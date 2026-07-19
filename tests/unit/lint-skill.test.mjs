// Runs tools/lint-skill.mjs against every SKILL.md in the marketplace
// and asserts the lint passes. This is how the quality bar gets
// enforced in CI.
//
// Manual-only vs model-invocable is a native-frontmatter fact
// (`disable-model-invocation: true`), not a prose convention — these
// tests exercise that classifier directly via the exported functions,
// not by re-deriving the rule in the test file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintOne, findSkills, parseFrontmatter } from "../../tools/lint-skill.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LINT = path.join(REPO_ROOT, "tools", "lint-skill.mjs");

function writeSkill(dir, content, { evals } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  if (evals) {
    fs.mkdirSync(path.join(dir, "evals"), { recursive: true });
    fs.writeFileSync(path.join(dir, "evals", "evals.json"), JSON.stringify(evals));
  }
}

function withTmpDir(name, fn) {
  const dir = path.join(REPO_ROOT, "tests", `_tmp_${name}`);
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TWO_VALID_EVALS = {
  skill_name: "fixture",
  evals: [
    { id: 1, prompt: "do the thing", assertions: [{ name: "x", description: "y" }] },
    { id: 2, prompt: "do another thing", assertions: [{ name: "x", description: "y" }] },
  ],
};

test("all SKILL.md files pass the quality bar lint", () => {
  const res = spawnSync("node", [LINT], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(
    res.status,
    0,
    `lint-skill failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`
  );
});

test("exactly eight skills are manual-only and two are model-invocable", () => {
  // This drives the exact split the task requires, and does so through
  // the real classifier (lintOne), not a copy of its logic — if the
  // frontmatter parse or the classification rule breaks, this fails too.
  const manual = [];
  const auto = [];
  for (const file of findSkills()) {
    const { name, manualOnly } = lintOne(file);
    const plugin = path.relative(REPO_ROOT, file).split(path.sep)[1];
    (manualOnly ? manual : auto).push(`${plugin}:${name}`);
  }
  assert.deepEqual(
    manual.sort(),
    [
      "agy:exec",
      "agy:nanobanana",
      "codex:exec",
      "codex:resume",
      "codex:review",
      "codex:setup",
      "contexthub:converge",
      "contexthub:supervise",
    ].sort()
  );
  assert.deepEqual(auto.sort(), ["codex:imagegen", "codex:reason"].sort());
});

test("codex:review's manual description reads as an explicit, independent audit/evidence source — not a generic lifecycle owner", () => {
  const file = path.join(REPO_ROOT, "plugins", "codex", "skills", "review", "SKILL.md");
  const { frontmatter } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const desc = frontmatter.description;
  assert.equal(frontmatter["disable-model-invocation"], "true");
  assert.match(desc, /on explicit request/i, "must frame itself as explicitly requested, not auto-triggered");
  assert.match(desc, /independent/i, "must identify itself as an independent second opinion");
  assert.match(desc, /(audit|evidence)/i, "must identify itself as an audit/evidence source");
  assert.doesNotMatch(
    desc,
    /default[^.]*(review )?path/i,
    "must not claim to be the default/owning review path — that would make it a lifecycle owner, not transport"
  );
});

test("disable-model-invocation: true classifies a skill as manual-only", () => {
  withTmpDir("lint_manual_true", (dir) => {
    writeSkill(
      dir,
      `---
name: probe
description: Fire the probe payload on demand for calibration runs.
disable-model-invocation: true
---

# probe

body
`
    );
    const { findings, manualOnly } = lintOne(path.join(dir, "SKILL.md"));
    assert.equal(manualOnly, true);
    assert.deepEqual(findings.errors, []);
  });
});

test("manual-only skills do not require evals/evals.json", () => {
  withTmpDir("lint_manual_no_evals", (dir) => {
    // No evals/ directory at all.
    writeSkill(
      dir,
      `---
name: probe
description: Fire the probe payload on demand for calibration runs.
disable-model-invocation: true
---

# probe

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 0, `expected lint to pass without evals:\n${res.stdout}\n${res.stderr}`);
  });
});

test('a prose "slash-command only" claim without the field is rejected', () => {
  withTmpDir("lint_prose_without_field", (dir) => {
    // Description claims manual-only in prose, meets word/trigger
    // requirements, and ships evals — isolating the assertion to the
    // missing-frontmatter-field error specifically.
    writeSkill(
      dir,
      `---
name: probe
description: Use whenever the user wants to fire the probe payload for calibration runs across many environments. Slash-command only: invoke as /probe.
---

# probe

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "expected lint to fail");
    assert.match(res.stdout, /frontmatter field is authoritative/);
  });
});

test("a typo'd disable-model-invocation value fails loudly rather than defaulting silently", () => {
  withTmpDir("lint_bad_bool", (dir) => {
    writeSkill(
      dir,
      `---
name: probe
description: Use whenever the user wants to fire the probe payload for calibration runs across many environments.
disable-model-invocation: yes
---

# probe

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const { findings, manualOnly } = lintOne(path.join(dir, "SKILL.md"));
    assert.match(findings.errors.join("\n"), /disable-model-invocation must be the literal boolean/);
    // A rejected value must not silently grant the manual-only exemption.
    assert.equal(manualOnly, false);
  });
});

test("model-invocable skills require explicit trigger language (warns) and 2+ evals (errors)", () => {
  withTmpDir("lint_auto_requirements", (dir) => {
    // No trigger phrase, no evals dir — model-invocable by omission of
    // disable-model-invocation.
    writeSkill(
      dir,
      `---
name: noeval
description: Generate widgets from FooCorp's WidgetGen CLI for various shapes and sizes and colors as requested.
---

# noeval

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "expected lint to fail without evals");
    assert.match(res.stdout, /model-invocable skills must ship evals\/evals\.json/);
    assert.match(res.stdout, /lacks an explicit trigger phrase/);
  });
});

test("lint passes when a model-invocable skill has trigger language and evals/evals.json", () => {
  withTmpDir("lint_auto_ok", (dir) => {
    writeSkill(
      dir,
      `---
name: hasevals
description: Generate widgets using FooCorp's WidgetGen via the Foo CLI. Use whenever the user wants widgets, gizmos, or any kind of mechanical contraption.
---

# hasevals

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 0, `expected lint to pass:\n${res.stdout}\n${res.stderr}`);
  });
});

test("manual descriptions allow 8-60 words", () => {
  withTmpDir("lint_manual_word_bounds", (dir) => {
    // 7 words: below the manual-only floor of 8.
    writeSkill(
      dir,
      `---
name: short
description: Fire the probe payload for calibration now.
disable-model-invocation: true
---

# short

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "7-word manual description should fail the 8-word floor");
    assert.match(res.stdout, /min 8 for a manual-only skill/);
  });

  withTmpDir("lint_manual_word_bounds_ok", (dir) => {
    // 8 words: exactly at the manual-only floor.
    writeSkill(
      dir,
      `---
name: short
description: Fire the probe payload for calibration runs now.
disable-model-invocation: true
---

# short

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 0, `8-word manual description should pass:\n${res.stdout}`);
  });
});

test("model-invocable descriptions allow 15-60 words", () => {
  withTmpDir("lint_auto_word_bounds", (dir) => {
    // 14 words: below the model-invocable floor of 15.
    writeSkill(
      dir,
      `---
name: short
description: Use whenever the user wants widgets generated from the Foo CLI for testing purposes.
---

# short

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "14-word auto description should fail the 15-word floor");
    assert.match(res.stdout, /min 15 for a model-invocable skill/);
  });
});

test("descriptions above 60 words fail for both manual and model-invocable skills", () => {
  const longDesc = "widget ".repeat(61).trim() + ".";

  withTmpDir("lint_manual_too_long", (dir) => {
    writeSkill(
      dir,
      `---
name: toolong
description: ${longDesc}
disable-model-invocation: true
---

# toolong

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "manual description over 60 words should fail");
    assert.match(res.stdout, /max 60/);
  });

  withTmpDir("lint_auto_too_long", (dir) => {
    writeSkill(
      dir,
      `---
name: toolong
description: Use whenever the user wants ${longDesc}
---

# toolong

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "model-invocable description over 60 words should fail");
    assert.match(res.stdout, /max 60/);
  });
});

test("lint rejects an over-long body", () => {
  withTmpDir("lint_body_too_long", (dir) => {
    const longBody = Array.from({ length: 300 }, () => "filler line").join("\n");
    writeSkill(
      dir,
      `---
name: bloat
description: Use whenever the user mentions filler, padding, or any kind of artificial line bloat testing.
---

# bloat

${longBody}
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "expected lint to fail");
    assert.match(res.stdout, /split detail into references/);
  });
});
