#!/usr/bin/env node
// Enforces the carefully-crafted-plugins quality bar against every
// SKILL.md in this marketplace.
//
// Usage:
//   node tools/lint-skill.mjs               # walks plugins/*/skills/*/SKILL.md
//   node tools/lint-skill.mjs <file> ...    # lints specific files
//
// Exits 0 on pass, 1 on any error (warnings do not fail).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RULES = {
  DESC_MIN_WORDS: 30,
  DESC_MAX_WORDS: 120,
  BODY_WARN_LINES: 200,
  BODY_MAX_LINES: 250,
};

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const fmText = match[1];
  const fm = {};
  let currentKey = null;
  for (const line of fmText.split("\n")) {
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      fm[currentKey] = kv[2];
    } else if (currentKey && /^\s+\S/.test(line)) {
      fm[currentKey] = (fm[currentKey] + " " + line.trim()).trim();
    }
  }
  return { frontmatter: fm, bodyStart: match[0].length };
}

function countWords(s) {
  return (s.match(/\S+/g) || []).length;
}

function lintOne(filePath) {
  const findings = { errors: [], warnings: [] };
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(content);

  if (!parsed) {
    findings.errors.push("missing YAML frontmatter");
    return { findings, name: null };
  }

  const { frontmatter, bodyStart } = parsed;

  // name
  const name = frontmatter.name;
  if (!name) {
    findings.errors.push("missing `name` in frontmatter");
  } else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    findings.errors.push(`name "${name}" must be lowercase letters/digits/hyphens, starting with a letter`);
  }

  // description
  const desc = frontmatter.description;
  let isSlashOnly = false;
  if (!desc) {
    findings.errors.push("missing `description` in frontmatter");
  } else {
    const words = countWords(desc);
    if (words < RULES.DESC_MIN_WORDS) {
      findings.errors.push(`description is ${words} words; min ${RULES.DESC_MIN_WORDS}`);
    }
    if (words > RULES.DESC_MAX_WORDS) {
      findings.errors.push(`description is ${words} words; max ${RULES.DESC_MAX_WORDS}`);
    }

    const hasDefaultClaim = /default[^.]*path in this marketplace/i.test(desc);
    isSlashOnly = /slash-?command[\s-]only/i.test(desc);

    if (!hasDefaultClaim && !isSlashOnly) {
      findings.errors.push(
        'description must end with a closing claim: either "Default ... path in this marketplace." (auto-trigger) or "Slash-command only" (explicit-only)'
      );
    }
    if (hasDefaultClaim && isSlashOnly) {
      findings.errors.push(
        'description claims both "Default ... path" AND "Slash-command only" — pick one'
      );
    }

    // Auto-triggering skills must include trigger language so Claude
    // knows when to fire them. Slash-only skills are explicit-invocation
    // and don't need it.
    if (!isSlashOnly) {
      const hasTrigger = /\b(use whenever|use when|use for|reach for|stage)\b/i.test(desc);
      if (!hasTrigger) {
        findings.warnings.push(
          'auto-trigger description lacks an explicit trigger phrase ("Use whenever ...", "Reach for ...") — pushy template expects one'
        );
      }
    }
  }

  // body
  const body = content.slice(bodyStart);
  const bodyLines = body.split("\n").length;
  if (bodyLines > RULES.BODY_MAX_LINES) {
    findings.errors.push(`body is ${bodyLines} lines; max ${RULES.BODY_MAX_LINES} — split detail into references/`);
  } else if (bodyLines > RULES.BODY_WARN_LINES) {
    findings.warnings.push(`body is ${bodyLines} lines; soft limit ${RULES.BODY_WARN_LINES}`);
  }

  return { findings, name, isSlashOnly };
}

function findSkills() {
  const skills = [];
  const pluginsDir = path.join(REPO_ROOT, "plugins");
  if (!fs.existsSync(pluginsDir)) return skills;
  for (const plugin of fs.readdirSync(pluginsDir).sort()) {
    const skillsDir = path.join(pluginsDir, plugin, "skills");
    if (!fs.existsSync(skillsDir)) continue;
    for (const skill of fs.readdirSync(skillsDir).sort()) {
      const file = path.join(skillsDir, skill, "SKILL.md");
      if (fs.existsSync(file)) skills.push(file);
    }
  }
  return skills;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((a) => path.resolve(a)) : findSkills();

  if (files.length === 0) {
    console.error("no SKILL.md files found");
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  const nameToEntry = new Map();

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const { findings, name, isSlashOnly } = lintOne(file);

    // Cross-marketplace name uniqueness applies only to auto-triggering
    // skills. Slash-only skills (like `exec`) are explicit-invocation,
    // prefix-qualified by construction, and may share names across
    // plugins on purpose.
    if (name) {
      const prior = nameToEntry.get(name);
      if (prior && !(prior.isSlashOnly && isSlashOnly)) {
        findings.errors.push(
          `name "${name}" collides with ${path.relative(REPO_ROOT, prior.file)} — auto-triggering skill names must be unique across the marketplace`
        );
      } else if (!prior) {
        nameToEntry.set(name, { file, isSlashOnly });
      }
    }

    if (findings.errors.length === 0 && findings.warnings.length === 0) {
      console.log(`  ok    ${rel}`);
    } else {
      const marker = findings.errors.length > 0 ? "FAIL" : "warn";
      console.log(`  ${marker}  ${rel}`);
      for (const e of findings.errors) console.log(`         error: ${e}`);
      for (const w of findings.warnings) console.log(`         warn:  ${w}`);
    }
    totalErrors += findings.errors.length;
    totalWarnings += findings.warnings.length;
  }

  console.log(`\n${files.length} skill(s), ${totalErrors} error(s), ${totalWarnings} warning(s)`);
  process.exit(totalErrors > 0 ? 1 : 0);
}

main();
