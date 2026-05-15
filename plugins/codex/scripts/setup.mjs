#!/usr/bin/env node
// setup.mjs — first-time setup for the Codex bridge.
//
// - Checks codex --version (non-blocking warn if absent)
// - Scaffolds docs/carefully-crafted-plugins/{constraints,output-formats,handoffs,output/images}/
// - Writes starter constraint and output-format .md files (skips existing — never overwrites)
// - Appends .gitignore entries for handoffs/ and output/
// - Prints a human-readable summary
//
// Exit codes: 0 always (warnings reported as text, never failure).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = process.cwd();
const DOCS_ROOT = join(REPO_ROOT, "docs/carefully-crafted-plugins");
const STARTER = {
  "constraints/code-style.md": `# Code Style Constraints

<!-- Document conventions every delegated coding task must follow. Reference
     this file from handoff specs (Section 3). Codex reads this directly. -->

## Languages and versions
- (e.g. TypeScript 5.x strict mode, Python 3.12, ...)

## Formatting
- (e.g. Prettier with project config; 2-space indent; trailing commas required)

## Naming
- (e.g. kebab-case files, PascalCase types, camelCase variables)

## Imports
- (e.g. absolute imports from src/; no relative paths beyond one level)

## Comments
- Default to no comments. Only document WHY when non-obvious.

## Testing
- (e.g. colocate tests as *.test.ts; one assertion theme per test)
`,
  "constraints/design-system.md": `# Design System

<!-- Guidance, not a contract. Describe the visual language so an
     illustrator (human or model) can make good choices. Be evocative,
     not prescriptive — leave room for craft. -->

## Brand mood
- (e.g. "warm, considered, editorial — like a well-made notebook")

## Palette
- Primary: (e.g. #1A1A1A)
- Accent: (e.g. #FF6B35)
- Background: (e.g. #FFFFFF, or cream)
- Other named colors and when to reach for them

## Typography (for assets that include text)
- Display: (e.g. a clean grotesque, 600 weight)
- Body: (e.g. Inter, 400 weight)

## Style adjectives
- (e.g. crafted, restrained, modern-classic, soft-edged)

## Things to avoid
- (e.g. photorealism, busy textures, hyper-saturated colors)
`,
  "constraints/security.md": `# Security Constraints

<!-- Reference this from any handoff that could touch auth, secrets, or
     external services. -->

## Secrets
- Never embed API keys, tokens, or passwords in output.
- Reference environment variables by name only.

## Network
- (e.g. no outbound HTTP except to allowed domains)
- (e.g. respect robots.txt and rate limits in browser tasks)

## Data
- (e.g. never log PII; redact emails and IPs in any captured output)

## Code execution
- (e.g. no eval, no shell injection, parameterized queries only)
`,
  "output-formats/image-icon-256.md": `# Output Format: 256×256 App Icon

## Dimensions
- 256 × 256 pixels, square
- PNG; transparent background unless the spec asks otherwise
- Saved to the artifact path specified in the handoff spec

## Compositional intent
- A single legible mark, centered, with safe-area padding
- Reads at 32×32 (favicon size) — silhouette should be unmistakable

## Style
- Follow design-system.md
`,
  "output-formats/image-hero-1024x768.md": `# Output Format: 1024×768 Hero Image

## Dimensions
- 1024 × 768 pixels
- PNG; opaque background appropriate for the page it will sit on
- Saved to the artifact path specified in the handoff spec

## Compositional intent
- Subject in one third of the canvas; the opposite side should be quieter
  and suitable for headline text overlay if the page calls for it
- Designed to be poster-grade — feels considered, not generic stock

## Style
- Follow design-system.md
`,
  "output-formats/raw-prose.md": `# Output Format: Raw Prose

- Plain markdown text, no surrounding fences
- Direct and concrete; no marketing language; no emoji unless requested
- Length set by the task; default short
`,
  "output-formats/raw-code.md": `# Output Format: Raw Code

- One or more source files, saved to the artifact paths in the spec
- Follow constraints/code-style.md
- File should be drop-in usable in the target codebase
`,
};

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

  for (const [rel, content] of Object.entries(STARTER)) {
    const path = join(DOCS_ROOT, rel);
    if (existsSync(path)) {
      skipped.push(path);
    } else {
      writeFileSync(path, content, "utf8");
      created.push(path);
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

function main() {
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
  console.log("  3. Try /codex:image or /codex:reason on a real task.");
}

main();
