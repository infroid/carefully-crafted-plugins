# carefully-crafted-plugins v2.0.0 — release design

**Date:** 2026-05-23
**Status:** approved (brainstorm)
**Target version:** 2.0.0

## Goal

Ship 2.0.0 of the marketplace. Two things change visibly: the `converge`
plugin is renamed to `contexthub` (with its `debate` skill renamed to
`converge`), and the README + website are reorganized around *what you can
delegate* rather than *how the codex bridge works internally*. Everything
else is doc-sync and version-bump hygiene.

There are no live users to migrate. Write everything as if the reader has
just discovered the marketplace at 2.0.0; no "what changed since 1.x" copy.

## Scope

### In scope

1. Rename plugin `converge` → `contexthub`; rename skill `debate` →
   `converge`. New invocation is `/contexthub:converge <prompt>`.
2. Version-bump every manifest to 2.0.0.
3. Fix stale `raiaman15` URLs (correct owner is `infroid`).
4. Restructure README around capabilities.
5. Restructure the website's "Handoff" section into a capability-first
   section; update install panel and slash-command chips.
6. Add three minimal badges (Release, License, Stars) to the top of the
   README.
7. Tag `v2.0.0` and push.

### Out of scope

- Migration documentation, deprecation notices, "old command stops working"
  copy. No prior users → no migration story.
- A CHANGELOG file. (Skipped under fresh-users framing. Release notes can
  live in the GitHub Release if we choose to publish one.)
- New skills, new plugins, new features.
- Website visual redesign (typography, color, layout). Content changes only.

## Detailed changes

### 1. Plugin rename: `converge` → `contexthub`

Filesystem:

- `plugins/converge/` → `plugins/contexthub/`
- `plugins/contexthub/skills/debate/` → `plugins/contexthub/skills/converge/`
- The skill markdown file stays named `SKILL.md`.

Manifests:

- `plugins/contexthub/.claude-plugin/plugin.json`
  - `name`: `"converge"` → `"contexthub"`
  - `description`: update to reference the new identifier
  - `keywords`: keep relevant ones, add `"contexthub"`
- `plugins/contexthub/skills/converge/SKILL.md` frontmatter
  - `name`: `debate` → `converge`
  - `description`: replace user-facing references to `/converge:debate` with
    `/contexthub:converge`. Inside the body, every place that says "debate"
    as a noun for the operation stays semantic (it *is* a debate); only the
    skill/command identifiers change.
- `.claude-plugin/marketplace.json`
  - The third plugin entry: `name` → `"contexthub"`, `source` →
    `"./plugins/contexthub"`, `description` updated, `version` → `2.0.0`.

New invocation: `/contexthub:converge <prompt>`. All references in the
README, the website, and other SKILL.md files that mention the old command
get updated.

### 2. Version bumps — everything to 2.0.0

| File | Field | Old | New |
|---|---|---|---|
| `.claude-plugin/marketplace.json` | `metadata.version` | `1.4.0` | `2.0.0` |
| `.claude-plugin/marketplace.json` | each `plugins[*].version` | `1.0.0`/`1.1.0` | `2.0.0` |
| `plugins/codex/.claude-plugin/plugin.json` | `version` | `1.1.0` | `2.0.0` |
| `plugins/agy/.claude-plugin/plugin.json` | `version` | `1.1.0` | `2.0.0` |
| `plugins/contexthub/.claude-plugin/plugin.json` | `version` | `1.0.0` | `2.0.0` |

### 3. Fix stale URLs

Three `plugin.json` `homepage` fields point at
`https://github.com/raiaman15/carefully-crafted-plugins`. Repo actually lives
at `https://github.com/infroid/carefully-crafted-plugins`. Update all three.

Two website locations also need fixing:

- Nav GitHub link (`<a class="nav__github" href="...">GitHub</a>`).
- Install panel marketplace add (`/plugin marketplace add <url>`).

The footer's `https://github.com/raiaman15` (the author's profile) stays —
that's a personal profile link, not a repo link.

### 4. README v2 — capability-first

New structure, top to bottom:

1. **Badges row** — three minimal badges via shields.io:
   - Release: `https://img.shields.io/github/v/release/infroid/carefully-crafted-plugins`
   - License: `https://img.shields.io/github/license/infroid/carefully-crafted-plugins`
   - Stars: `https://img.shields.io/github/stars/infroid/carefully-crafted-plugins`
2. **Title + one-paragraph intro** — three bridges in one Claude Code
   session: OpenAI Codex, Google Antigravity, multi-agent debate.
3. **What you can delegate** — three subsections, one per bridge, each a
   short paragraph plus a code block of example invocations. The
   subsections are organized by *capability*, not by mechanism:
   - `codex` — image, hard reasoning, code review, browser, raw exec,
     session resume.
   - `agy` — long-context analysis, image, video, raw exec.
   - `contexthub` — multi-agent debate.
4. **Install** — all three plugin install commands (after marketplace add).
5. **Requirements** — Codex CLI, Antigravity CLI, Node ≥ 20.
6. **Layout** — updated directory tree reflecting the rename.
7. **How the codex bridge works** — compressed (≤ 12 lines) explanation of
   the 5-section spec. Demoted from the lead position; kept because it's
   genuinely useful background for codex power users.
8. **Run the tests** — kept.
9. **License** — kept.

### 5. Website v2 — capability-first

Changes to `index.html`:

- **Hero copy** — light reframe: still "Bridge work to the right coding
  agent" or similar, but the lede sentence mentions all three bridges (or
  the spirit of "different engines for different tasks") rather than just
  Codex + Antigravity. The primary CTA stays the install jump-link; its
  button label changes from "Install codex" to something neutral like
  "Install" or "Get started".
- **Bridges section** — keep the three-card layout. Update chips:
  - codex chips: add `/codex:review` and `/codex:resume`. Skip
    `/codex:setup` (maintenance command, not a primary feature).
  - contexthub card: rename the bridge from `converge` to `contexthub`,
    rename the chip to `/contexthub:converge`, update the body text
    accordingly.
- **"Handoff" section** → replaced with a **"Capabilities"** section. Same
  vertical real estate, but the content becomes three columns/cards (one
  per bridge) listing what each bridge enables. The 5-section spec diagram
  is removed from the page. This is the largest single content change.
- **Install panel** — four command boxes:
  1. `/plugin marketplace add <correct URL>`
  2. `/plugin install codex@carefully-crafted-plugins`
  3. `/plugin install agy@carefully-crafted-plugins`
  4. `/plugin install contexthub@carefully-crafted-plugins`
  The section heading changes from "Three commands in Claude Code" to
  "Four commands in Claude Code" (or similar phrasing). The supporting
  copy frames all three plugins as the default install.
- **Stale URLs** — fixed in nav + install panel as in §3.
- **Footer** — unchanged except for any link adjustments.

The HTML/CSS structure is reused wherever possible. No design-system
overhaul; existing classes and tokens are repurposed.

### 6. Release artifacts

- **Commits** — a small number of focused commits is fine; one large commit
  is also acceptable since this is a coordinated release. The
  implementation plan will decide the granularity.
- **Tag** — annotated tag `v2.0.0` on the resulting commit, pushed to
  origin.
- **GitHub Release** — optional. If we publish one, the body is a short
  capability-first announcement (no migration copy).

## Acceptance criteria

The release is done when all of these are true:

1. `plugins/contexthub/` exists; `plugins/converge/` does not.
2. `/contexthub:converge "test prompt"` resolves to the correct skill in a
   freshly installed marketplace. The old `/converge:debate` does not
   resolve (and we do not document a fallback).
3. Every manifest version is `2.0.0` (marketplace.json metadata,
   marketplace.json per-plugin entries, each `plugin.json`).
4. No file in the repository contains `raiaman15/carefully-crafted-plugins`.
   Only `infroid/carefully-crafted-plugins`.
5. README opens with three working shields.io badges, then the capability-
   first structure described in §4.
6. The website's "Handoff" section is gone; in its place is a
   "Capabilities" section with three per-bridge cards.
7. The website's install panel installs all three plugins from the correct
   marketplace URL.
8. `git tag` lists `v2.0.0` and the tag is pushed to origin.
9. All existing unit tests still pass (`node --test tests/unit/*.test.mjs`).

## Open questions

None at spec-approval time.

## References

- Current README: `README.md`
- Current website: `index.html`
- Plugin manifests: `plugins/*/.claude-plugin/plugin.json`
- Marketplace manifest: `.claude-plugin/marketplace.json`
- Existing tests: `tests/unit/*.test.mjs`
