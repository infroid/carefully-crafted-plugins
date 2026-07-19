#!/usr/bin/env node
// Detect which coding agent CLIs are present on this machine.
//
// This performs bounded PATH/PATHEXT executable *resolution* only — it
// checks whether a `codex` / `agy` binary exists on PATH and is
// executable. It does NOT spawn the binary, so a present-but-hanging or
// present-but-broken binary can never block or crash detection. It also
// does NOT verify auth or capability — a present-but-unauthenticated CLI
// still reports as a candidate. The actual Codex/Agy delegation calls
// made by skills are already bounded (explicit timeouts / --sandbox
// flags) and handle lazy auth failure themselves: drop the agent, warn,
// continue. This script's only job is: is there a plausible binary to
// try?
//
// Usage:
//   node agent-availability.mjs            # prints the JSON capability report
//   import { detect } from "./agent-availability.mjs"
//
// JSON shape: { claude:true, codex:bool, agy:bool, count:N, externalCount:M }
//   count         = total usable agents including Claude (1-3)
//   externalCount = codex + agy available (0-2)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Windows resolves a bare command name through PATHEXT; POSIX has no such
// mechanism (the executable bit on the file itself is what matters).
// Read fresh from the passed-in `env` on every call rather than caching
// a shared array at module scope — nothing here escapes by reference for
// a later, unrelated call to mutate.
function resolvableExtensions(platform, env) {
  if (platform !== "win32") return [""];
  // A bare, extensionless file is not a recognized executable format on
  // Windows — only the extensions PATHEXT lists are. No "" fallback here.
  const raw = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter(Boolean);
}

function isExecutableCandidate(filePath, platform) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false; // ENOENT, EACCES on stat, etc. — not a spawn, just metadata.
  }
  if (!stat.isFile()) return false;
  if (platform === "win32") return true; // extension match already did the work.
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Bounded PATH resolution: scans each directory in PATH exactly once for
// a matching, executable file. Never spawns the candidate — this is the
// whole point of the rewrite. A present-but-hanging or present-but-crashy
// binary is still correctly reported as a candidate, instantly.
export function resolve(bin, { env = process.env, platform = process.platform } = {}) {
  const pathVar = env.PATH || env.Path || "";
  if (!pathVar) return false;
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts = resolvableExtensions(platform, env);
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isExecutableCandidate(path.join(dir, bin + ext), platform)) return true;
    }
  }
  return false;
}

export function detect({ env = process.env, platform = process.platform } = {}) {
  const codex = resolve("codex", { env, platform });
  const agy = resolve("agy", { env, platform });
  const externalCount = (codex ? 1 : 0) + (agy ? 1 : 0);
  return { claude: true, codex, agy, count: 1 + externalCount, externalCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(detect()) + "\n");
  process.exit(0);
}
