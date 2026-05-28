# Contexthub Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the `forge` (7 phases) and `triage` plugins into `contexthub` (9 skills total), add a shared agent-availability detector, make every multi-agent skill degrade gracefully when codex/agy are missing, and ship as `v5.0.0`.

**Architecture:** `contexthub` becomes the single multi-agent plugin; `codex`/`agy` stay single-agent bridges. A new `agent-availability.mjs` does PATH+`--version` detection (no network/hang); each multi-agent skill runs a "Step 0" detect and reassigns roles for 3/2/1 agents, with lazy auth-failure fallback. Clean break — no `forge:*`/`triage:*` aliases.

**Tech Stack:** Node ≥20 (stdlib only), `node:test`, Claude Code plugin/skill format, `gh` CLI for release.

**Spec:** `docs/superpowers/specs/2026-05-28-contexthub-consolidation-design.md`

**Conventions from the codebase:**
- Scripts: ESM, `parseArgs` switch, `die(msg)` → `process.exit(2)`, `--cwd` override, read stdin via `fs.readFileSync(0,"utf8")`.
- Tests: `node:test` + `node:assert/strict`, `spawnSync("node",[SCRIPT,...])`, `mkdtempSync` temp dirs, `REPO_ROOT` via `fileURLToPath`.
- Lint (`tools/lint-skill.mjs`): description 30–120 words, must end with `Default … path in this marketplace.` (auto-trigger) **or** `Slash-command only`; body ≤250 lines; auto-trigger skills need `evals/evals.json` (≥2 evals, each with assertions); skill `name` unique within a plugin.
- Run the whole suite: `node --test tests/unit/*.test.mjs`.

---

## File structure (created / moved / modified)

**Created**
- `plugins/contexthub/scripts/agent-availability.mjs` — capability detector.
- `tests/unit/agent-availability.test.mjs` — its unit tests.

**Moved (via `git mv`)**
- `plugins/forge/skills/{spec,plan,tdd,review,verify,debug,ship}` → `plugins/contexthub/skills/`
- `plugins/triage/skills/grade` → `plugins/contexthub/skills/triage`
- `plugins/forge/scripts/forge-write.mjs` → `plugins/contexthub/scripts/phase-write.mjs`
- `plugins/triage/scripts/triage-write.mjs` → `plugins/contexthub/scripts/triage-write.mjs`
- `tests/unit/forge-write.test.mjs` → `tests/unit/phase-write.test.mjs`

**Modified**
- The 8 moved SKILL.md bodies (`/forge:`→`/contexthub:`, headings, script name, branch name) + Step 0/degradation.
- `plugins/contexthub/skills/triage/SKILL.md` + its `evals/evals.json` (rename grade→triage).
- `plugins/contexthub/scripts/phase-write.mjs` (artifact dir `forge`→`lifecycle`, prefix).
- `tests/unit/phase-write.test.mjs`, `tests/unit/triage-write.test.mjs` (script paths).
- `plugins/codex/skills/{exec,reason,review}/SKILL.md`, `plugins/codex/scripts/{codex-invoke,setup}.mjs`, `plugins/codex/.claude-plugin/plugin.json` (cross-refs `/forge:`/`/triage:grade`).
- `tools/lint-skill.mjs`, `tools/eval-check.mjs` (comment text).
- `.claude-plugin/marketplace.json` (remove forge/triage, version bumps, descriptions).
- `.gitignore` (`forge/`→`lifecycle/`), `README.md`, `index.html`.

**Deleted**
- `plugins/forge/`, `plugins/triage/` (after their contents are moved out).

---

## Task 1: Agent-availability detector (TDD)

**Files:**
- Create: `plugins/contexthub/scripts/agent-availability.mjs`
- Test: `tests/unit/agent-availability.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-availability.test.mjs`:

```js
// Unit tests for plugins/contexthub/scripts/agent-availability.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "plugins", "contexthub", "scripts", "agent-availability.mjs");
const { detect, probe } = await import(SCRIPT);

function fakeBinDir(names, { exit = 0, sleepSec = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
  for (const name of names) {
    const body = sleepSec ? `#!/bin/sh\n/bin/sleep ${sleepSec}\nexit ${exit}\n` : `#!/bin/sh\nexit ${exit}\n`;
    fs.writeFileSync(path.join(dir, name), body);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

test("both agents present and healthy", () => {
  const dir = fakeBinDir(["codex", "agy"]);
  try {
    assert.deepEqual(detect({ env: { PATH: dir } }),
      { claude: true, codex: true, agy: true, count: 3, externalCount: 2 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only codex present", () => {
  const dir = fakeBinDir(["codex"]);
  try {
    const r = detect({ env: { PATH: dir } });
    assert.equal(r.codex, true); assert.equal(r.agy, false);
    assert.equal(r.count, 2); assert.equal(r.externalCount, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no external agents", () => {
  const dir = fakeBinDir([]);
  try {
    assert.deepEqual(detect({ env: { PATH: dir } }),
      { claude: true, codex: false, agy: false, count: 1, externalCount: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("present but --version fails => unavailable", () => {
  const dir = fakeBinDir(["codex"], { exit: 1 });
  try { assert.equal(probe("codex", { env: { PATH: dir } }), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("hanging agent is killed by timeout => unavailable", () => {
  const dir = fakeBinDir(["codex"], { sleepSec: 5 });
  try { assert.equal(probe("codex", { env: { PATH: dir }, timeoutMs: 300 }), false); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI prints valid JSON and exits 0", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env: { PATH: "" } });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const obj = JSON.parse(res.stdout);
  assert.equal(obj.claude, true);
  assert.equal(typeof obj.count, "number");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test tests/unit/agent-availability.test.mjs`
Expected: FAIL — `Cannot find module .../agent-availability.mjs`.

- [ ] **Step 3: Implement the module**

Create `plugins/contexthub/scripts/agent-availability.mjs`:

```js
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
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(detect()) + "\n");
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `node --test tests/unit/agent-availability.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/contexthub/scripts/agent-availability.mjs tests/unit/agent-availability.test.mjs
git commit -m "feat(contexthub): add agent-availability detector"
```

---

## Task 2: Move forge phases + rename write script (TDD on the script)

**Files:**
- Move: 7 dirs under `plugins/forge/skills/` → `plugins/contexthub/skills/`
- Move: `plugins/forge/scripts/forge-write.mjs` → `plugins/contexthub/scripts/phase-write.mjs`
- Move: `tests/unit/forge-write.test.mjs` → `tests/unit/phase-write.test.mjs`
- Modify: 7 moved SKILL.md bodies

- [ ] **Step 1: git mv the skills and scripts**

```bash
for s in spec plan tdd review verify debug ship; do
  git mv plugins/forge/skills/$s plugins/contexthub/skills/$s
done
git mv plugins/forge/scripts/forge-write.mjs plugins/contexthub/scripts/phase-write.mjs
git mv tests/unit/forge-write.test.mjs tests/unit/phase-write.test.mjs
```

- [ ] **Step 2: Update the test to expect the new path + dir (failing)**

In `tests/unit/phase-write.test.mjs`:
- Line ~1 comment: `forge-write.mjs` → `phase-write.mjs`.
- `SCRIPT`: `path.join(REPO_ROOT,"plugins","contexthub","scripts","phase-write.mjs")`.
- mkdtemp prefix `"forge-test-"` → `"phase-test-"`.
- Assertion `outPath.includes("/forge/spec/")` → `"/lifecycle/spec/"`.
- Assertion `res.stdout.trim().includes("/forge/plan/")` → `"/lifecycle/plan/"`.

Run: `node --test tests/unit/phase-write.test.mjs`
Expected: FAIL — script still writes `/forge/` (and old `forge-write:` prefix is fine, but dir mismatch fails the include assertions).

- [ ] **Step 3: Update phase-write.mjs**

In `plugins/contexthub/scripts/phase-write.mjs`:
- Header comment: `forge-write.mjs` → `phase-write.mjs`; `docs/carefully-crafted-plugins/forge/<phase>/` → `…/lifecycle/<phase>/`.
- `die()` prefix: `forge-write:` → `phase-write:`.
- Line ~79: `path.join(cwd, "docs", "carefully-crafted-plugins", "forge", args.phase)` → replace `"forge"` with `"lifecycle"`.

- [ ] **Step 4: Run the test**

Run: `node --test tests/unit/phase-write.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Rewrite cross-refs in the 7 moved SKILL.md bodies**

In each of `plugins/contexthub/skills/{spec,plan,tdd,review,verify,debug,ship}/SKILL.md`:
- Heading `# forge:<phase> —` → `# contexthub:<phase> —`.
- Every `/forge:<x>` → `/contexthub:<x>` (e.g. "Next: `/forge:verify`" → "`/contexthub:verify`").
- `${CLAUDE_PLUGIN_ROOT}/scripts/forge-write.mjs` → `${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs`.
- Git branch convention `forge/<plan-slug>` → `contexthub/<plan-slug>`.
- Leave `/codex:*`, `/agy:*`, `/contexthub:converge`, and the `(context-hub:<skill>)` description prefix untouched.

Verify none missed:
```bash
grep -rn "forge" plugins/contexthub/skills | grep -v "context-hub"
```
Expected: no `/forge:` or `forge-write` or `# forge:` matches remain.

- [ ] **Step 6: Lint moved skills**

Run: `node tools/lint-skill.mjs plugins/contexthub/skills/{spec,plan,tdd,review,verify,debug,ship}/SKILL.md`
Expected: `0 error(s)`.

- [ ] **Step 7: Commit**

```bash
git add plugins/contexthub tests/unit/phase-write.test.mjs
git commit -m "refactor(contexthub): move forge phases in, rename forge-write -> phase-write"
```

---

## Task 3: Move triage → contexthub:triage (TDD on the script path)

**Files:**
- Move: `plugins/triage/skills/grade` → `plugins/contexthub/skills/triage`
- Move: `plugins/triage/scripts/triage-write.mjs` → `plugins/contexthub/scripts/triage-write.mjs`
- Modify: `plugins/contexthub/skills/triage/SKILL.md`, `…/triage/evals/evals.json`, `tests/unit/triage-write.test.mjs`

- [ ] **Step 1: git mv**

```bash
git mv plugins/triage/skills/grade plugins/contexthub/skills/triage
git mv plugins/triage/scripts/triage-write.mjs plugins/contexthub/scripts/triage-write.mjs
```
(`difficulty-heuristics.md` moves automatically inside `triage/references/`.)

- [ ] **Step 2: Update triage-write test (failing)**

In `tests/unit/triage-write.test.mjs`:
- Line ~1 comment + `SCRIPT`: `plugins/triage/scripts/triage-write.mjs` → `plugins/contexthub/scripts/triage-write.mjs`.

Run: `node --test tests/unit/triage-write.test.mjs`
Expected: FAIL — `Cannot find module …/plugins/triage/scripts/triage-write.mjs` (path moved).

- [ ] **Step 3: Confirm script needs no path edits, rerun**

`triage-write.mjs` writes to `docs/carefully-crafted-plugins/triage/` (unchanged by design — only the lifecycle dir was renamed). No code edit needed.

Run: `node --test tests/unit/triage-write.test.mjs`
Expected: PASS (after Step 2's path fix).

- [ ] **Step 4: Rename the skill (name, prefix, refs)**

In `plugins/contexthub/skills/triage/SKILL.md`:
- Frontmatter `name: grade` → `name: triage`.
- Description prefix `(context-hub:grade)` → `(context-hub:triage)`.
- `When invoked as \`/triage:grade <task>\`` → `\`/contexthub:triage <task>\``.
- `${CLAUDE_PLUGIN_ROOT}/skills/grade/references/difficulty-heuristics.md` → `…/skills/triage/references/difficulty-heuristics.md`.
- Any other `/triage:grade` → `/contexthub:triage`.

In `plugins/contexthub/skills/triage/evals/evals.json`:
- `"skill_name": "grade"` → `"triage"`.
- `"skill_path": "plugins/triage/skills/grade"` → `"plugins/contexthub/skills/triage"`.

- [ ] **Step 5: Lint + eval-check triage**

```bash
node tools/lint-skill.mjs plugins/contexthub/skills/triage/SKILL.md
node tools/eval-check.mjs plugins/contexthub/skills/triage/evals/evals.json
```
Expected: both `0 error(s)`.

- [ ] **Step 6: Commit**

```bash
git add plugins/contexthub tests/unit/triage-write.test.mjs
git commit -m "refactor(contexthub): move triage:grade in as contexthub:triage"
```

---

## Task 4: Bake agent-aware degradation into the 9 multi-agent skills

**Files (modify):** `plugins/contexthub/skills/{spec,plan,tdd,review,verify,debug,ship,triage,converge}/SKILL.md`

- [ ] **Step 1: Insert this canonical "Step 0" block** immediately after the "## Your input" section in each of the 9 skills:

```markdown
## Step 0: Detect available agents

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agent-availability.mjs
```

This prints `{ "claude": true, "codex": <bool>, "agy": <bool>, "count": N, "externalCount": M }`.
Run only the delegation steps below whose agent is `true`. When you skip a
step because its agent is absent, say so in one line. If `count` is 1
(Claude only), do the work solo and tell the user once: *"Ran this with
Claude only — install or log into codex/agy for fuller cross-checks."*

**Lazy auth:** if a `codex`/`agy` call later fails with a not-logged-in /
auth error, treat that agent as unavailable for the rest of this run — drop
its role, print the degraded note, and continue with the remaining agents.
```

- [ ] **Step 2: Add per-skill role-reassignment rules.** Append a short "### Degradation" note to each skill's relevant step, using these exact rules:

- **converge:** count 3 → full Delphi (Claude+codex+agy). count 2 → a *2-way* debate labeled "(Claude + codex)" or "(Claude + agy)". count 1 → a direct Claude answer prefixed "No debate possible (no external agents) —".
- **review:** 3 → Claude + codex (fresh eyes) + agy (repo scan). no codex → Claude + agy. no agy → Claude + codex. 1 → Claude solo pass only.
- **debug:** codex:reason leg runs only if codex; agy:longctx leg only if agy; each skipped leg noted; 1 → Claude hypotheses only.
- **verify:** tests always run; codex:playwright only if codex; agy:longctx blast-radius only if agy; 1 → tests + Claude review.
- **plan:** Claude draft + contexthub:triage always; codex:reason stress-test only if codex; agy:longctx coverage only if agy.
- **tdd:** delegate a stuck subproblem to codex:reason only if codex; else persevere in Claude and note it.
- **triage:** "Only route to specialists present in the Step 0 report — never suggest `/codex:*` when codex is absent; fall back to claude/agy/contexthub."
- **spec:** invoke contexthub:converge only when a genuine tradeoff exists AND `externalCount >= 1`; otherwise resolve in Claude and note.
- **ship:** optional converge retro only if `externalCount >= 1`.

- [ ] **Step 3: Check body line limits**

```bash
node tools/lint-skill.mjs
```
Expected: `0 error(s)`. If any skill body now exceeds 250 lines, move its longest reference section into `plugins/contexthub/skills/<skill>/references/` and link it, then re-run.

- [ ] **Step 4: Commit**

```bash
git add plugins/contexthub/skills
git commit -m "feat(contexthub): agent-aware graceful degradation in all multi-agent skills"
```

---

## Task 5: Cross-ref sweep, delete old plugins, fix configs

**Files:** codex skills/scripts, tools comments, `.gitignore`, `.claude-plugin/marketplace.json`; delete `plugins/forge`, `plugins/triage`.

- [ ] **Step 1: Fix cross-references in codex + tools**

Update these to the new namespace (`/triage:grade`→`/contexthub:triage`, `/forge:<x>`→`/contexthub:<x>`):
- `plugins/codex/skills/exec/SKILL.md`, `plugins/codex/skills/reason/SKILL.md`, `plugins/codex/skills/review/SKILL.md`
- `plugins/codex/scripts/codex-invoke.mjs`, `plugins/codex/scripts/setup.mjs`
- `plugins/codex/.claude-plugin/plugin.json` (description/keywords if they name forge/triage)
- `tools/lint-skill.mjs` comment (the `forge:review`/`forge:spec` example → `contexthub:review`/`contexthub:spec`)
- `tools/eval-check.mjs` comment (`triage/forge JSON artifact` → `triage/lifecycle JSON artifact`)

- [ ] **Step 2: Update `.gitignore`**

Change line `docs/carefully-crafted-plugins/forge/` → `docs/carefully-crafted-plugins/lifecycle/` (keep the `triage/`, `handoffs/`, `output/` lines).

- [ ] **Step 3: Delete the emptied plugins**

```bash
git rm -r plugins/forge plugins/triage
```
(They now contain only `.claude-plugin/plugin.json` after the moves; confirm with `git status` that no skill/script is lost.)

- [ ] **Step 4: Update marketplace.json**

In `.claude-plugin/marketplace.json`:
- Remove the `forge` and `triage` plugin objects from `plugins[]`.
- `metadata.version`: `4.0.1` → `5.0.0`; rewrite `metadata.description` to drop "forge lifecycle"/"triage" naming and describe codex, agy, and contexthub (now the multi-agent hub).
- `contexthub` entry: `version` `3.0.1` → `4.0.0`; rewrite its `description` to: the multi-agent hub — full lifecycle (spec→ship), task triage, and the Delphi converge debate, all degrading gracefully to however many agents are installed.

Also bump `plugins/contexthub/.claude-plugin/plugin.json` `version` `3.0.1` → `4.0.0` and refresh its description/keywords (add lifecycle, triage, degradation).

- [ ] **Step 5: Verify no stale references remain**

```bash
grep -rniE "/(forge|triage):|forge-write|plugins/(forge|triage)|\"forge\"|skills/grade" \
  plugins tests tools README.md index.html .claude-plugin | grep -v "docs/carefully-crafted-plugins"
```
Expected: no output (the only acceptable hits are `(context-hub:*)` prefixes and the `lifecycle` dir — none of which match this pattern).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove forge/triage plugins, fix cross-refs, bump contexthub 4.0.0 + marketplace 5.0.0"
```

---

## Task 6: Update README + website

**Files:** `README.md`, `index.html`

- [ ] **Step 1: README**

- Layout/section listing: replace the 5-plugin tree with 3 plugins; under `contexthub` list 9 skills + `scripts/{phase-write,triage-write,agent-availability}.mjs`.
- Install block: 3 `/plugin install` lines (codex, agy, contexthub).
- Command reference: list `contexthub:{spec,plan,tdd,review,verify,debug,ship,triage,converge}`; remove `forge:`/`triage:` sections.
- Add a one-liner: contexthub works with Claude alone; codex/agy are optional collaborators that enrich each skill when installed.
- Update the "Migrating from 2.x" / version notes to mention the 5.0.0 consolidation.

- [ ] **Step 2: index.html**

- Install section: 3-plugin block (mirror README).
- Capability/command cards and nav anchors: replace forge/triage entries with the contexthub lifecycle + triage; ensure no `/forge:`/`/triage:` `<code>` snippets remain.
- Add the "works solo, agents optional" messaging near install.

- [ ] **Step 3: Verify in a browser**

Start a static server and screenshot the install + capabilities sections; confirm no stale `/forge:`/`/triage:` commands appear. (Use the project's preview tooling.)

```bash
grep -nE "/(forge|triage):" README.md index.html
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md index.html
git commit -m "docs: rewrite README + website around the 3-plugin contexthub model"
```

---

## Task 7: Pre-release gates

- [ ] **Step 1: Full test suite**

Run: `node --test tests/unit/*.test.mjs`
Expected: all pass, `0 fail`.

- [ ] **Step 2: Lint + eval-check (whole marketplace)**

```bash
node tools/lint-skill.mjs    # expect: contexthub has 9 skills, 0 errors
node tools/eval-check.mjs    # expect: 0 errors
```

- [ ] **Step 3: JSON validity**

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json'))" && \
for f in plugins/*/.claude-plugin/plugin.json; do node -e "JSON.parse(require('fs').readFileSync('$f'))" || echo "BAD: $f"; done && echo OK
```
Expected: `OK`, marketplace lists exactly 3 plugins.

- [ ] **Step 4: Final stale-reference grep** (same as Task 5 Step 5) — expect no output.

---

## Task 8: Release v5.0.0 (USER-GATED)

> Do NOT tag/push/release without explicit user go-ahead (project convention; the user chose "commit only" previously).

- [ ] **Step 1: Confirm clean state**

Run: `git status` — expect everything committed; `git log --oneline -8` shows the consolidation commits.

- [ ] **Step 2: Ask the user for go-ahead to tag + release v5.0.0.**

- [ ] **Step 3: Tag, push, GitHub release** (after approval)

```bash
git push origin master
git tag v5.0.0
git push origin v5.0.0
gh release create v5.0.0 --title "v5.0.0 — contexthub consolidation" --notes "$(cat <<'NOTES'
## Breaking
- Removed the `forge` and `triage` plugins. Their skills now live under `contexthub`:
  `forge:<phase>` → `contexthub:<phase>` (spec, plan, tdd, review, verify, debug, ship);
  `triage:grade` → `contexthub:triage`. No alias shims — reinstall `contexthub`.

## Added
- Agent-aware graceful degradation: every multi-agent skill detects which of
  {Claude, codex, agy} are installed and runs the richest flow available,
  degrading to Claude-solo (with a note) instead of failing.

## Versions
- contexthub 3.0.1 → 4.0.0; marketplace 4.0.1 → 5.0.0.
NOTES
)"
```

---

## Self-review

**Spec coverage:** Goal → all tasks. Target structure (moves/renames/deletes) → T2, T3, T5. agent-availability.mjs + hybrid detection + count semantics → T1. Lazy auth → T4 Step 1. Per-skill degradation → T4 Step 2. Versions/release → T5 Step 4, T8. README/website + "works solo" → T6. Testing/lint/eval gates + name uniqueness → T1–T3, T7. `.gitignore` swap → T5 Step 2. Edge cases (timeout, --version-fail, empty PATH) → T1 tests. ✅ no gaps.

**Placeholder scan:** No TBD/TODO; all code blocks and commands are concrete; per-skill rules are explicit, not "handle edge cases." ✅

**Type/name consistency:** `detect()`/`probe()` signatures + return shape `{claude,codex,agy,count,externalCount}` identical in module (T1 Step 3) and tests (T1 Step 1). Script renamed to `phase-write.mjs` consistently in T2 (script, test, skill bodies). `name: triage` + `(context-hub:triage)` + `skill_name: triage` consistent across T3. Artifact dir `lifecycle` consistent (phase-write.mjs, test, .gitignore). ✅
