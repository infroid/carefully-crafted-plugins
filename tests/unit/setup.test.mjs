// Unit tests for plugins/codex/scripts/setup.mjs (explicit-only setup)
// Run with: node --test tests/unit/setup.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(fileURLToPath(import.meta.url), "../../../plugins/codex/scripts/setup.mjs");
const CODEX_ROOT = resolve(fileURLToPath(import.meta.url), "../../../plugins/codex");
const DEFAULTS_ROOT = join(CODEX_ROOT, "reference/defaults");
const SKILLS_ROOT = join(CODEX_ROOT, "skills");
const RETAINED_SKILLS = ["exec", "imagegen", "reason", "resume", "review", "setup"];

function run(args, cwd) {
  return spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function listFilesRecursive(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      results.push(relative(DEFAULTS_ROOT, full));
    }
  }
  return results;
}

test("no-arg setup copies every packaged default into the matching project path", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-copy-test-"));
  try {
    const defaultFiles = listFilesRecursive(DEFAULTS_ROOT);
    assert.ok(defaultFiles.length >= 8, "expected at least 8 packaged default files");

    const res = run([], dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    for (const rel of defaultFiles) {
      const projectPath = join(dir, "docs/carefully-crafted-plugins", rel);
      assert.ok(existsSync(projectPath), `expected ${rel} to be copied to ${projectPath}`);
      const expected = readFileSync(join(DEFAULTS_ROOT, rel), "utf8");
      const actual = readFileSync(projectPath, "utf8");
      assert.equal(actual, expected, `copied content for ${rel} should match the packaged default verbatim`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing project files are never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-no-overwrite-test-"));
  try {
    const constraintsDir = join(dir, "docs/carefully-crafted-plugins/constraints");
    mkdirSync(constraintsDir, { recursive: true });
    writeFileSync(join(constraintsDir, "code-style.md"), "# custom project standards\ncustomized.\n", "utf8");

    const res = run([], dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    const body = readFileSync(join(constraintsDir, "code-style.md"), "utf8");
    assert.equal(body, "# custom project standards\ncustomized.\n");
    assert.match(res.stdout, /skipped/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only handoffs/ and output/ are appended to .gitignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-gitignore-test-"));
  try {
    const res = run([], dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /docs\/carefully-crafted-plugins\/handoffs\//);
    assert.match(gitignore, /docs\/carefully-crafted-plugins\/output\//);
    assert.doesNotMatch(gitignore, /triage\//);
    assert.doesNotMatch(gitignore, /lifecycle\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ensure exits 2 with an explicit removal message", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-ensure-removed-test-"));
  try {
    const res = run(["--ensure"], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout + res.stderr, /automatic setup was removed/i);
    assert.equal(existsSync(join(dir, "docs")), false, "--ensure must not scaffold anything");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit (no-arg) setup still prints the full summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "setup-explicit-test-"));
  try {
    const res = run([], dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /=== \/codex:setup ===/);
    assert.match(res.stdout, /Next steps:/);
    assert.ok(existsSync(join(dir, "docs/carefully-crafted-plugins/constraints")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no retained Codex skill contains 'setup.mjs --ensure'", () => {
  for (const skill of RETAINED_SKILLS) {
    const skillMd = join(SKILLS_ROOT, skill, "SKILL.md");
    assert.ok(existsSync(skillMd), `expected ${skillMd} to exist`);
    const body = readFileSync(skillMd, "utf8");
    assert.doesNotMatch(
      body,
      /setup\.mjs --ensure/,
      `${skill}/SKILL.md must not reference setup.mjs --ensure`,
    );
  }
});

test("no SessionStart hook remains for the codex plugin", () => {
  const hooksPath = join(CODEX_ROOT, "hooks/hooks.json");
  assert.equal(existsSync(hooksPath), false, "expected plugins/codex/hooks/hooks.json to be deleted");
});
