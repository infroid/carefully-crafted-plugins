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
import os from "node:os";
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
const MIGRATION_END_MARKER = "<!-- end migration -->";

/**
 * Splits README content into { before, section, after } around the
 * migration section.
 *
 * The section is closed at BOTH ends: it starts at the heading and ends at
 * whichever comes first -- the explicit MIGRATION_END_MARKER or the next
 * top-level "## " heading. It never runs to EOF.
 *
 * Ending at EOF was a real one-sided hole: because "## Migrating to 6.0.0"
 * is the last section of the README, anything appended to the end of the
 * file landed inside the exemption and was silently excused. Requiring an
 * explicit terminator makes the exemption's absence a loud failure (this
 * function throws) instead of a silent widening.
 *
 * Returns null only if the heading itself is absent; a dedicated test
 * asserts non-null so that case fails loudly too.
 */
function splitReadmeMigrationSection(content) {
  const headingIndex = content.indexOf(MIGRATION_HEADING);
  if (headingIndex === -1) return null;
  const afterHeading = headingIndex + MIGRATION_HEADING.length;
  const rest = content.slice(afterHeading);

  const markerRel = rest.indexOf(MIGRATION_END_MARKER);
  if (markerRel === -1) {
    throw new Error(
      `README.md has "${MIGRATION_HEADING}" but no "${MIGRATION_END_MARKER}" terminator after it. ` +
        `The exemption must be closed at BOTH ends -- without the terminator it would run to the ` +
        `next heading or, for the last section in the file, all the way to EOF, silently excusing ` +
        `anything appended to README.md.`
    );
  }
  const markerEnd = afterHeading + markerRel + MIGRATION_END_MARKER.length;

  const nextHeadingRel = rest.search(/\n## /);
  const headingEnd = nextHeadingRel === -1 ? null : afterHeading + nextHeadingRel;

  // Whichever boundary comes first wins, so a terminator accidentally placed
  // after a later heading cannot re-widen the exemption across that heading.
  const sectionEnd = headingEnd === null ? markerEnd : Math.min(markerEnd, headingEnd);

  return {
    before: content.slice(0, headingIndex),
    section: content.slice(headingIndex, sectionEnd),
    after: content.slice(sectionEnd),
  };
}

test("the migration section is terminated by exactly one end marker, placed after the heading", () => {
  const content = fs.readFileSync(README_PATH, "utf8");
  const markerCount = content.split(MIGRATION_END_MARKER).length - 1;
  assert.equal(
    markerCount,
    1,
    `expected exactly one "${MIGRATION_END_MARKER}" in README.md, found ${markerCount}. This marker ` +
      `closes the stale-reference exemption; its absence (or duplication) must fail here rather than ` +
      `silently widening the exempt region.`
  );
  const headingIndex = content.indexOf(MIGRATION_HEADING);
  const markerIndex = content.indexOf(MIGRATION_END_MARKER);
  assert.ok(headingIndex !== -1, `"${MIGRATION_HEADING}" must be present`);
  assert.ok(
    markerIndex > headingIndex,
    `"${MIGRATION_END_MARKER}" must appear AFTER "${MIGRATION_HEADING}", otherwise it closes nothing`
  );
});

test("content appended after the migration terminator is NOT exempt (the tail is closed)", () => {
  // Directly exercises the hole this marker closes: text placed after the
  // terminator must be scanned, proving the exemption no longer runs to EOF.
  const content = fs.readFileSync(README_PATH, "utf8");
  const escapeText = "\nOur roadmap still leans on /contexthub:tdd and gpt-5.5 for the software lifecycle.\n";
  const split = splitReadmeMigrationSection(content + escapeText);
  assert.ok(split, `"${MIGRATION_HEADING}" must be present`);
  const outside = split.before + split.after;
  assert.ok(
    outside.includes("Our roadmap still leans on"),
    "text appended to the end of README.md must fall OUTSIDE the exempt section"
  );
  const found = findRejected(outside);
  assert.ok(
    found.includes("/contexthub:tdd") && found.includes("gpt-5.5") && found.includes("software lifecycle"),
    `appended stale references must be caught outside the exemption; caught: ${found.join(", ") || "(none)"}`
  );
});

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

// Fail-CLOSED by extension: every file under a scanned root is read unless
// its extension is a known *binary* one.
//
// This replaces an inclusion allowlist (.md/.mjs/.json) that let a new
// .txt/.html/.yaml file escape the scan simply by not being on the list --
// the same "closed the named instance, not the property" failure mode this
// plan keeps hitting. A denylist means a newly-introduced text format is
// scanned by default and only a deliberate binary addition is skipped.
// .svg stays scannable: it is text and can carry product claims.
const BINARY_EXTENSIONS = Object.freeze(
  new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
    ".pdf", ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".ogg",
    ".node", ".wasm", ".dylib", ".so", ".dll", ".exe",
  ])
);

/**
 * THE single definition of "the website" in this file: every top-level HTML
 * page. Both the stale-string corpus and the spec-claim surface list call
 * this, so the two can never drift into disagreeing about what the site is
 * (round-2 review found exactly that drift: one globbed, the other hardcoded
 * index.html).
 */
function rootHtmlPages() {
  return fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
    .map((e) => e.name)
    .sort();
}

function walkFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile() && !BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
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
  for (const f of walkFiles(pluginsDir)) {
    files.add(f);
  }

  // Website: EVERY top-level HTML page, globbed rather than named. Naming
  // index.html specifically meant a second page (docs.html, pricing.html)
  // would publish stale claims without the scan ever opening it.
  for (const name of rootHtmlPages()) {
    files.add(path.join(REPO_ROOT, name));
  }

  // Tools -- every script, discovered dynamically.
  for (const f of walkFiles(path.join(REPO_ROOT, "tools"))) {
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

// ---------------------------------------------------------------------------
// Truthfulness of the codex bridge's 5-section-spec claim.
//
// Only SOME codex skills build a handoff spec: `exec` explicitly refuses to
// ("Do **not** run `spec-builder.mjs`") and `resume` never mentions it. Any
// public surface claiming the spec is written for *every* delegation is
// therefore false.
//
// GROUND TRUTH is derived at runtime: `codexSkillsBySpecUsage()` reads every
// codex SKILL.md and classifies it by whether it actually invokes
// spec-builder.mjs. A seventh skill, or a change to `resume`, reclassifies
// itself with no edit here.
//
// DETECTION IS NECESSARILY INCOMPLETE -- do not over-trust it. Natural
// language has unbounded ways to assert universality. UNIVERSAL_CLAIM_PATTERNS
// below matches a deliberately widened but still FINITE set of shapes. Round-2
// review measured the previous 3x2 quantifier/noun grid at 3 of 12 natural
// phrasings; the current set is broader but a sufficiently novel phrasing
// ("in all cases", "unfailingly", "there is no path that skips it") will still
// slip through. Read a PASS as "no *recognized* over-claim was found", never
// as "these docs are proven honest".
//
// Two structural properties stop it from silently going inert -- both are
// round-2 review findings, and both are the reason the guard is worth having
// despite the incomplete matcher:
//
//   1. MARKDOWN IS NORMALIZED before matching. Emphasis, code spans, and line
//      wrapping previously hid claims completely: the qualifier group could
//      not match `**structured**`, so the live README produced ZERO matches
//      and a false universal written as `every **single** delegation` passed.
//      The guard was inert on the exact file the original defect lived on.
//   2. COVERAGE IS ASSERTED PER SURFACE, not globally. A surface expected to
//      carry the claim must visibly carry it; it cannot free-ride on another
//      surface's matches. Previously a single global `> 0` assertion was
//      satisfied entirely by two manifests while the README was dark.
// ---------------------------------------------------------------------------

const CODEX_SKILLS_DIR = path.join(REPO_ROOT, "plugins", "codex", "skills");
// A real invocation, not a mention: `exec` names the script only to forbid it.
const SPEC_BUILDER_INVOCATION = /node\s+\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/spec-builder\.mjs/;
const SPEC_COVERAGE_QUALIFIERS = new Set(["structured"]);

// Universality shapes. Widened in round 2 from a 3x2 quantifier/noun grid
// after it was measured at 3/12 on natural phrasings. Still not exhaustive --
// see the header note above.
const UNIVERSAL_CLAIM_PATTERNS = Object.freeze([
  // "every|each|all|any [<up to two qualifier words>] delegation|call|..."
  /\b(?:every|each|all|any)\s+((?:[a-z-]+\s+){0,2}?)(?:delegation|call|invocation|request|use|task|skill|time)s?\b/gi,
  // "always writes|builds|produces|..."
  /\balways\s+((?:[a-z-]+\s+){0,2}?)(?:writes|builds|produces|creates|generates|emits|includes)\b/gi,
  // Idiomatic absolutes.
  /\b100%\s+of\s+the\s+time\b/gi,
  /\bwithout\s+exception\b/gi,
  /\bno\s+exceptions\b/gi,
]);

/**
 * Makes every line inside a fenced block its own sentence unit, by giving
 * unterminated fenced lines a terminator before whitespace is collapsed.
 *
 * This REPLACES a round-2 approach that stripped fenced blocks entirely.
 * Stripping was too blunt: round-3 review showed this README's fences do
 * carry product prose (`README.md:35` documents `/codex:setup` inside a
 * fence), so a claim written in a fence -- as a comment or as a full
 * sentence -- escaped the guard completely.
 *
 * Line-delimiting is strictly stronger than either stripping or narrowing:
 * fenced content is now fully SCANNED, so there is no fence exemption left to
 * escape through. It also fixes the original false positive at its real root.
 * That root was never "fences are code" -- it was that an entire fenced block
 * collapsed into ONE pseudo-sentence, so the `## Layout` tree's row
 * `quality-bar.md  # the gates every skill must clear` borrowed spec-scope
 * from `spec-builder.mjs` thirty lines above it. Per-line units end that
 * cross-row bleed while leaving a fenced sentence fully in scope.
 */
function delimitFencedLines(text) {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (!inFence) return line;
      return /[.!?]$/.test(line.trimEnd()) ? line : `${line}.`;
    })
    .join("\n");
}

/**
 * Strips markdown emphasis/code markers and collapses whitespace so a claim
 * cannot hide behind formatting or a line wrap. Also has the useful side
 * effect of breaking CSS identifiers like `handoff__layout` into a token that
 * no longer matches /\bhandoff\b/, keeping stylesheet noise out of scope.
 */
function normalizeMarkdown(text) {
  return text.replace(/[*_`~]/g, "").replace(/\s+/g, " ");
}

/**
 * A match is acceptable if an approved qualifier appears inside the matched
 * phrase or immediately after it (same sentence, short window) -- covering
 * both "every structured delegation" and "always writes a structured spec".
 */
function isQualifiedClaim(sentence, match) {
  const window = sentence.slice(match.index, match.index + match[0].length + 60).toLowerCase();
  return [...SPEC_COVERAGE_QUALIFIERS].some((q) => window.includes(q));
}

/**
 * True when the matched noun is really part of a filename -- "every SKILL.md",
 * "every evals.json". A file reference is not a claim about how often the
 * bridge writes a spec.
 *
 * PRECISION fix, not an exemption: it keys off the grammatical shape (a bare
 * extension immediately following the noun), so no specific string is
 * excused, and "every skill writes a spec" -- which round-2 review requires
 * to be caught -- is untouched because "skill" there is not followed by an
 * extension.
 *
 * Deliberately case-SENSITIVE. With /i, a sentence boundary missing its space
 * ("...on every call.Codex reads it from disk") read as the extension
 * ".Codex" and the claim escaped entirely. Every real extension in this repo
 * is lowercase, so dropping /i costs nothing and shrinks the hole to a
 * lowercase-only typo.
 */
function isFilenameReference(sentence, match) {
  return /^\.[a-z0-9]+\b/.test(sentence.slice(match.index + match[0].length));
}

function codexSkillsBySpecUsage() {
  const writesSpec = [];
  const skipsSpec = [];
  for (const entry of fs.readdirSync(CODEX_SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(CODEX_SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const body = fs.readFileSync(skillMd, "utf8");
    (SPEC_BUILDER_INVOCATION.test(body) ? writesSpec : skipsSpec).push(entry.name);
  }
  return { writesSpec: writesSpec.sort(), skipsSpec: skipsSpec.sort() };
}

/** Returns the named "## " section of the README, exclusive of following sections. */
function readmeSection(heading) {
  const content = fs.readFileSync(README_PATH, "utf8");
  const start = content.indexOf(heading);
  if (start === -1) return null;
  const rest = content.slice(start + heading.length);
  const nextRel = rest.search(/\n## /);
  return nextRel === -1 ? content.slice(start) : content.slice(start, start + heading.length + nextRel);
}

/**
 * Every surface on which a spec-coverage claim could be published.
 *
 * `mustQuantify` marks the surfaces that DO make the claim today. Those must
 * still visibly make a detectable one -- if the detector stops seeing a
 * surface's claim (reworded, reformatted, or the matcher regressed), that
 * surface fails on its own rather than free-riding on another's matches.
 * Flipping a flag to false is a deliberate statement that the surface no
 * longer claims spec coverage at all; it is not a way to silence the guard.
 *
 * Round-2 review proved the previous four-surface list missed the contexthub
 * manifest, the non-codex marketplace entries, any new root page, every
 * SKILL.md, and all of the README outside one section -- injecting the prior
 * false wording into six surfaces was caught on only one.
 */
function publicSpecClaimSurfaces() {
  const surfaces = [];
  const marketplace = JSON.parse(readFile(".claude-plugin/marketplace.json"));

  // The WHOLE README, not one section: the most plausible regression is a
  // summary claim re-added to the codex bullet list near the top of the file,
  // which a single-section reader never sees.
  surfaces.push({ label: "README.md (whole file)", text: readFile("README.md"), mustQuantify: true });

  surfaces.push({
    label: ".claude-plugin/marketplace.json (metadata description)",
    text: marketplace.metadata.description,
    mustQuantify: false,
  });
  for (const entry of marketplace.plugins) {
    surfaces.push({
      label: `.claude-plugin/marketplace.json (${entry.name} entry description)`,
      text: entry.description,
      mustQuantify: entry.name === "codex",
    });
  }

  const pluginsDir = path.join(REPO_ROOT, "plugins");
  for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const manifestPath = path.join(pluginsDir, plugin.name, ".claude-plugin", "plugin.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    surfaces.push({
      label: `plugins/${plugin.name}/.claude-plugin/plugin.json (description)`,
      text: manifest.description,
      mustQuantify: plugin.name === "codex",
    });
  }

  // Same glob the stale-string corpus uses -- one definition of "the website".
  for (const name of rootHtmlPages()) {
    surfaces.push({ label: name, text: readFile(name), mustQuantify: false });
  }

  // Skill bodies that can speak to the codex bridge's spec behaviour.
  //
  // Every codex skill (round-2 review proved reason/SKILL.md was uncovered),
  // PLUS contexthub's supervise: round-3 review corrected the earlier
  // reasoning here. "Only a codex skill can claim codex spec coverage" does
  // not hold strictly -- `supervise` drives Codex directly, and README.md's
  // codex-bridge section explicitly contrasts it ("drives Codex through a
  // compact machine task graph instead of a handoff spec"). A future edit
  // asserting supervise writes a handoff spec on every call would be false,
  // so it belongs in scope. It yields zero matches today, so including it
  // costs nothing.
  //
  // converge and the agy skills stay excluded, and that exclusion is still
  // correct: neither drives Codex, so neither can speak to this claim.
  // Including them produced false positives on true prose about other
  // subsystems (converge/SKILL.md's "neither /contexthub:supervise nor any
  // Superpowers skill auto-launches Converge"). They remain fully covered by
  // the stale-string corpus scan above; only this narrow spec-coverage
  // question excludes them, because they cannot answer it.
  const SPEC_CLAIM_SKILL_FILES = [
    ...walkFiles(CODEX_SKILLS_DIR).filter((f) => path.basename(f) === "SKILL.md"),
    path.join(REPO_ROOT, "plugins", "contexthub", "skills", "supervise", "SKILL.md"),
  ];
  for (const f of SPEC_CLAIM_SKILL_FILES) {
    assert.ok(fs.existsSync(f), `expected spec-claim surface to exist: ${path.relative(REPO_ROOT, f)}`);
    surfaces.push({
      label: path.relative(REPO_ROOT, f),
      text: fs.readFileSync(f, "utf8"),
      mustQuantify: false,
    });
  }

  return surfaces;
}

test("the spec-builder discriminator genuinely separates codex skills (non-vacuous)", () => {
  const { writesSpec, skipsSpec } = codexSkillsBySpecUsage();
  assert.ok(writesSpec.length > 0, "expected at least one codex skill to actually invoke spec-builder.mjs");
  assert.ok(skipsSpec.length > 0, "expected at least one codex skill to skip spec-builder.mjs");
  assert.ok(writesSpec.includes("reason"), `"reason" demonstrably builds a spec; got writesSpec=${writesSpec}`);
  assert.ok(
    skipsSpec.includes("exec"),
    `"exec" explicitly says not to run spec-builder.mjs, so it must be classified as skipping; got skipsSpec=${skipsSpec}`
  );
  assert.ok(
    skipsSpec.includes("resume"),
    `"resume" never references spec-builder.mjs, so it must be classified as skipping; got skipsSpec=${skipsSpec}`
  );
});

/**
 * Counts recognized universality claims in a surface's text and asserts each
 * one is qualified. Returns the number of claims SEEN (qualified or not), so
 * the caller can assert per-surface coverage.
 */
function auditSpecCoverageClaims(label, text, onViolation) {
  const sentences = normalizeMarkdown(delimitFencedLines(text)).split(/(?<=[.!?])\s+/);
  let seen = 0;

  for (let i = 0; i < sentences.length; i++) {
    // Scope window = this sentence PLUS its predecessor. A claim split across
    // two sentences ("A 5-section handoff spec is produced. It is written on
    // every call.") previously dodged the scope check entirely, because the
    // sentence carrying the universal contained no spec/handoff token.
    const scope = `${i > 0 ? sentences[i - 1] : ""} ${sentences[i]}`;
    if (!/\b(?:spec|handoff)\b/i.test(scope)) continue;

    const sentence = sentences[i];
    for (const pattern of UNIVERSAL_CLAIM_PATTERNS) {
      // Fresh regex per use: the module-level patterns carry /g, and sharing
      // lastIndex across surfaces would silently skip matches.
      for (const match of sentence.matchAll(new RegExp(pattern.source, pattern.flags))) {
        if (isFilenameReference(sentence, match)) continue;
        seen++;
        if (!isQualifiedClaim(sentence, match)) {
          onViolation(match, sentence);
        }
      }
    }
  }
  return seen;
}

test("no public surface claims the 5-section spec covers EVERY delegation while some codex skills skip it", () => {
  const { skipsSpec } = codexSkillsBySpecUsage();
  assert.ok(
    skipsSpec.length > 0,
    "premise: some codex skills must skip the spec, otherwise a universal claim would be TRUE and this " +
      "guard would be asserting the wrong thing entirely"
  );

  const coverage = [];

  for (const { label, text, mustQuantify } of publicSpecClaimSurfaces()) {
    assert.ok(typeof text === "string" && text.length > 0, `${label}: expected readable, non-empty text`);
    const seen = auditSpecCoverageClaims(label, text, (match, sentence) => {
      assert.fail(
        `${label} claims the 5-section spec is written for "${match[0].trim()}", but these codex skills ` +
          `skip it entirely: ${skipsSpec.join(", ")}. Qualify the claim (e.g. "every structured delegation") ` +
          `so the surface does not contradict the skills it documents.\n  Sentence: ${sentence.trim().slice(0, 220)}`
      );
    });
    coverage.push({ label, seen, mustQuantify });
  }

  // PER-SURFACE coverage. A surface that is supposed to carry the claim must
  // still visibly carry a *detectable* one. This is the assertion that would
  // have caught the round-1 regression, where markdown emphasis made the
  // README invisible while two manifests kept the global counter positive.
  const dark = coverage.filter((c) => c.mustQuantify && c.seen === 0).map((c) => c.label);
  assert.deepEqual(
    dark,
    [],
    `these surfaces are expected to carry a spec-coverage claim but the detector found ZERO on them: ` +
      `${dark.join(", ")}.\nEither the claim was reworded/reformatted into a shape the matcher no longer ` +
      `recognizes (fix the matcher -- the guard is inert on that surface until you do), or the surface ` +
      `genuinely stopped claiming spec coverage (then set mustQuantify:false deliberately).\n` +
      `Per-surface counts: ${coverage.map((c) => `${c.label}=${c.seen}`).join(", ")}`
  );
});

test("the spec-coverage matcher sees through markdown emphasis, code spans, and line wrapping", () => {
  // Round-1 regression, pinned: each of these is a FALSE universal that the
  // pre-normalization matcher could not see, so the guard silently passed.
  const disguised = [
    "The bridge writes a handoff spec for every **single** delegation.",
    "The bridge writes a handoff spec for every _single_ delegation.",
    "The bridge writes a handoff spec for every `single` delegation.",
    "The bridge writes a handoff spec for every\nsingle\ndelegation.",
    "The bridge writes a **handoff spec** on **any call**.",
    "The bridge **always writes** a handoff spec.",
  ];
  for (const text of disguised) {
    let violations = 0;
    auditSpecCoverageClaims("fixture", text, () => violations++);
    assert.ok(
      violations > 0,
      `formatting must not hide a false universal, but this passed undetected: ${JSON.stringify(text)}`
    );
  }

  // And the legitimate qualified form must still pass, including when the
  // qualifier itself is emphasized and line-wrapped (this is the live README
  // shape).
  const legitimate = [
    "The bridge writes a handoff spec for every **structured**\ndelegation.",
    "The bridge **always writes** a **structured** handoff spec.",
  ];
  for (const text of legitimate) {
    let violations = 0;
    auditSpecCoverageClaims("fixture", text, () => violations++);
    assert.equal(violations, 0, `qualified claim must not be flagged: ${JSON.stringify(text)}`);
  }
});

test("a claim written INSIDE a fenced block is still scanned (fences are not exempt)", () => {
  // Round-3 finding: stripping fenced blocks exempted them wholesale, but
  // this README's fences carry product prose, so a claim written in a fence
  // escaped entirely. Fenced content is now scanned line by line.
  const fencedClaims = [
    "Intro prose.\n\n```\n# the handoff spec is written on every call\n```\n",
    "Intro prose.\n\n```\nThe handoff spec is written on every call.\n```\n",
    "Intro.\n\n```bash\n# handoff spec written for any invocation\n```\n",
  ];
  for (const text of fencedClaims) {
    let violations = 0;
    auditSpecCoverageClaims("fixture", text, () => violations++);
    assert.ok(violations > 0, `a claim inside a fence must still be caught: ${JSON.stringify(text)}`);
  }

  // ...while a LISTING row must not borrow spec-scope from a distant row.
  // This is the exact `## Layout` shape that a naive fence-as-prose reading
  // tripped on: the spec mention is many rows above the "every skill" row.
  const listing = [
    "```",
    "plugins/",
    "└── codex/",
    "    └── scripts/",
    "        └── spec-builder.mjs     # writes the 5-section spec",
    "tools/",
    "└── eval-check.mjs               # evals.json structural validator",
    "quality-bar.md                   # the gates every skill must clear",
    "```",
  ].join("\n");
  let listingViolations = 0;
  auditSpecCoverageClaims("fixture", listing, () => listingViolations++);
  assert.equal(
    listingViolations,
    0,
    "a listing row must not borrow sentence-scope from a spec mention rows above it"
  );
});

test("isFilenameReference is case-sensitive, so a missing space after a period cannot disguise a claim", () => {
  // Round-3 finding: with /i, ".Codex" read as a file extension and the claim
  // escaped. Both spacings must now be caught.
  for (const text of [
    "The handoff spec is written on every call.Codex reads it from disk.",
    "The handoff spec is written on every call. Codex reads it from disk.",
  ]) {
    let violations = 0;
    auditSpecCoverageClaims("fixture", text, () => violations++);
    assert.ok(violations > 0, `sentence spacing must not change the verdict: ${JSON.stringify(text)}`);
  }

  // Genuine lowercase filename references must still be skipped.
  for (const text of [
    "The suite gates every SKILL.md against the handoff spec rules.",
    "It validates every evals.json next to the handoff spec.",
  ]) {
    let violations = 0;
    auditSpecCoverageClaims("fixture", text, () => violations++);
    assert.equal(violations, 0, `genuine filename reference must be skipped: ${JSON.stringify(text)}`);
  }
});

test("contexthub supervise is in scope for the spec-coverage claim, and is clean today", () => {
  // supervise drives Codex, so it CAN make a spec-coverage claim -- the
  // README explicitly contrasts it against the handoff spec. Round-3 review
  // corrected an earlier over-narrow scoping that excluded it.
  const labels = publicSpecClaimSurfaces().map((s) => s.label);
  assert.ok(
    labels.includes(path.join("plugins", "contexthub", "skills", "supervise", "SKILL.md")),
    `supervise/SKILL.md must be a spec-claim surface; surfaces were: ${labels.join(", ")}`
  );

  const text = readFile("plugins/contexthub/skills/supervise/SKILL.md");
  let violations = 0;
  const seen = auditSpecCoverageClaims("supervise", text, () => violations++);
  assert.equal(violations, 0, "supervise/SKILL.md must not over-claim spec coverage");
  assert.equal(seen, 0, "adding supervise/SKILL.md must introduce no new matches (it costs nothing today)");
});

test("the spec-coverage scope window spans a sentence and its predecessor", () => {
  // Round-2 finding: the universal lived in a sentence with no spec/handoff
  // token, so the scope check skipped it even though the preceding sentence
  // established the subject.
  const split = "A 5-section handoff spec is produced. It is written on every call.";
  let violations = 0;
  auditSpecCoverageClaims("fixture", split, () => violations++);
  assert.ok(violations > 0, `a claim split across two sentences must still be in scope: ${JSON.stringify(split)}`);

  // Scope is still bounded -- an unrelated universal far from any spec
  // sentence must not be dragged in.
  const unrelated = "The handoff spec lives on disk. Unrelated prose here. We run every test on each commit.";
  let unrelatedViolations = 0;
  auditSpecCoverageClaims("fixture", unrelated, () => unrelatedViolations++);
  assert.equal(unrelatedViolations, 0, "scope must not extend beyond the immediately preceding sentence");
});

test("the codex-bridge README section discloses that constraint/output-format defaults are packaged until /codex:setup is run", () => {
  const section = readmeSection("## How the codex bridge works");
  assert.ok(section, "README must have a '## How the codex bridge works' section");
  assert.ok(
    /reference\/defaults|packaged default/i.test(section),
    "Since /codex:setup is optional and non-automatic, skills reference the packaged defaults under " +
      "${CLAUDE_PLUGIN_ROOT}/reference/defaults/ until a user opts in. The section must say so rather than " +
      "describing constraints/output formats as unconditionally 'your repo's' files."
  );
});

test("walkFiles selects by binary-denylist, not by an inclusion allowlist -- a new text format is scanned by default", () => {
  // Isolated temp dir: proves the property directly without touching the repo.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-ref-walk-"));
  try {
    for (const name of ["note.txt", "page.html", "conf.yaml", "doc.md", "code.mjs", "data.json", "vector.svg"]) {
      fs.writeFileSync(path.join(tmp, name), "placeholder", "utf8");
    }
    fs.writeFileSync(path.join(tmp, "image.png"), "binary-placeholder", "utf8");
    fs.mkdirSync(path.join(tmp, "nested"));
    fs.writeFileSync(path.join(tmp, "nested", "deep.txt"), "placeholder", "utf8");

    const found = walkFiles(tmp)
      .map((f) => path.relative(tmp, f))
      .sort();
    assert.deepEqual(
      found,
      ["code.mjs", "conf.yaml", "data.json", "doc.md", path.join("nested", "deep.txt"), "note.txt", "page.html", "vector.svg"].sort(),
      "walkFiles must return every non-binary file (including .txt/.html/.yaml/.svg and nested ones) and skip binaries"
    );
    assert.ok(!found.includes("image.png"), "binary files must be skipped");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the website corpus is every top-level .html page, globbed rather than hardcoded", () => {
  const rootHtml = fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".html"))
    .map((e) => e.name);
  assert.ok(rootHtml.includes("index.html"), "sanity: index.html must exist at the repo root");
  const scanned = new Set(scanCorpus().map((f) => path.relative(REPO_ROOT, f)));
  for (const name of rootHtml) {
    assert.ok(
      scanned.has(name),
      `top-level page "${name}" must be in the scanned corpus -- the website corpus must be globbed, ` +
        `not a hardcoded filename, so a second page cannot publish stale claims unscanned`
    );
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
