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
import { lintOne, findSkills, parseFrontmatter, classifyInvocation } from "../../tools/lint-skill.mjs";

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

test("a typo'd disable-model-invocation value fails loudly AND does not grant the evals exemption", () => {
  withTmpDir("lint_bad_bool", (dir) => {
    // Deliberately NO evals/ directory. That is what makes the
    // consequence of manualOnly=false observable: if any lenient second
    // check ever re-grants the exemption on a truthy-looking value
    // (e.g. `if (!(manualOnly || frontmatter["disable-model-invocation"]))`),
    // the evals error disappears and this test fails. With a valid
    // evals/ present, both sides of that mutation look identical and the
    // test proves nothing.
    writeSkill(
      dir,
      `---
name: probe
description: Use whenever the user wants to fire the probe payload for calibration runs across many environments.
disable-model-invocation: yes
---

# probe

body
`
    );
    const { findings, manualOnly } = lintOne(path.join(dir, "SKILL.md"));
    const joined = findings.errors.join("\n");
    assert.match(joined, /disable-model-invocation must be the literal boolean/);
    assert.equal(manualOnly, false);
    // The load-bearing assertion: the exemption was NOT granted.
    assert.match(
      joined,
      /model-invocable skills must ship evals\/evals\.json/,
      "a rejected disable-model-invocation value must not exempt the skill from the evals requirement"
    );
  });
});

test("a frontmatter key with no space after the colon is rejected, not silently honored", () => {
  withTmpDir("lint_no_separator", (dir) => {
    // YAML block mappings require ": ". A real parser yields no such
    // key here, so the linter must not honor it either — otherwise a
    // skill could claim manual-only (and the evals exemption) via a
    // field the platform will never see.
    writeSkill(
      dir,
      `---
name: nospace
description: Fire the probe payload on demand for calibration runs.
disable-model-invocation:true
---

# nospace

body
`
    );
    const { findings, manualOnly } = lintOne(path.join(dir, "SKILL.md"));
    const joined = findings.errors.join("\n");
    assert.match(joined, /missing the space after the colon/);
    assert.equal(manualOnly, false, "a key YAML would not produce must not classify the skill as manual-only");
    assert.match(
      joined,
      /model-invocable skills must ship evals\/evals\.json/,
      "the malformed key must not grant the manual-only evals exemption"
    );
  });
});

test("a duplicated frontmatter key is rejected rather than resolved last-wins", () => {
  withTmpDir("lint_dup_key", (dir) => {
    // Strict YAML rejects duplicate keys. A last-wins reader would call
    // this manual-only; the platform might not agree.
    writeSkill(
      dir,
      `---
name: dup
description: Fire the probe payload on demand for calibration runs.
disable-model-invocation: false
disable-model-invocation: true
---

# dup

body
`
    );
    const { findings } = lintOne(path.join(dir, "SKILL.md"));
    assert.match(findings.errors.join("\n"), /appears more than once/);
  });
});

test("classifyInvocation is callable without a findings argument (exported signature)", () => {
  // Minor: the error branch used to throw TypeError on its own public
  // signature, so a caller got correct results right up until it hit a
  // malformed value.
  assert.equal(classifyInvocation({ "disable-model-invocation": "true" }), true);
  assert.equal(classifyInvocation({}), false);
  assert.doesNotThrow(() => classifyInvocation({ "disable-model-invocation": "yes" }));
  assert.equal(classifyInvocation({ "disable-model-invocation": "yes" }), false);
});

test("model-invocable skills require explicit trigger language — enforced as an error, isolated from the evals rule", () => {
  withTmpDir("lint_auto_no_trigger", (dir) => {
    // Ships VALID evals, so the evals rule is satisfied and cannot be
    // what fails this. The only defect is the missing trigger phrase —
    // which must be an error (exit 1), not a warning (exit 0).
    writeSkill(
      dir,
      `---
name: notrigger
description: Generate widgets from FooCorp's WidgetGen CLI for various shapes and sizes and colors as requested.
---

# notrigger

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(
      res.status,
      1,
      `missing trigger language must fail the build, not just warn:\n${res.stdout}`
    );
    assert.match(res.stdout, /error: model-invocable description lacks an explicit trigger phrase/);
  });
});

test("model-invocable skills require evals/evals.json — isolated from the trigger-language rule", () => {
  withTmpDir("lint_auto_no_evals", (dir) => {
    // Has a trigger phrase, so that rule is satisfied and cannot be what
    // fails this. The only defect is the missing evals file.
    writeSkill(
      dir,
      `---
name: noeval
description: Use whenever the user wants widgets, gizmos, or any kind of mechanical contraption built quickly.
---

# noeval

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "expected lint to fail without evals");
    assert.match(res.stdout, /error: model-invocable skills must ship evals\/evals\.json/);
    assert.doesNotMatch(res.stdout, /lacks an explicit trigger phrase/);
  });
});

test("a model-invocable skill shipping only ONE eval is rejected (the 2+ bound is real)", () => {
  withTmpDir("lint_one_eval", (dir) => {
    writeSkill(
      dir,
      `---
name: oneeval
description: Use whenever the user wants widgets, gizmos, or any kind of mechanical contraption built quickly.
---

# oneeval

body
`,
      {
        evals: {
          skill_name: "oneeval",
          evals: [{ id: 1, prompt: "do the thing", assertions: [{ name: "x", description: "y" }] }],
        },
      }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 1, "one eval must fail the 2+ requirement");
    assert.match(res.stdout, /must contain at least 2 evals \(found 1\)/);
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

  withTmpDir("lint_auto_word_bounds_ok", (dir) => {
    // 15 words: exactly at the model-invocable floor — must PASS, which
    // pins the boundary from the accepting side too.
    writeSkill(
      dir,
      `---
name: short
description: Use whenever the user wants widgets generated from the Foo CLI for basic testing purposes.
---

# short

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 0, `15-word auto description should pass:\n${res.stdout}`);
  });
});

test("a description of exactly 60 words passes in both modes (ceiling is inclusive)", () => {
  const filler = "widget ".repeat(60).trim() + "."; // 60 words

  withTmpDir("lint_manual_exactly_60", (dir) => {
    writeSkill(
      dir,
      `---
name: exactly
description: ${filler}
disable-model-invocation: true
---

# exactly

body
`
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 0, `exactly 60 words should pass for manual-only:\n${res.stdout}`);
  });

  withTmpDir("lint_auto_exactly_60", (dir) => {
    // "Use whenever the user wants" (5) + 55 filler words = 60.
    const autoFiller = "Use whenever the user wants " + "widget ".repeat(55).trim() + ".";
    writeSkill(
      dir,
      `---
name: exactly
description: ${autoFiller}
---

# exactly

body
`,
      { evals: TWO_VALID_EVALS }
    );
    const res = spawnSync("node", [LINT, path.join(dir, "SKILL.md")], { encoding: "utf8" });
    assert.equal(res.status, 0, `exactly 60 words should pass for model-invocable:\n${res.stdout}`);
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
