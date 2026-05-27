# Changelog

All notable changes to this marketplace. The marketplace version
(in `.claude-plugin/marketplace.json` `metadata.version`) bumps for
any change that ships a new plugin, removes a plugin, or changes
default behavior of an existing plugin in a user-visible way.
Individual plugin versions follow SemVer per plugin.

## 4.0.0 — multi-agent lifecycle

Marketplace bumped to 4.0.0; two new plugins added.

**New plugins**

- **`forge`** (1.0.0) — the multi-agent software lifecycle. Seven
  phases that route every step to the strongest specialist:
  `forge:spec`, `forge:plan`, `forge:tdd`, `forge:review`,
  `forge:verify`, `forge:debug`, `forge:ship`. Each phase writes an
  audit artifact to `docs/carefully-crafted-plugins/forge/<phase>/`.
- **`triage`** (1.0.0) — token-efficiency primitive. `/triage:grade`
  decomposes a task and grades each piece low/medium/hard, writing a
  routing plan that downstream specialists read to set effort.

**Existing plugin changes**

- **`codex` 3.0.0 → 3.1.1**
  - 3.1.0: default reasoning effort lowered from `xhigh` to `medium`.
    `codex:reason` opts back into `xhigh` explicitly; `codex:review`
    opts into `high`. Other skills inherit the new medium floor.
    Direct callers can still override with `--reasoning-effort` or
    `CODEX_REASONING_EFFORT`.
  - 3.1.1: `codex-invoke.mjs` now rejects empty `--spec-path ""` and
    `--spec-path <directory>` instead of silently building a prompt
    that points at cwd. Surfaced by end-to-end testing pre-release.

**Infrastructure**

- `quality-bar.md` — eight gates every skill must clear.
- `tools/lint-skill.mjs` — CI lint that enforces gates 1–3, 7 (context
  budget, naming, description structure, evals presence).
- `tools/eval-check.mjs` — structural validator for every
  `evals/evals.json`.
- `tests/unit/` — 53 tests covering all bridge scripts, the lint, and
  eval-check.

## 3.0.0 — naming + pushy descriptions

Marketplace bumped to 3.0.0. Skill names tightened to remove
cross-plugin collisions; all descriptions rewritten to the pushy
template.

**Skill renames** (collision fix — both `codex` and `agy` had a skill
called `image`, etc.)

| Old | New |
|---|---|
| `/codex:image` | `/codex:imagegen` |
| `/codex:browser` | `/codex:playwright` |
| `/agy:image` | `/agy:nanobanana` |
| `/agy:video` | `/agy:veo` |
| `/agy:longcontext` | `/agy:longctx` |

`/codex:reason`, `/codex:review`, `/codex:exec`, `/codex:resume`,
`/codex:setup`, `/agy:exec`, and `/contexthub:converge` are unchanged.

**Description changes**

Every skill description rewritten to:
- Include trigger keywords ("Use whenever the user wants ...")
- End with a closing claim — "Default {category} path in this
  marketplace." for auto-trigger, or "Slash-command only" for
  explicit-only

**Body changes**

- `contexthub:converge` body split from 223 lines to 163 lines, with
  verbose prompt templates moved to `references/`.

## 2.1.0 — Codex defaults

- Codex bridge default model/effort/verbosity set to best/highest/lowest
- Bumped codex to 2.1.0, agy to 2.0.1, marketplace to 2.1.0

## 2.0.0 — Capability restructure + contexthub

- Restructured around capabilities (vs the prior agent-named layout)
- Added `contexthub` plugin (4-phase multi-agent debate via
  `/contexthub:converge`)
- Renamed `converge` plugin to `contexthub` (skill: debate → converge)

## Release process

Before tagging a release:

1. Run `node --test tests/unit/*.test.mjs` — all green.
2. Run `node tools/lint-skill.mjs` — 0 errors.
3. Run `node tools/eval-check.mjs` — 0 errors.
4. Decide the bump (SemVer):
   - **patch** — bug fixes, doc tweaks, internal refactors
   - **minor** — new skill, new plugin, new backward-compatible behavior
   - **major** — renamed skills/plugins, removed features, default
     behavior changes that users will notice
5. Update versions in:
   - `.claude-plugin/marketplace.json` (`metadata.version` + each
     plugin's `version`)
   - Each affected `plugins/<name>/.claude-plugin/plugin.json`
6. Add a new entry to this CHANGELOG.md following the format above.
7. Commit with `release: v<version>`.
8. Tag: `git tag v<version> && git push --tags`.
9. Update GitHub release notes from this CHANGELOG entry.
