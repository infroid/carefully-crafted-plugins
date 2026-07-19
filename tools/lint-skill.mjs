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
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RULES = {
  // Manual-only skills (`disable-model-invocation: true`) are never
  // auto-triggered, so their description can be terser.
  DESC_MIN_WORDS_MANUAL: 8,
  // Model-invocable skills need enough trigger language for Claude to
  // route to them correctly.
  DESC_MIN_WORDS_AUTO: 15,
  // Same ceiling for both — this is what protects Claude's always-on
  // context budget regardless of invocation mode.
  DESC_MAX_WORDS: 60,
  BODY_WARN_LINES: 200,
  BODY_MAX_LINES: 250,
};

// Parses the YAML frontmatter block. The accept set here must be a
// STRICT SUBSET of what a real YAML parser accepts: being stricter than
// the platform only costs a false alarm, but being looser means the
// linter reads a key the platform will never see — and every rule keyed
// on that key (notably the manual-only evals exemption) then guards
// nothing. Two ways that used to happen, both now rejected:
//
//   disable-model-invocation:true   <- no separator space. YAML block
//                                      mappings require ": ", so a real
//                                      parser yields NO SUCH KEY.
//   disable-model-invocation: false
//   disable-model-invocation: true  <- duplicate key. Strict YAML errors;
//                                      a last-wins reader silently picks
//                                      one and can disagree with the
//                                      platform about which.
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const fmText = match[1];
  const fm = {};
  const problems = [];
  const seen = new Set();
  let currentKey = null;
  for (const line of fmText.split("\n")) {
    // Require the ": " separator (or a bare "key:" with no value).
    const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(?:\s+(.*))?$/);
    if (kv) {
      currentKey = kv[1];
      if (seen.has(currentKey)) {
        problems.push(
          `frontmatter key "${currentKey}" appears more than once — strict YAML rejects duplicate keys, so the linter and the platform could disagree about which value wins`
        );
      }
      seen.add(currentKey);
      fm[currentKey] = kv[2] ?? "";
    } else if (/^([a-zA-Z][a-zA-Z0-9_-]*):\S/.test(line)) {
      // Looks like a mapping but has no space after the colon. A real
      // YAML parser does not produce a key here, so neither do we — and
      // we say so loudly rather than silently dropping the line.
      const key = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):/)[1];
      problems.push(
        `frontmatter line "${line.trim()}" is missing the space after the colon — YAML block mappings require "${key}: value", so the platform would not see this key at all`
      );
    } else if (currentKey && /^\s+\S/.test(line)) {
      fm[currentKey] = (fm[currentKey] + " " + line.trim()).trim();
    }
  }
  return { frontmatter: fm, bodyStart: match[0].length, problems };
}

export function countWords(s) {
  return (s.match(/\S+/g) || []).length;
}

// The native `disable-model-invocation` frontmatter boolean is the sole
// authority on whether a skill is manual-only — not any phrase in the
// prose description. It is parsed strictly: only the literal unquoted
// tokens `true` or `false` are accepted. Any other spelling ("True",
// "yes", "1", a quoted `"true"`, ...) is a lint ERROR, not a silent
// fallback. This matters because the evals exemption below is keyed on
// this same strict result — a lenient parser would let a typo silently
// claim the exemption. A missing field is not a typo; it legitimately
// defaults to model-invocable, the platform default.
export function classifyInvocation(frontmatter, findings = { errors: [], warnings: [] }) {
  const raw = frontmatter["disable-model-invocation"];
  if (raw === undefined) return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  findings.errors.push(
    `disable-model-invocation must be the literal boolean \`true\` or \`false\` (found: ${JSON.stringify(raw)}) — quoted strings, "yes", "1", and other truthy spellings are rejected`
  );
  return false;
}

export function lintOne(filePath) {
  const findings = { errors: [], warnings: [] };
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(content);

  if (!parsed) {
    findings.errors.push("missing YAML frontmatter");
    return { findings, name: null, manualOnly: false };
  }

  const { frontmatter, bodyStart, problems } = parsed;

  // Malformed-YAML problems are errors, not warnings: each one is a case
  // where the linter's view of the frontmatter could diverge from the
  // platform's.
  for (const p of problems) findings.errors.push(p);

  // name
  const name = frontmatter.name;
  if (!name) {
    findings.errors.push("missing `name` in frontmatter");
  } else if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    findings.errors.push(`name "${name}" must be lowercase letters/digits/hyphens, starting with a letter`);
  }

  // Manual-only vs model-invocable is a native-frontmatter fact. Setting
  // `disable-model-invocation: true` removes the skill's name/description
  // from Claude's always-on context and disables automatic invocation
  // entirely — the skill runs only when the user explicitly invokes it,
  // matching current Claude Code platform behavior.
  const manualOnly = classifyInvocation(frontmatter, findings);

  // description
  const desc = frontmatter.description;
  if (!desc) {
    findings.errors.push("missing `description` in frontmatter");
  } else {
    const words = countWords(desc);
    const minWords = manualOnly ? RULES.DESC_MIN_WORDS_MANUAL : RULES.DESC_MIN_WORDS_AUTO;
    if (words < minWords) {
      findings.errors.push(
        `description is ${words} words; min ${minWords} for a ${manualOnly ? "manual-only" : "model-invocable"} skill`
      );
    }
    if (words > RULES.DESC_MAX_WORDS) {
      findings.errors.push(`description is ${words} words; max ${RULES.DESC_MAX_WORDS} — protects always-on context`);
    }

    // A prose "slash-command only" claim is not authoritative by itself.
    // If a description says it but the frontmatter field isn't strictly
    // `disable-model-invocation: true`, the skill is still
    // model-invocable and the claim is misleading — reject it rather
    // than trusting the phrasing.
    const claimsSlashOnly = /slash-?command[\s-]only/i.test(desc);
    if (claimsSlashOnly && !manualOnly) {
      findings.errors.push(
        'description claims "Slash-command only" in prose, but `disable-model-invocation: true` is not set in frontmatter — the frontmatter field is authoritative, prose alone does not make a skill manual-only'
      );
    }

    // Model-invocable skills MUST include trigger language so Claude
    // knows when to fire them — this is a hard requirement, not a style
    // note. A model-invocable skill with no routing language burns
    // always-on context on every turn while giving Claude nothing to
    // route on. Manual-only skills are explicit-invocation and are
    // exempt.
    if (!manualOnly) {
      const hasTrigger = /\b(use whenever|use when|use for|reach for|stage)\b/i.test(desc);
      if (!hasTrigger) {
        findings.errors.push(
          'model-invocable description lacks an explicit trigger phrase ("Use whenever ...", "Reach for ...") — a model-invocable skill must tell Claude when to fire it'
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

  // evals/evals.json — required for model-invocable skills only.
  // Manual-only skills are exempt because they can't be mis-triggered —
  // and that exemption is safe only because `manualOnly` above came from
  // a strict boolean parse, not an assumption or a lenient coercion.
  if (!manualOnly) {
    const evalsPath = path.join(path.dirname(filePath), "evals", "evals.json");
    if (!fs.existsSync(evalsPath)) {
      findings.errors.push(
        `model-invocable skills must ship evals/evals.json with 2+ realistic prompts (missing: ${path.relative(REPO_ROOT, evalsPath)})`
      );
    } else {
      try {
        const evals = JSON.parse(fs.readFileSync(evalsPath, "utf8"));
        if (!Array.isArray(evals.evals) || evals.evals.length < 2) {
          findings.errors.push(`evals/evals.json must contain at least 2 evals (found ${evals.evals?.length ?? 0})`);
        }
        for (const e of evals.evals || []) {
          if (!e.prompt) findings.errors.push(`evals/evals.json eval #${e.id ?? "?"} missing prompt`);
          if (!Array.isArray(e.assertions) || e.assertions.length === 0) {
            findings.errors.push(`evals/evals.json eval #${e.id ?? "?"} missing assertions`);
          }
        }
      } catch (e) {
        findings.errors.push(`evals/evals.json is not valid JSON: ${e.message}`);
      }
    }
  }

  return { findings, name, manualOnly };
}

export function findSkills() {
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
    const { findings, name } = lintOne(file);

    // Skill names must be unique within a plugin — Claude Code routes by
    // the full plugin:skill identity. Cross-plugin name reuse is fine.
    if (name) {
      const plugin = path.relative(REPO_ROOT, file).split(path.sep)[1];
      const key = `${plugin}:${name}`;
      const prior = nameToEntry.get(key);
      if (prior) {
        findings.errors.push(
          `name "${name}" appears twice in plugin "${plugin}" (also at ${path.relative(REPO_ROOT, prior.file)}) — skill names must be unique within a plugin`
        );
      } else {
        nameToEntry.set(key, { file });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
