// Guards the v6 public-surface story: manifests, the retained plugin
// implementations, the website, tooling, and README content must describe
// the actual ten-skill v6 product -- never the removed v5
// software-lifecycle/triage/Playwright/longctx/Veo/Gemini-CLI-extension
// surface.
//
// Removed command names and claims are allowed ONLY inside:
//   1. the README's clearly delimited "## Migrating to 6.0.0" section,
//   2. the three explicitly marked historical documents, and
//   3. the v6 plan itself (docs/superpowers/plans/2026-07-18-*.md).
//
// Every one of those three exemptions is itself asserted here -- by exact
// path, by anchor uniqueness, and by non-vacuous content -- so a
// moved/renamed/deleted/duplicated anchor fails this file loudly instead of
// silently exempting more (or all) of the scanned corpus. See the "lesson"
// in the Task 12 brief: a fallthrough exemption that cannot fail is really
// an accept.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Verbatim reject list from the Task 12 brief, Step 1.
const REJECTED_STRINGS = Object.freeze([
  "/codex:playwright",
  "/agy:longctx",
  "/agy:veo",
  "/agy:setup",
  "/contexthub:spec",
  "/contexthub:plan",
  "/contexthub:tdd",
  "/contexthub:review",
  "/contexthub:verify",
  "/contexthub:debug",
  "/contexthub:ship",
  "/contexthub:triage",
  "gpt-5.5",
  "gemini cli extension",
  "nanobanana mcp",
  "software lifecycle",
  "task triage",
]);

/** Returns the subset of REJECTED_STRINGS present in `text` (case-insensitive). */
function findRejected(text) {
  const lower = text.toLowerCase();
  return REJECTED_STRINGS.filter((needle) => lower.includes(needle));
}

function readFile(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// Exemption 1: the README's delimited "## Migrating to 6.0.0" section.
// ---------------------------------------------------------------------------

const README_PATH = path.join(REPO_ROOT, "README.md");
const MIGRATION_HEADING = "## Migrating to 6.0.0";

/**
 * Splits README content into { before, section, after } around the
 * migration heading. The section runs from the heading up to (but not
 * including) the next top-level "## " heading, or end of file if this is
 * the last section. Returns null if the heading is absent.
 */
function splitReadmeMigrationSection(content) {
  const headingIndex = content.indexOf(MIGRATION_HEADING);
  if (headingIndex === -1) return null;
  const afterHeading = headingIndex + MIGRATION_HEADING.length;
  const rest = content.slice(afterHeading);
  const nextHeadingRel = rest.search(/\n## /);
  const sectionEnd = nextHeadingRel === -1 ? content.length : afterHeading + nextHeadingRel;
  return {
    before: content.slice(0, headingIndex),
    section: content.slice(headingIndex, sectionEnd),
    after: content.slice(sectionEnd),
  };
}

test("README has exactly one '## Migrating to 6.0.0' anchor", () => {
  const content = fs.readFileSync(README_PATH, "utf8");
  const occurrences = content.split(MIGRATION_HEADING).length - 1;
  assert.equal(
    occurrences,
    1,
    `expected exactly one "${MIGRATION_HEADING}" heading in README.md, found ${occurrences}. ` +
      `The stale-reference exemption below is anchored to this exact heading text and MUST fail ` +
      `(not silently pass) if it is renamed, moved, deleted, or duplicated.`
  );
});

test("the README migration section is non-trivial and genuinely contains removed-command names (exemption is not vacuous)", () => {
  const content = fs.readFileSync(README_PATH, "utf8");
  const split = splitReadmeMigrationSection(content);
  assert.ok(split, `"${MIGRATION_HEADING}" must be present for this test to mean anything`);
  assert.ok(
    split.section.length > 200,
    `the migration section is only ${split.section.length} chars -- expected a real migration table, ` +
      `not an empty or near-empty heading (an empty section would make the exemption below vacuous)`
  );
  const found = findRejected(split.section);
  assert.ok(
    found.length > 0,
    "the migration section contains none of the rejected removed-command strings. If this fails, " +
      "either the section was gutted (exemption now protects nothing) or the reject list drifted."
  );
});

test("README content OUTSIDE the migration section names none of the removed v5 commands or claims", () => {
  const content = fs.readFileSync(README_PATH, "utf8");
  const split = splitReadmeMigrationSection(content);
  assert.ok(split, `"${MIGRATION_HEADING}" must be present for this exemption to apply at all`);
  const outside = split.before + split.after;
  const found = findRejected(outside);
  assert.deepEqual(
    found,
    [],
    `README.md contains removed-surface strings OUTSIDE "${MIGRATION_HEADING}": ${found.join(", ")}`
  );
});

test("the migration table routes each removed contexthub lifecycle command to a Superpowers skill, not a new Carefully Crafted alias", () => {
  const content = fs.readFileSync(README_PATH, "utf8");
  const split = splitReadmeMigrationSection(content);
  assert.ok(split, `"${MIGRATION_HEADING}" must be present`);
  const lifecycleCommands = [
    "/contexthub:spec",
    "/contexthub:plan",
    "/contexthub:tdd",
    "/contexthub:review",
    "/contexthub:verify",
    "/contexthub:debug",
    "/contexthub:ship",
  ];
  const lines = split.section.split("\n");
  for (const cmd of lifecycleCommands) {
    const row = lines.find((l) => l.includes(cmd));
    assert.ok(row, `migration table must include a row mentioning ${cmd}`);
    assert.ok(
      row.toLowerCase().includes("superpowers:"),
      `migration row for ${cmd} must route to a "superpowers:" skill (product thesis: Superpowers ` +
        `owns methodology), not a new contexthub alias. Row was: ${row}`
    );
  }
});

test("the migration table does not invent a new /contexthub: alias as the replacement for a removed lifecycle command", () => {
  const content = fs.readFileSync(README_PATH, "utf8");
  const split = splitReadmeMigrationSection(content);
  assert.ok(split, `"${MIGRATION_HEADING}" must be present`);
  // Any /contexthub: command mentioned in the migration section must be one
  // of the two commands that still actually exist (supervise, converge) --
  // never a freshly-invented replacement alias standing in for a deleted
  // lifecycle phase.
  const survivingContexthubCommands = new Set(["/contexthub:supervise", "/contexthub:converge"]);
  const matches = split.section.match(/\/contexthub:[a-z-]+/g) || [];
  const inventedAliases = matches.filter(
    (m) => !survivingContexthubCommands.has(m) && !REJECTED_STRINGS.includes(m)
  );
  assert.deepEqual(
    inventedAliases,
    [],
    `migration section references /contexthub: commands that are neither a removed command being ` +
      `migrated away from nor a surviving command: ${inventedAliases.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// Exemption 2: the three explicitly marked historical documents.
// Matched by EXACT relative path (a Set, strict equality) -- never by
// substring or prefix -- so a new file cannot accidentally satisfy the
// allowlist by sharing part of a historical file's name or directory.
// ---------------------------------------------------------------------------

const HISTORICAL_FILES = Object.freeze([
  "docs/superpowers/plans/2026-05-28-contexthub-consolidation.md",
  "docs/superpowers/specs/2026-05-28-contexthub-consolidation-design.md",
  "docs/carefully-crafted-plugins/forge/spec/2026-05-28-195003-contexthub-multiagent-consolidation.md",
]);

const HISTORICAL_NOTICE_MARKER = "Historical v5 document.";

test("all three historical documents exist at their exact recorded paths", () => {
  for (const rel of HISTORICAL_FILES) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, rel)),
      `expected historical document to exist at exactly "${rel}" -- the allowlist below matches by ` +
        `exact path, so a rename must update this list, not silently fall through`
    );
  }
});

test("each historical document carries the v5-superseded notice immediately after its title", () => {
  for (const rel of HISTORICAL_FILES) {
    const content = readFile(rel);
    const lines = content.split("\n");
    assert.ok(lines[0].startsWith("# "), `${rel}: expected line 1 to be the document's "# " title`);
    const earlyBlock = lines.slice(1, 6).join("\n");
    assert.ok(
      earlyBlock.includes(HISTORICAL_NOTICE_MARKER),
      `${rel}: expected the historical-v5 notice immediately after the title, within the first few lines`
    );
  }
});

test("at least one historical document still contains genuine removed-surface strings (allowlist is not exempting nothing)", () => {
  // Not every historical document happens to use the literal slash-command
  // spelling (the design doc describes the same rename in prose), so this
  // does not require every file in HISTORICAL_FILES to match -- only that
  // the exemption is provably load-bearing for at least one real file,
  // proving findRejected() and the reject list are not themselves stale or
  // silently broken.
  const perFile = HISTORICAL_FILES.map((rel) => ({ rel, found: findRejected(readFile(rel)) }));
  const withMatches = perFile.filter((f) => f.found.length > 0);
  assert.ok(
    withMatches.length > 0,
    `expected at least one of the historical documents to contain a removed-surface string; found none in ` +
      `any of: ${HISTORICAL_FILES.join(", ")}. Either every historical instruction was rewritten (forbidden ` +
      `by the brief) or the reject list has drifted from what these documents actually record.`
  );
});

test("historical-file matching is by exact path, not substring -- a lookalike file is not exempt", () => {
  // Regression guard for the failure mode named in the brief: verifies the
  // allowlist really is a Set of exact strings, not something that would
  // let "docs/superpowers/plans/2026-05-28-contexthub-consolidation.md-evil.md"
  // or a file merely living in the same directory slip through.
  const exemptSet = new Set(HISTORICAL_FILES);
  const lookalikes = [
    "docs/superpowers/plans/2026-05-28-contexthub-consolidation.md-evil.md",
    "docs/superpowers/plans/2026-05-28-contexthub-consolidation",
    "docs/carefully-crafted-plugins/forge/spec/not-the-real-file.md",
  ];
  for (const fake of lookalikes) {
    assert.equal(exemptSet.has(fake), false, `"${fake}" must not be treated as an exempt historical file`);
  }
});

// ---------------------------------------------------------------------------
// Exemption 3: the v6 plan itself. It lives under docs/, which the scanned
// corpus below never walks -- so its exemption is structural (out of scope),
// not a string match. This test only guards that the plan is where the
// brief and the other two exemptions' cross-references expect it.
// ---------------------------------------------------------------------------

const V6_PLAN_FILE = "docs/superpowers/plans/2026-07-18-carefully-crafted-supervision-redesign.md";

test("the v6 plan exists at its exact recorded path", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, V6_PLAN_FILE)), `expected the v6 plan at exactly "${V6_PLAN_FILE}"`);
});

// ---------------------------------------------------------------------------
// The scanned corpus: manifests, retained plugin implementations, the
// website, and tooling. Built by walking the actual directory tree (never a
// hardcoded file list), so a future file cannot silently escape the scan.
// ---------------------------------------------------------------------------

function walkFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extensions));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function scanCorpus() {
  const files = new Set();

  // Manifests.
  files.add(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"));
  const pluginsDir = path.join(REPO_ROOT, "plugins");
  for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const manifest = path.join(pluginsDir, plugin.name, ".claude-plugin", "plugin.json");
    if (fs.existsSync(manifest)) files.add(manifest);
  }

  // Retained plugin implementations -- skills, scripts, references,
  // schemas, and active evals -- discovered by walking plugins/ itself.
  for (const f of walkFiles(pluginsDir, [".md", ".mjs", ".json"])) {
    files.add(f);
  }

  // Website.
  files.add(path.join(REPO_ROOT, "index.html"));

  // Tools -- every script, discovered dynamically.
  for (const f of walkFiles(path.join(REPO_ROOT, "tools"), [".mjs"])) {
    files.add(f);
  }

  return [...files].filter((f) => fs.existsSync(f));
}

test("the scan actually visits the plugin/tooling/website corpus (non-vacuous)", () => {
  const files = scanCorpus();
  // Thresholds are comfortably below the real corpus size so this fails
  // loudly if a future refactor makes walkFiles() (or a call site) return
  // an empty or near-empty list instead of the real tree.
  assert.ok(files.length >= 20, `expected the scan to visit at least 20 files, visited ${files.length}`);

  const relFiles = files.map((f) => path.relative(REPO_ROOT, f));
  assert.ok(relFiles.includes("index.html"), "scan must include index.html");
  assert.ok(relFiles.includes(".claude-plugin/marketplace.json"), "scan must include the marketplace manifest");
  assert.ok(
    relFiles.includes("plugins/contexthub/.claude-plugin/plugin.json"),
    "scan must include the contexthub plugin manifest"
  );
  assert.ok(
    relFiles.includes("plugins/codex/.claude-plugin/plugin.json"),
    "scan must include the codex plugin manifest"
  );
  assert.ok(
    relFiles.includes("plugins/agy/.claude-plugin/plugin.json"),
    "scan must include the agy plugin manifest"
  );
  assert.ok(
    relFiles.some((f) => f.startsWith("plugins/contexthub/skills/supervise/")),
    "scan must include the supervise skill directory"
  );
  assert.ok(
    relFiles.some((f) => f.startsWith("plugins/contexthub/skills/converge/")),
    "scan must include the converge skill directory"
  );
  assert.ok(
    relFiles.some((f) => f.endsWith("evals.json")),
    "scan must include at least one active evals.json"
  );
  assert.ok(
    relFiles.some((f) => f.startsWith("tools/") && f.endsWith(".mjs")),
    "scan must include tools/*.mjs"
  );
  // Removed skill directories genuinely do not exist, so the scan cannot
  // (and must not) find them -- this pins that assumption rather than
  // leaving it implicit.
  for (const removed of [
    "plugins/codex/skills/playwright",
    "plugins/agy/skills/longctx",
    "plugins/agy/skills/setup",
    "plugins/agy/skills/veo",
    "plugins/contexthub/skills/triage",
  ]) {
    assert.ok(!relFiles.some((f) => f.startsWith(removed + "/")), `removed skill dir "${removed}" must not exist`);
  }
});

test("manifests, retained plugins, website, and tools contain none of the removed v5 surface strings", () => {
  const files = scanCorpus();
  const offenders = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const found = findRejected(content);
    if (found.length > 0) {
      offenders.push(`${path.relative(REPO_ROOT, file)}: ${found.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [], `stale v5 references found outside all exemptions:\n${offenders.join("\n")}`);
});
