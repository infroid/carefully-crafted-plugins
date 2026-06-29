// Unit tests for the --collect artifact-retrieval feature of
// plugins/agy/scripts/agy-invoke.mjs (parseArtifacts/collectArtifacts + CLI).
// Run with: node --test tests/unit/agy-collect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "agy", "scripts", "agy-invoke.mjs");
const { parseArtifacts, collectArtifacts } = await import(SCRIPT);

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

test("parseArtifacts finds file:// links and bare media paths, dedups, drops missing", () => {
  const dir = tmp("agyc-");
  try {
    const img = path.join(dir, "apple.png");
    fs.writeFileSync(img, "x");
    const out = `Saved [apple.png](file://${img}). Also at ${img}. Missing: /nope/x.png and notmedia ${dir}/readme`;
    const got = parseArtifacts(out);
    assert.deepEqual(got, [img]); // deduped to the one existing file
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArtifacts decodes percent-encoded file URIs", () => {
  const dir = tmp("agyc-sp-");
  try {
    const img = path.join(dir, "my apple.png");
    fs.writeFileSync(img, "x");
    const out = `[x](file://${dir}/my%20apple.png)`;
    assert.deepEqual(parseArtifacts(out), [img]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectArtifacts copies into destDir and avoids clobbering distinct files", () => {
  const src = tmp("agyc-src-");
  const dest = tmp("agyc-dst-");
  try {
    const a = path.join(src, "img.png");
    fs.writeFileSync(a, "A");
    // pre-existing different file with same basename in dest
    fs.writeFileSync(path.join(dest, "img.png"), "PRE");
    const written = collectArtifacts(`file://${a}`, dest);
    assert.equal(written.length, 1);
    assert.equal(path.basename(written[0]), "img-1.png"); // suffixed, didn't clobber
    assert.equal(fs.readFileSync(path.join(dest, "img.png"), "utf8"), "PRE");
    assert.equal(fs.readFileSync(written[0], "utf8"), "A");
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("collectArtifacts returns [] when nothing is found", () => {
  assert.deepEqual(collectArtifacts("no paths here", tmp("agyc-none-")), []);
});

// ---- end-to-end via fake agy + the --collect CLI flag ----

const FAKE_AGY = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("agy fake\\n"); process.exit(0); }
const art = process.env.FAKE_AGY_ARTIFACT;
writeFileSync(art, "PNGDATA");
process.stdout.write(\`Done. Saved [out.png](file://\${art}).\\n\`);
process.exit(0);
`;

test("--collect copies the agy-produced artifact into the target dir", () => {
  const dir = tmp("agyc-e2e-");
  try {
    const fakeAgy = path.join(dir, "fake-agy.mjs");
    fs.writeFileSync(fakeAgy, FAKE_AGY);
    fs.chmodSync(fakeAgy, 0o755);
    // Simulate agy's sandbox: it writes out.png there and reports a file:// link.
    const sandboxDir = path.join(dir, "scratch");
    fs.mkdirSync(sandboxDir, { recursive: true });
    const sandbox = path.join(sandboxDir, "out.png");
    const collectDir = path.join(dir, "images");
    const res = spawnSync(process.execPath, [SCRIPT, "--prompt", "make an apple", "--collect", collectDir], {
      encoding: "utf8",
      env: { ...process.env, AGY_BIN: fakeAgy, FAKE_AGY_ARTIFACT: sandbox },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /collected: .*out\.png/);
    assert.ok(fs.existsSync(path.join(collectDir, "out.png")), "artifact should be copied into the collect dir");
    assert.equal(fs.readFileSync(path.join(collectDir, "out.png"), "utf8"), "PNGDATA");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
