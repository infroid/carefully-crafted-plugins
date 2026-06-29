// Unit tests for plugins/agy/scripts/nanobanana-setup.mjs
// Run with: node --test tests/unit/nanobanana-setup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "agy", "scripts", "nanobanana-setup.mjs");
const { serverEntry, mergeMcpConfig, addCommand, status } = await import(SCRIPT);

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function fakeBinDir(names) {
  const dir = tmp("nbset-bin-");
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexit 0\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}
function fakeBuiltExt() {
  const dir = tmp("nbset-ext-");
  const d = path.join(dir, "nanobanana", "mcp-server", "dist");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "index.js"), "// fake\n");
  return dir;
}
function runCli(args, env, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env: { PATH: "", ...env },
  });
}

// ---- pure helpers ----

test("serverEntry references the key via env expansion, never a literal", () => {
  const e = serverEntry("/abs/dist/index.js");
  assert.equal(e.command, "node");
  assert.deepEqual(e.args, ["/abs/dist/index.js"]);
  assert.equal(e.env.NANOBANANA_API_KEY, "${NANOBANANA_API_KEY}");
  assert.match(e.env.NANOBANANA_MODEL, /^\$\{NANOBANANA_MODEL:-gemini-3\.1-flash-image-preview\}$/);
});

test("mergeMcpConfig preserves other servers and reports changed", () => {
  const existing = { mcpServers: { other: { command: "x" } }, someTopLevel: 1 };
  const { config, changed } = mergeMcpConfig(existing, "/abs/dist/index.js");
  assert.equal(changed, true);
  assert.deepEqual(config.mcpServers.other, { command: "x" });
  assert.equal(config.someTopLevel, 1);
  assert.equal(config.mcpServers.nanobanana.args[0], "/abs/dist/index.js");
});

test("mergeMcpConfig is idempotent (no change on identical re-wire)", () => {
  const first = mergeMcpConfig({}, "/abs/dist/index.js").config;
  const { changed } = mergeMcpConfig(first, "/abs/dist/index.js");
  assert.equal(changed, false);
});

test("addCommand single-quotes the env expansion so the shell keeps ${...}", () => {
  const cmd = addCommand("user", "/abs/dist/index.js");
  assert.match(cmd, /--scope user/);
  assert.match(cmd, /--env NANOBANANA_API_KEY='\$\{NANOBANANA_API_KEY\}'/);
  assert.match(cmd, /-- node '\/abs\/dist\/index\.js'$/); // serverPath single-quoted (handles spaces)
});

test("status nextSteps guide install + key when nothing present", () => {
  const bins = fakeBinDir([]);
  try {
    const s = status({ cwd: tmp("nbset-proj-"), env: { PATH: bins }, home: tmp("nbset-home-") });
    const joined = s.nextSteps.join(" | ");
    assert.match(joined, /install-extension|Install the Gemini CLI/);
    assert.match(joined, /NANOBANANA_API_KEY/);
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
  }
});

// ---- CLI ----

test("--status --json emits valid JSON with backend + nextSteps", () => {
  const res = runCli(["--status", "--json"], {}, REPO_ROOT);
  assert.equal(res.status, 0, res.stderr);
  const obj = JSON.parse(res.stdout);
  assert.equal(typeof obj.backend, "string");
  assert.ok(Array.isArray(obj.nextSteps));
});

test("--wire --scope project merges .mcp.json and writes NO literal key", () => {
  const ext = fakeBuiltExt();
  const proj = tmp("nbset-proj-");
  fs.writeFileSync(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  try {
    const res = runCli(
      ["--wire", "--scope", "project", "--cwd", proj],
      { GEMINI_EXTENSIONS_DIR: ext, NANOBANANA_API_KEY: "super-secret-key" },
      proj
    );
    assert.equal(res.status, 0, res.stderr);
    const written = fs.readFileSync(path.join(proj, ".mcp.json"), "utf8");
    assert.match(written, /"nanobanana"/);
    assert.match(written, /\$\{NANOBANANA_API_KEY\}/);
    assert.ok(!written.includes("super-secret-key"), "the real key must never be written to disk");
    assert.match(written, /"other"/); // preserved
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("--wire --scope user prints claude mcp add and writes no file", () => {
  const ext = fakeBuiltExt();
  const proj = tmp("nbset-proj-");
  try {
    const res = runCli(
      ["--wire", "--scope", "user", "--cwd", proj],
      { GEMINI_EXTENSIONS_DIR: ext, NANOBANANA_API_KEY: "k" },
      proj
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /claude mcp add nanobanana --scope user/);
    assert.equal(fs.existsSync(path.join(proj, ".mcp.json")), false);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("--wire fails clearly when the server is not built", () => {
  const ext = tmp("nbset-ext-empty-");
  const proj = tmp("nbset-proj-");
  try {
    const res = runCli(
      ["--wire", "--scope", "project", "--cwd", proj],
      { GEMINI_EXTENSIONS_DIR: ext, NANOBANANA_API_KEY: "k" },
      proj
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not built/);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("--install-extension --dry-run prints the gemini command and does not run it", () => {
  const bins = fakeBinDir(["gemini"]);
  try {
    const res = runCli(["--install-extension", "--dry-run"], { PATH: bins }, REPO_ROOT);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[dry-run\] would run: gemini extensions install/);
    assert.match(res.stdout, /--skip-settings/); // must be non-interactive (no API-key prompt hang)
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
  }
});

test("--install-extension without gemini errors out", () => {
  const bins = fakeBinDir([]); // no gemini
  try {
    const res = runCli(["--install-extension"], { PATH: bins }, REPO_ROOT);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /gemini CLI not found/);
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
  }
});

test("--wire rejects an invalid scope", () => {
  const res = runCli(["--wire", "--scope", "bogus"], {}, REPO_ROOT);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /scope must be project\|user\|local/);
});

test("--build errors clearly when the extension is not installed", () => {
  const ext = tmp("nbset-ext-none-"); // empty: no nanobanana/mcp-server
  try {
    const res = runCli(["--build"], { GEMINI_EXTENSIONS_DIR: ext }, REPO_ROOT);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Run --install-extension first/);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("--build is a no-op when dist/index.js already exists", () => {
  const ext = fakeBuiltExt();
  try {
    const res = runCli(["--build"], { GEMINI_EXTENSIONS_DIR: ext }, REPO_ROOT);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /already built/);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("--build --dry-run prints the npm install it would run (extension present, unbuilt)", () => {
  const ext = tmp("nbset-ext-unbuilt-");
  fs.mkdirSync(path.join(ext, "nanobanana", "mcp-server"), { recursive: true }); // no dist/
  try {
    const res = runCli(["--build", "--dry-run"], { GEMINI_EXTENSIONS_DIR: ext }, REPO_ROOT);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[dry-run\] would run: npm install/);
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});
