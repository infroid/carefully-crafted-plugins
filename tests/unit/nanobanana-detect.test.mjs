// Unit tests for plugins/agy/scripts/nanobanana-detect.mjs
// Run with: node --test tests/unit/nanobanana-detect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "agy", "scripts", "nanobanana-detect.mjs");
const { detect } = await import(SCRIPT);

function fakeBinDir(names, { exit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-bins-"));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexit ${exit}\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

// Build a fake gemini extensions dir; optionally with the built MCP server.
function fakeExtDir({ built = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-ext-"));
  const serverDir = path.join(dir, "nanobanana", "mcp-server", "dist");
  if (built) {
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "index.js"), "// fake\n");
  } else {
    fs.mkdirSync(path.join(dir, "nanobanana"), { recursive: true });
  }
  return dir;
}

test("everything present + key + built server => backend mcp", () => {
  const bins = fakeBinDir(["gemini", "agy", "node"]);
  const ext = fakeExtDir({ built: true });
  try {
    const r = detect({ env: { PATH: bins, NANOBANANA_API_KEY: "k", GEMINI_EXTENSIONS_DIR: ext } });
    assert.equal(r.gemini, true);
    assert.equal(r.extensionInstalled, true);
    assert.equal(r.mcpServerBuilt, true);
    assert.equal(r.apiKey, true);
    assert.equal(r.mcpReady, true);
    assert.equal(r.backend, "mcp");
    assert.ok(r.serverPath.endsWith("/mcp-server/dist/index.js"));
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("agy only, no extension => backend agy (fallback)", () => {
  const bins = fakeBinDir(["agy"]);
  const ext = fakeExtDir({ built: false });
  try {
    const r = detect({ env: { PATH: bins, GEMINI_EXTENSIONS_DIR: ext } });
    assert.equal(r.agyReady, true);
    assert.equal(r.mcpReady, false);
    assert.equal(r.backend, "agy");
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("extension installed but not built => mcpServerBuilt false, serverPath null", () => {
  const bins = fakeBinDir(["gemini", "agy"]);
  const ext = fakeExtDir({ built: false });
  try {
    const r = detect({ env: { PATH: bins, NANOBANANA_API_KEY: "k", GEMINI_EXTENSIONS_DIR: ext } });
    assert.equal(r.extensionInstalled, true);
    assert.equal(r.mcpServerBuilt, false);
    assert.equal(r.serverPath, null);
    assert.equal(r.mcpReady, false);
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("built server but key unset => not mcpReady", () => {
  const bins = fakeBinDir(["gemini"]);
  const ext = fakeExtDir({ built: true });
  try {
    const r = detect({ env: { PATH: bins, GEMINI_EXTENSIONS_DIR: ext } });
    assert.equal(r.mcpServerBuilt, true);
    assert.equal(r.apiKey, false);
    assert.equal(r.mcpReady, false);
    assert.equal(r.backend, "none");
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("nothing present => backend none", () => {
  const bins = fakeBinDir([]);
  const ext = fakeExtDir({ built: false });
  try {
    const r = detect({ env: { PATH: bins, GEMINI_EXTENSIONS_DIR: ext } });
    assert.equal(r.backend, "none");
    assert.equal(r.agyReady, false);
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("whitespace-only API key counts as unset", () => {
  const bins = fakeBinDir(["gemini"]);
  const ext = fakeExtDir({ built: true });
  try {
    const r = detect({ env: { PATH: bins, NANOBANANA_API_KEY: "   ", GEMINI_EXTENSIONS_DIR: ext } });
    assert.equal(r.apiKey, false);
  } finally {
    fs.rmSync(bins, { recursive: true, force: true });
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test("CLI prints valid JSON and exits 0", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout);
  assert.equal(typeof obj.backend, "string");
  assert.equal(typeof obj.mcpReady, "boolean");
});
