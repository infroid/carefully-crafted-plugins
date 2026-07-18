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

// Task 6 does not add runtime dependency-resolution code -- Claude Code's
// own plugin installer produces this diagnostic when it cannot resolve
// contexthub's required "superpowers" dependency from the official
// marketplace. This fixture is the documented, maintainer-facing text for
// that failure mode (surfaced in release notes / support guidance); the
// test pins its wording so a future edit can't quietly regress it into a
// suggestion to bypass dependency enforcement. The clean-install smoke
// test (a later, separately-authorized task) exercises the live CLI
// output against this same contract.
const MARKETPLACE_UNAVAILABLE_DIAGNOSTIC_FIXTURE =
  "contexthub requires the \"superpowers\" plugin from the \"claude-plugins-official\" " +
  "marketplace, but that marketplace could not be reached or is blocked. This is often " +
  "caused by organization policy restricting marketplace access. Ask your Claude Code " +
  "administrator to allow \"claude-plugins-official\", or run it from a network/account " +
  "where that marketplace is reachable. contexthub will not install or activate without " +
  "this dependency.";

const FORBIDDEN_BYPASS_PHRASES = [
  "disable dependency enforcement",
  "bypass",
  "skip validation",
  "--no-verify",
  "remove the dependency",
  "ignore the failure",
  "install anyway",
];

test("the blocked/unavailable-marketplace diagnostic names the marketplace by identifier", () => {
  assert.ok(
    MARKETPLACE_UNAVAILABLE_DIAGNOSTIC_FIXTURE.includes("claude-plugins-official"),
    "diagnostic must name the official marketplace"
  );
});

test("the blocked/unavailable-marketplace diagnostic raises organization policy as a likely cause", () => {
  assert.ok(
    MARKETPLACE_UNAVAILABLE_DIAGNOSTIC_FIXTURE.toLowerCase().includes("organization policy"),
    "diagnostic must mention organization policy as a possible cause"
  );
});

test("the blocked/unavailable-marketplace diagnostic never suggests bypassing dependency enforcement", () => {
  const lower = MARKETPLACE_UNAVAILABLE_DIAGNOSTIC_FIXTURE.toLowerCase();
  for (const phrase of FORBIDDEN_BYPASS_PHRASES) {
    assert.equal(
      lower.includes(phrase),
      false,
      `diagnostic must not suggest "${phrase}"`
    );
  }
});
