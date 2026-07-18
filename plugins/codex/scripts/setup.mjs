#!/usr/bin/env node
// setup.mjs — explicit-only setup for the Codex bridge.
//
// Usage:
//   node setup.mjs           the only mode — full verbose scaffold + summary
//
// - Checks codex --version (non-blocking warn if absent)
// - Scaffolds docs/carefully-crafted-plugins/{constraints,output-formats,handoffs,output/images}/
// - Copies the packaged default constraint/output-format files from
//   plugins/codex/reference/defaults/ into the project (skips any file that
//   already exists — never overwrites)
// - Appends .gitignore entries for handoffs/ and output/
// - Prints a human-readable summary
//
// There is no automatic/first-run mode. Skills that need a constraint or
// output-format file reference the packaged default directly under
// ${CLAUDE_PLUGIN_ROOT}/reference/defaults/ when no project-local file
// exists, rather than scaffolding the repo. `--ensure` (the old fast path
// skills used to call on first run) has been removed — see main() below.
//
// Exit codes: 0 on success, 2 for the removed --ensure path.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, copyFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const DOCS_ROOT = join(REPO_ROOT, "docs/carefully-crafted-plugins");
const DEFAULTS_ROOT = fileURLToPath(new URL("../reference/defaults/", import.meta.url));

const GITIGNORE_ENTRIES = [
  "docs/carefully-crafted-plugins/handoffs/",
  "docs/carefully-crafted-plugins/output/",
];

function checkCodexInstalled() {
  const probe = spawnSync(process.env.CODEX_BIN || "codex", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (probe.error && probe.error.code === "ENOENT") return { installed: false, reason: "not-on-path" };
  if (probe.status !== 0) return { installed: false, reason: `exit-${probe.status}` };
  const version = (probe.stdout || Buffer.from("")).toString().trim();
  return { installed: true, version };
}

function listPackagedDefaults() {
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(relative(DEFAULTS_ROOT, full));
      }
    }
  }
  walk(DEFAULTS_ROOT);
  return results.sort();
}

function scaffoldFiles() {
  const created = [];
  const skipped = [];

  const dirs = [
    join(DOCS_ROOT, "constraints"),
    join(DOCS_ROOT, "output-formats"),
    join(DOCS_ROOT, "handoffs"),
    join(DOCS_ROOT, "output/images"),
  ];
  for (const d of dirs) mkdirSync(d, { recursive: true });

  for (const rel of listPackagedDefaults()) {
    const src = join(DEFAULTS_ROOT, rel);
    const dest = join(DOCS_ROOT, rel);
    if (existsSync(dest)) {
      skipped.push(dest);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      created.push(dest);
    }
  }

  return { created, skipped };
}

function updateGitignore() {
  const giPath = join(REPO_ROOT, ".gitignore");
  let body = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const lines = new Set(body.split("\n").map((l) => l.trim()));
  const toAppend = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  if (toAppend.length === 0) return { appended: [], path: giPath };
  const prefix = body.length && !body.endsWith("\n") ? "\n" : "";
  const block = `${prefix}# carefully-crafted-plugins\n${toAppend.join("\n")}\n`;
  appendFileSync(giPath, block, "utf8");
  return { appended: toAppend, path: giPath };
}

function explicitSetup() {
  console.log("=== /codex:setup ===");
  console.log(`Repo:  ${REPO_ROOT}`);
  console.log(`Docs:  ${DOCS_ROOT}`);
  console.log("");

  const codex = checkCodexInstalled();
  if (codex.installed) {
    console.log(`[ok] codex CLI detected: ${codex.version}`);
  } else {
    console.log(`[warn] codex CLI not detected (${codex.reason}).`);
    console.log("       Install with: npm install -g @openai/codex   (or: brew install codex)");
    console.log("       Then run:     codex login");
  }
  console.log("");

  const { created, skipped } = scaffoldFiles();
  if (created.length) {
    console.log("[created]");
    for (const p of created) console.log(`  + ${p}`);
  }
  if (skipped.length) {
    console.log("[skipped — already exist]");
    for (const p of skipped) console.log(`  = ${p}`);
  }
  console.log("");

  const gi = updateGitignore();
  if (gi.appended.length) {
    console.log(`[gitignore] appended to ${gi.path}:`);
    for (const e of gi.appended) console.log(`  + ${e}`);
  } else {
    console.log(`[gitignore] no changes needed (${gi.path})`);
  }
  console.log("");

  console.log("Next steps:");
  console.log("  1. Edit docs/carefully-crafted-plugins/constraints/*.md to encode your standards.");
  console.log("  2. Edit docs/carefully-crafted-plugins/output-formats/*.md to define output contracts.");
  console.log("  3. Try /codex:imagegen or /codex:reason on a real task.");
}

function main() {
  if (process.argv.slice(2).includes("--ensure")) {
    console.error("[codex] --ensure was removed: automatic setup was removed. Skills no longer");
    console.error("[codex] scaffold this repo on first use. Run /codex:setup explicitly to copy");
    console.error("[codex] the packaged defaults, or reference them directly under");
    console.error("[codex] ${CLAUDE_PLUGIN_ROOT}/reference/defaults/ — no repo mutation required.");
    process.exit(2);
  }
  explicitSetup();
}

main();
