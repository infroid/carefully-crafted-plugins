#!/usr/bin/env node
// Explicit, flag-gated setup for the Nano Banana MCP backend.
//
// NOTHING here runs implicitly. The default (no action flag, or --status) is
// READ-ONLY: it reports what's present and what's missing. Each state-changing
// step requires its own explicit flag, so the /agy:setup skill can walk the
// user through them one consent at a time:
//
//   node nanobanana-setup.mjs --status [--json] [--cwd <dir>]
//        report backend readiness + next steps (read-only; the default).
//
//   node nanobanana-setup.mjs --install-extension [--dry-run]
//        `gemini extensions install <repo> --consent --skip-settings`
//        (requires the gemini CLI; clones the extension into ~/.gemini/extensions).
//        --skip-settings avoids gemini's interactive API-key prompt; the key is
//        supplied later via env-expansion in the wired MCP config.
//
//   node nanobanana-setup.mjs --build [--dry-run]
//        build the extension's MCP server (npm install in mcp-server/, which
//        runs its `prepare` → `tsc` → dist/index.js). Idempotent.
//
//   node nanobanana-setup.mjs --wire --scope project [--dry-run] [--cwd <dir>]
//        merge an `mcpServers.nanobanana` entry into <cwd>/.mcp.json pointing at
//        the built server, with the API key passed by ENV EXPANSION
//        ("${NANOBANANA_API_KEY}") — the key itself is NEVER written to disk.
//        --scope user|local: does NOT edit ~/.claude.json (fragile); instead
//        prints the exact `claude mcp add` command for you to run.
//
// The API key is never accepted as an argument, never logged, never persisted.
// You set NANOBANANA_API_KEY in your shell; the wired config references it.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detect, extensionDir } from "./nanobanana-detect.mjs";

const REPO_URL = "https://github.com/gemini-cli-extensions/nanobanana";
const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";

// valueFlags always consume the next token as their value (even a "--…" one);
// `--key=value` is also accepted. Other flags are boolean.
function parseArgs(argv, valueFlags = new Set()) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      args[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const key = body;
    const next = argv[i + 1];
    if (valueFlags.has(key)) {
      if (next === undefined) args[key] = true;
      else { args[key] = next; i++; }
    } else if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

// The MCP server entry we wire into a Claude Code MCP config. The key is passed
// by env expansion; NANOBANANA_MODEL defaults to Nano Banana 2 but honours an
// override already set in the environment.
export function serverEntry(serverPath) {
  return {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env: {
      NANOBANANA_API_KEY: "${NANOBANANA_API_KEY}",
      NANOBANANA_MODEL: "${NANOBANANA_MODEL:-" + DEFAULT_MODEL + "}",
    },
  };
}

// Merge nanobanana into an existing .mcp.json object without disturbing other
// servers. Returns { config, changed }.
export function mergeMcpConfig(existing, serverPath) {
  const config = existing && typeof existing === "object" ? existing : {};
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  const entry = serverEntry(serverPath);
  const before = JSON.stringify(config.mcpServers.nanobanana);
  config.mcpServers.nanobanana = entry;
  return { config, changed: before !== JSON.stringify(entry) };
}

// The CLI equivalent (for user/local scope, which we don't hand-edit).
export function addCommand(scope, serverPath) {
  return (
    `claude mcp add nanobanana --scope ${scope} ` +
    `--env NANOBANANA_API_KEY='\${NANOBANANA_API_KEY}' ` +
    `--env NANOBANANA_MODEL='\${NANOBANANA_MODEL:-${DEFAULT_MODEL}}' ` +
    `-- node '${serverPath}'`
  );
}

// Is nanobanana already referenced in <cwd>/.mcp.json?
function projectWired(cwd) {
  const file = path.join(cwd, ".mcp.json");
  if (!fs.existsSync(file)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    return Boolean(cfg?.mcpServers?.nanobanana);
  } catch {
    return false;
  }
}

export function status({ cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  const d = detect({ env, home });
  const wiredProject = projectWired(cwd);
  const nextSteps = [];
  // gemini is only needed to install/build the extension; don't nag once the
  // server is already built.
  if (!d.gemini && !d.mcpServerBuilt) nextSteps.push("Install the Gemini CLI (npm i -g @google/gemini-cli or brew install gemini-cli).");
  if (!d.extensionInstalled) nextSteps.push("Install the extension: nanobanana-setup.mjs --install-extension");
  else if (!d.mcpServerBuilt) nextSteps.push("Build the MCP server: nanobanana-setup.mjs --build");
  if (!d.apiKey) nextSteps.push("Set NANOBANANA_API_KEY in your shell (key from https://aistudio.google.com/apikey).");
  if (d.mcpServerBuilt && !wiredProject) nextSteps.push("Wire into Claude Code: nanobanana-setup.mjs --wire --scope project");
  if (d.mcpReady && wiredProject) nextSteps.push("Run /mcp (or /reload-plugins) in Claude Code to load the tools.");
  if (nextSteps.length === 0) nextSteps.push("All set — run /mcp to confirm the nanobanana tools are connected.");
  return { ...d, wiredProject, nextSteps };
}

function run(cmd, cmdArgs, { dryRun, cwd } = {}) {
  const printable = `${cmd} ${cmdArgs.join(" ")}`;
  if (dryRun) {
    console.log(`[dry-run] would run: ${printable}${cwd ? `  (cwd: ${cwd})` : ""}`);
    return 0;
  }
  console.log(`+ ${printable}`);
  // stdin is /dev/null: a setup step must never block on an interactive prompt.
  const res = spawnSync(cmd, cmdArgs, { stdio: ["ignore", "inherit", "inherit"], cwd });
  if (res.error && res.error.code === "ENOENT") {
    console.error(`error: '${cmd}' not found on PATH.`);
    return 127;
  }
  return res.status ?? 1;
}

function installExtension({ dryRun, env, home }) {
  if (!detect({ env, home }).gemini) {
    console.error("error: gemini CLI not found. Install it first, then re-run --install-extension.");
    return 1;
  }
  // --skip-settings: the extension declares an "API Key" setting that gemini
  // would otherwise PROMPT for interactively (hanging a non-interactive run).
  // We supply the key via ${NANOBANANA_API_KEY} env-expansion in the wired MCP
  // config instead, so we skip gemini's settings step entirely.
  return run("gemini", ["extensions", "install", REPO_URL, "--consent", "--skip-settings"], { dryRun });
}

function buildServer({ dryRun, env, home }) {
  const extDir = extensionDir({ env, home });
  const serverDir = path.join(extDir, "mcp-server");
  if (!fs.existsSync(serverDir)) {
    console.error(`error: ${serverDir} not found. Run --install-extension first.`);
    return 1;
  }
  if (fs.existsSync(path.join(serverDir, "dist", "index.js"))) {
    console.log(`already built: ${path.join(serverDir, "dist", "index.js")}`);
    return 0;
  }
  // `npm install` triggers the package's `prepare` → `npm run build` (tsc).
  return run("npm", ["install"], { dryRun, cwd: serverDir });
}

function wire({ scope, dryRun, cwd, env, home }) {
  const d = detect({ env, home });
  if (!d.mcpServerBuilt || !d.serverPath) {
    console.error("error: MCP server not built. Run --install-extension and --build first.");
    return 1;
  }
  if (scope === "user" || scope === "local") {
    console.log(`# ${scope}-scope wiring does not touch ~/.claude.json directly. Run:\n`);
    console.log(addCommand(scope, d.serverPath));
    console.log("\n# (single-quoted so the shell keeps the ${...} reference; the key stays out of the config file.)");
    return 0;
  }
  // project scope → merge <cwd>/.mcp.json
  const file = path.join(cwd, ".mcp.json");
  let existing = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`error: ${file} is not valid JSON; refusing to overwrite (${e.message}).`);
      return 1;
    }
  }
  const { config, changed } = mergeMcpConfig(existing, d.serverPath);
  if (dryRun) {
    console.log(`[dry-run] would write ${file}:`);
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(`${changed ? "wired" : "already wired (refreshed)"}: ${file} → mcpServers.nanobanana`);
  console.log("Note: the API key is referenced as ${NANOBANANA_API_KEY} (env expansion); it is NOT stored in this file.");
  console.log("Next: ensure NANOBANANA_API_KEY is exported in your shell, then run /mcp (or /reload-plugins) in Claude Code.");
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2), new Set(["scope", "cwd"]));
  const env = process.env;
  const home = os.homedir();
  const cwd = typeof args["cwd"] === "string" ? path.resolve(args["cwd"]) : process.cwd();
  const dryRun = args["dry-run"] === true;

  if (args["install-extension"]) process.exit(installExtension({ dryRun, env, home }));
  if (args["build"]) process.exit(buildServer({ dryRun, env, home }));
  if (args["wire"]) {
    const scope = typeof args["scope"] === "string" ? args["scope"] : "project";
    if (!["project", "user", "local"].includes(scope)) {
      console.error(`error: --scope must be project|user|local (got "${scope}")`);
      process.exit(2);
    }
    process.exit(wire({ scope, dryRun, cwd, env, home }));
  }

  // Default: read-only status.
  const s = status({ cwd, env, home });
  if (args["json"]) {
    process.stdout.write(JSON.stringify(s) + "\n");
  } else {
    console.log("Nano Banana backend status");
    console.log(`  gemini CLI:        ${s.gemini ? "yes" : "no"}`);
    console.log(`  agy CLI (fallback):${s.agy ? " yes" : " no"}`);
    console.log(`  extension installed:${s.extensionInstalled ? " yes" : " no"}`);
    console.log(`  MCP server built:  ${s.mcpServerBuilt ? "yes" : "no"}`);
    console.log(`  NANOBANANA_API_KEY:${s.apiKey ? " set" : " (unset)"}`);
    console.log(`  wired (.mcp.json): ${s.wiredProject ? "yes" : "no"}`);
    console.log(`  preferred backend: ${s.backend}`);
    console.log("\nNext steps:");
    for (const step of s.nextSteps) console.log(`  - ${step}`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
