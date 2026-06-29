#!/usr/bin/env node
// Detect which Nano Banana image backend is usable from this machine.
// Read-only, fast, no network. Mirrors contexthub/agent-availability.mjs:
// PATH + `--version` probes plus on-disk checks for the gemini-cli nanobanana
// MCP extension and the NANOBANANA_API_KEY env var.
//
// Two backends exist, in preference order:
//   1. MCP   — the gemini-cli `nanobanana` extension's MCP server wired into
//              Claude Code. Full structured tools (story/edit/icon/diagram/…).
//   2. agy   — `agy -p "generate an image…"` direct. Simple generation only;
//              artifacts land in agy's sandbox (use agy-invoke --collect).
//
// Usage:
//   node nanobanana-detect.mjs          # prints the JSON capability report
//   import { detect } from "./nanobanana-detect.mjs"
//
// JSON shape:
//   {
//     gemini, agy, node,        // CLIs on PATH (bool)
//     apiKey,                   // NANOBANANA_API_KEY present & non-empty (bool)
//     extensionInstalled,       // ~/.gemini/extensions/nanobanana present (bool)
//     mcpServerBuilt,           // <ext>/mcp-server/dist/index.js exists (bool)
//     serverPath,               // resolved dist/index.js path or null
//     mcpReady,                 // mcpServerBuilt && apiKey (bool)
//     agyReady,                 // agy on PATH (bool) — simple-gen fallback
//     backend                   // "mcp" | "agy" | "none" (preferred usable)
//   }
// `mcpReady` means the server can run; it still must be WIRED into Claude Code
// (see /agy:setup) and the session reloaded for Claude to see the tools.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 1500;

export function probe(bin, { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const res = spawnSync(bin, ["--version"], {
    timeout: timeoutMs,
    stdio: ["ignore", "ignore", "ignore"],
    env,
  });
  if (res.error) return false; // ENOENT (not on PATH) or ETIMEDOUT
  if (res.signal) return false; // killed (e.g. timeout)
  return res.status === 0;
}

// Where the gemini CLI installs the nanobanana extension. Overridable for tests
// via opts.extensionsDir or the GEMINI_EXTENSIONS_DIR env var.
export function extensionDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.GEMINI_EXTENSIONS_DIR || path.join(home, ".gemini", "extensions");
  return path.join(base, "nanobanana");
}

export function detect({ timeoutMs, env = process.env, home = os.homedir() } = {}) {
  const gemini = probe("gemini", { timeoutMs, env });
  const agy = probe("agy", { timeoutMs, env });
  const node = probe("node", { timeoutMs, env });

  const apiKey = typeof env.NANOBANANA_API_KEY === "string" && env.NANOBANANA_API_KEY.trim() !== "";

  const extDir = extensionDir({ env, home });
  const extensionInstalled = fs.existsSync(extDir);
  const serverPath = path.join(extDir, "mcp-server", "dist", "index.js");
  const mcpServerBuilt = fs.existsSync(serverPath);

  const mcpReady = mcpServerBuilt && apiKey;
  const agyReady = agy;
  const backend = mcpReady ? "mcp" : agyReady ? "agy" : "none";

  return {
    gemini,
    agy,
    node,
    apiKey,
    extensionInstalled,
    mcpServerBuilt,
    serverPath: mcpServerBuilt ? serverPath : null,
    mcpReady,
    agyReady,
    backend,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(detect()) + "\n");
  process.exit(0);
}
