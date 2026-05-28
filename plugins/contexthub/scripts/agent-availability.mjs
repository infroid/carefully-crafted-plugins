#!/usr/bin/env node
// Detect which coding agents are usable from this machine.
// Hybrid detection: PATH + `--version` probe (fast, no network, no hang).
// Auth is NOT verified here — callers handle auth failures lazily at the
// point of delegation (drop the agent, warn, continue).
//
// Usage:
//   node agent-availability.mjs            # prints the JSON capability report
//   import { detect } from "./agent-availability.mjs"
//
// JSON shape: { claude:true, codex:bool, agy:bool, count:N, externalCount:M }
//   count         = total usable agents including Claude (1-3)
//   externalCount = codex + agy available (0-2)

import { spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 1500;

export function probe(bin, { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  const res = spawnSync(bin, ["--version"], {
    timeout: timeoutMs,
    stdio: ["ignore", "ignore", "ignore"],
    env,
  });
  if (res.error) return false;   // ENOENT (not on PATH) or ETIMEDOUT
  if (res.signal) return false;  // killed (e.g. timeout)
  return res.status === 0;
}

export function detect({ timeoutMs, env = process.env } = {}) {
  const codex = probe("codex", { timeoutMs, env });
  const agy = probe("agy", { timeoutMs, env });
  const externalCount = (codex ? 1 : 0) + (agy ? 1 : 0);
  return { claude: true, codex, agy, count: 1 + externalCount, externalCount };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(detect()) + "\n");
  process.exit(0);
}
