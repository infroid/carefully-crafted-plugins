// Locks the Superpowers dependency contract: contexthub requires the
// upstream Superpowers plugin (unversioned, cross-marketplace) but does
// NOT pull in the optional public codex bridge plugin. Dependencies live
// in the plugin manifest only -- the marketplace entry stays clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MARKETPLACE_PATH = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const CONTEXTHUB_MANIFEST_PATH = path.join(REPO_ROOT, "plugins", "contexthub", ".claude-plugin", "plugin.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("marketplace root allows cross-marketplace dependencies on the official marketplace only", () => {
  const marketplace = readJson(MARKETPLACE_PATH);
  assert.deepEqual(marketplace.allowCrossMarketplaceDependenciesOn, ["claude-plugins-official"]);
});

test("contexthub declares exactly one unversioned dependency on upstream Superpowers", () => {
  const contexthub = readJson(CONTEXTHUB_MANIFEST_PATH);
  assert.deepEqual(contexthub.dependencies, [
    { name: "superpowers", marketplace: "claude-plugins-official" },
  ]);
  assert.equal("version" in contexthub.dependencies[0], false);
});

test("contexthub does not depend on the public codex bridge plugin", () => {
  const contexthub = readJson(CONTEXTHUB_MANIFEST_PATH);
  // Mandated verbatim by the plan. Note it is vacuous against the real
  // manifest shape: .includes on an array of objects can never match the
  // bare string "codex". The .some() assertion below is the load-bearing one.
  assert.equal(contexthub.dependencies.includes("codex"), false);
  assert.equal(
    contexthub.dependencies.some((d) => (typeof d === "string" ? d : d.name) === "codex"),
    false
  );
});

test("dependencies are declared in the plugin manifest only, never duplicated into the marketplace entry", () => {
  const marketplace = readJson(MARKETPLACE_PATH);
  for (const entry of marketplace.plugins) {
    assert.equal(
      "dependencies" in entry,
      false,
      `marketplace entry for "${entry.name}" must not carry a dependencies field -- dependencies belong in the plugin manifest only`
    );
  }
});

// ---------------------------------------------------------------------------
// Dependency-resolution failure contract.
//
// Task 6 ships no runtime dependency-resolution code -- Claude Code's own
// installer emits the real diagnostic when it cannot resolve contexthub's
// required "superpowers" plugin. What this repo owns is the *policy* that
// governs how we are allowed to describe that failure, documented in
// quality-bar.md under "### Dependency-resolution failure contract".
//
// These tests read that section from disk so they fail when the policy is
// deleted or weakened -- they are not self-referential. The later,
// separately-authorized clean-install smoke test checks live CLI output
// against the same three properties.
// ---------------------------------------------------------------------------

const QUALITY_BAR_PATH = path.join(REPO_ROOT, "quality-bar.md");
const CONTRACT_HEADING = "### Dependency-resolution failure contract";
const PROHIBITION_MARKER = "never suggest bypassing dependency enforcement";

// Phrases we must never offer as a remedy. They legitimately appear inside
// the policy's own prohibition list, so the negative assertion below checks
// the surrounding prose rather than the prohibition block itself.
const FORBIDDEN_BYPASS_PHRASES = [
  "disable dependency enforcement",
  "bypass",
  "skip validation",
  "--no-verify",
  "remove the dependency",
  "ignore the failure",
  "install anyway",
];

/** Returns the text of the failure-contract subsection, exclusive of its heading. */
function readFailureContractSection() {
  const doc = fs.readFileSync(QUALITY_BAR_PATH, "utf8");
  const start = doc.indexOf(CONTRACT_HEADING);
  assert.notEqual(
    start,
    -1,
    `quality-bar.md must document the dependency-resolution failure contract under "${CONTRACT_HEADING}"`
  );
  const body = doc.slice(start + CONTRACT_HEADING.length);
  // The section ends at the next heading of any level.
  const end = body.search(/^#{1,6} /m);
  return (end === -1 ? body : body.slice(0, end)).trim();
}

/** Blocks of the section that are NOT the prohibition list. */
function nonProhibitionBlocks(section) {
  return section
    .split(/\n\s*\n/)
    .filter((block) => !block.toLowerCase().includes(PROHIBITION_MARKER));
}

test("quality-bar.md documents the dependency-resolution failure contract", () => {
  const section = readFailureContractSection();
  assert.ok(section.length > 0, "the failure-contract section must not be empty");
});

test("the documented failure contract requires naming the official marketplace", () => {
  const section = readFailureContractSection();
  assert.ok(
    section.includes("claude-plugins-official"),
    "the failure contract must require diagnostics to name claude-plugins-official"
  );
});

test("the documented failure contract requires raising organization policy as a cause", () => {
  const section = readFailureContractSection();
  assert.ok(
    section.toLowerCase().includes("organization policy"),
    "the failure contract must require diagnostics to raise organization policy as a possible cause"
  );
});

test("the documented failure contract explicitly forbids bypassing dependency enforcement", () => {
  const section = readFailureContractSection();
  assert.ok(
    section.toLowerCase().includes(PROHIBITION_MARKER),
    `the failure contract must state that we "${PROHIBITION_MARKER}"`
  );
  // Every phrase we refuse to recommend must still be named in the
  // prohibition list, so quietly dropping one from the list fails here.
  const prohibitionBlock = section
    .split(/\n\s*\n/)
    .find((block) => block.toLowerCase().includes(PROHIBITION_MARKER));
  for (const phrase of FORBIDDEN_BYPASS_PHRASES) {
    assert.ok(
      prohibitionBlock.toLowerCase().includes(phrase),
      `the prohibition list must still name "${phrase}" as something we never suggest`
    );
  }
});

test("the failure contract never offers a bypass as a remedy outside its prohibition list", () => {
  const section = readFailureContractSection();
  for (const block of nonProhibitionBlocks(section)) {
    for (const phrase of FORBIDDEN_BYPASS_PHRASES) {
      assert.equal(
        block.toLowerCase().includes(phrase),
        false,
        `the failure contract must not offer "${phrase}" as a remedy; found in: ${block.slice(0, 120)}`
      );
    }
  }
});
