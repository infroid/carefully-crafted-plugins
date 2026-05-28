# Design: Consolidate multi-agent flows under `contexthub` + agent-aware degradation

Date: 2026-05-28
Status: approved (design), pending implementation plan

## Goal
Make `contexthub` the single home for all multi-agent / cross-agent
orchestration, and make every multi-agent skill run with however many of
{Claude, codex, agy} are actually usable — degrading gracefully instead of
assuming all three exist. `codex` and `agy` remain single-agent bridges.
This is a deliberate clean break: the `forge` and `triage` plugins are
removed, with no backward-compatible alias shims.

## Target structure
`contexthub` ends with **9 skills**: `spec, plan, tdd, review, verify,
debug, ship` (former forge phases), `triage` (former `triage:grade`), and
`converge` (unchanged).

- `plugins/forge/skills/*` → `plugins/contexthub/skills/*`.
- `plugins/triage/skills/grade` → `plugins/contexthub/skills/triage`
  (frontmatter `name: grade` → `name: triage`; description prefix
  `(context-hub:grade)` → `(context-hub:triage)`).
- Scripts move into `plugins/contexthub/scripts/`. **Renamed**:
  `forge-write.mjs` → `phase-write.mjs`; `triage-write.mjs` keeps its name;
  `grade/references/difficulty-heuristics.md` →
  `contexthub/skills/triage/references/difficulty-heuristics.md`.
- Artifact dir renamed: `docs/carefully-crafted-plugins/forge/<phase>/` →
  `docs/carefully-crafted-plugins/lifecycle/<phase>/`; `.gitignore` updated
  to ignore `lifecycle/` (and `triage/`) instead of `forge/`.
- `plugins/forge` and `plugins/triage` directories deleted.

## Agent detection & degradation (core new behavior)
New module `plugins/contexthub/scripts/agent-availability.mjs`:

- **Hybrid detection** — `command -v <bin>` + `<bin> --version` only (fast,
  no network, no hang). Runs with closed stdin and a short timeout that
  kills the child. Emits JSON:
  `{ claude: true, codex: bool, agy: bool, count: N, externalCount: M }`
  where `count` = total usable agents **including Claude** (1–3) and
  `externalCount` = codex + agy available (0–2).
- Usable as both a CLI (prints the JSON, stable exit code even when agents
  are missing) and an import (returns the object, prints nothing). Output is
  valid JSON even on probe error/timeout.
- **Lazy auth** — detection does NOT verify login. If a delegated call later
  returns an auth error, the calling skill drops that agent, prints the
  degraded note, and continues the phase with the reduced set.

Each multi-agent skill gains a **Step 0** that runs the detector, plus
explicit role-reassignment rules:

- `review` — 3: Claude (in-context) + codex (fresh eyes) + agy (repo scan);
  no codex → Claude + agy; no agy → Claude + codex; neither → Claude solo +
  note.
- `converge` — 3: full Delphi debate; 2: a *labeled* two-way debate
  (Claude + one agent); 1: a direct Claude answer with a "no debate
  possible — install/log into codex or agy" note.
- `debug` — Claude hypothesis + codex:reason (if codex) + agy:longctx (if
  agy); each external leg skipped with a note when its agent is absent.
- `verify` — tests always run; codex:playwright only if codex present;
  agy:longctx blast-radius scan only if agy present.
- `plan` — Claude draft + triage grade (always, in-Claude) + codex:reason
  stress-test (if codex) + agy:longctx coverage (if agy).
- `tdd` — Claude implements; delegates stuck subproblems to codex:reason
  only if codex present.
- `triage` — only proposes routes to agents detected as available; never
  suggests `/codex:*` when codex is absent.
- `spec`, `ship` — Claude-led; optional `contexthub:converge` (which itself
  degrades per the rule above).

**Degraded/solo warning** — one line, e.g. *"Ran review with 2 agents
(Claude + agy). Install or log into codex for fuller cross-checks."*

## Naming, versions, migration
- Breaking removal of two plugins → **contexthub 3.0.1 → 4.0.0** and
  **marketplace 4.0.1 → 5.0.0**. `codex` / `agy` versions unchanged.
- README + website (`index.html`): a 3-plugin install block, the full
  `contexthub:*` command set (lifecycle + triage + converge), and messaging
  that **contexthub works solo — codex/agy are optional collaborators**,
  not hard requirements.
- `triage` stays a standalone skill but `plan` continues to auto-invoke it
  at its first step (as `forge:plan` does today).
- **Release**: tagged on the marketplace version, i.e. `v5.0.0` (prior
  releases tagged `v2.0.0`, `v4.0.1` off `metadata.version`). The actual
  tag/push/GitHub-release is a user-gated action at ship time, not
  automatic.

## Testing & quality gates
- New `tests/unit/agent-availability.test.mjs` — temp-bin PATH isolation;
  asserts reports for 0/1/2 external agents and probe-timeout handling.
- Rename/update `tests/unit/forge-write.test.mjs` → `phase-write.test.mjs`
  and update `triage-write.test.mjs` for the new script paths/names.
- `tools/lint-skill.mjs` discovers contexthub's 9 skills with 0 errors;
  `tools/eval-check.mjs` validates moved `evals/evals.json` (rewrite any
  `grade` / `/triage:grade` strings inside them); `node --test` green.
- Confirm 9 unique names within contexthub; `contexthub:review` coexisting
  with `codex:review` is allowed (cross-plugin reuse passes the lint).

## Edge cases
- Claude-only (0 external): every skill runs solo + note; converge collapses
  to a direct answer.
- One external agent: two-agent flow; missing role reassigned to the
  available agent or Claude.
- CLI present but logged out: detected as available, then dropped on the
  first auth failure (lazy path) with the degraded note.
- Probe slow/hangs: short timeout → treated as unavailable, never blocks.
- PATH contains a non-executable / shim / stale binary named codex/agy:
  `--version` failing → treat as unavailable.
- Skill body growth from Step 0 + degradation text: keep each `SKILL.md`
  body ≤ 250 lines; move overflow into `references/`.

## Build sequence (codex-reviewed; ordered so the suite never stays red and
reference cleanup precedes deletion)
1. Build `agent-availability.mjs` + its test (test-first).
2. Move forge skills + `phase-write.mjs`; rewrite `/forge:*` →
   `/contexthub:*` in bodies; update the renamed write-script test.
3. Move `grade` → `triage` (+ script, references, and eval strings); update
   its test.
4. Bake Step 0 + degradation into the multi-agent skills (respect the
   250-line body cap; overflow → `references/`).
5. Repo-wide grep sweep (covering for the agy scan that could not run), fix
   the SessionStart hook and any `${CLAUDE_PLUGIN_ROOT}` path assumptions,
   **then** delete `plugins/forge` and `plugins/triage`.
6. Update `marketplace.json` (3 plugins, version bumps, refreshed contexthub
   description) + README + `index.html`; browser-verify no stale commands.
7. Pre-release gates: lint + eval-check + `node --test` all green; JSON
   validity of `marketplace.json` + all `plugin.json`; grep confirms zero
   stale `forge` / `triage` references outside gitignored artifacts; browser
   preview of the site shows no stale commands.
8. Release (user-gated): commit `release: v5.0.0`; tag `v5.0.0`; push branch
   + tag; `gh release create v5.0.0` with notes summarizing the
   consolidation, the breaking removal of `forge`/`triage`, and the new
   agent-aware degradation. Pause for explicit user go-ahead before the
   tag/push/release, per the project's release convention.

## Non-goals
- No `forge:*` / `triage:*` alias shims (clean break).
- No change to what each phase does conceptually — only namespace and
  agent-adaptivity change.
- No auto-installing or auto-login of missing agents (detection only).
- No changes to the `codex` / `agy` single-agent bridge skills.

## Open questions
- Exact non-interactive auth-error signature per agent for the lazy-auth
  drop (codex exit code / stderr pattern; agy equivalent) — resolve during
  implementation against the real CLIs.
