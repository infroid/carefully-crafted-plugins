#!/usr/bin/env node
// Write a forge lifecycle artifact to
// docs/carefully-crafted-plugins/forge/<phase>/<YYYY-MM-DD-HHMMSS>-<slug>.md
//
// Usage:
//   node forge-write.mjs --phase <spec|plan|tdd|review|verify|debug|ship> \
//                        --slug <kebab-case> \
//                        [--cwd <dir>] < body.md
//
// Reads the artifact body from stdin (so multi-paragraph content survives
// shell quoting). Prints the artifact path on stdout.
//
// Exits 0 on success, 2 on invalid args.

import fs from "node:fs";
import path from "node:path";

const PHASES = new Set(["spec", "plan", "tdd", "review", "verify", "debug", "ship"]);

function die(msg) {
  console.error(`forge-write: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--phase":
        args.phase = next();
        break;
      case "--slug":
        args.slug = next();
        break;
      case "--cwd":
        args.cwd = next();
        break;
      default:
        die(`unknown arg: ${a}`);
    }
  }
  return args;
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artifact";
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!PHASES.has(args.phase)) {
    die(`--phase must be one of: ${[...PHASES].join(", ")}`);
  }
  if (!args.slug) die("--slug is required");

  const body = fs.readFileSync(0, "utf8");
  if (!body.trim()) die("artifact body (stdin) is empty");

  const cwd = args.cwd || process.cwd();
  const dir = path.join(cwd, "docs", "carefully-crafted-plugins", "forge", args.phase);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${timestamp()}-${slugify(args.slug)}.md`);
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
  console.log(file);
}

main();
