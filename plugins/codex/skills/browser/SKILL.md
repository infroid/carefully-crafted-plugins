---
name: browser
description: Use for headless browser automation, web scraping, page screenshots, form filling, end-to-end test execution, or any task requiring a real Chromium runtime. Delegates to OpenAI Codex CLI which ships a Playwright skill.
---

# Codex Browser Delegation

You are about to delegate a browser task to Codex CLI (headless Playwright).

Note: Claude Code can also drive headless Chrome via the `claude-in-chrome` MCP. Prefer that for short, interactive browser tasks where you want to see results in your own context. Use this Codex delegation for:

- Longer scripted automation runs
- E2E test execution against a deployed site
- Bulk scraping where Codex's sandbox is preferable
- The user explicitly asked to delegate to Codex

Follow these four steps.

## Step 1: Draft sections 1–4 of the handoff spec

- **Task slug**: kebab-case (e.g. `scrape-product-list`).
- **Role**: `Headless browser automation agent`.
- **Task**: full description including target URL(s), what to extract or do, expected interaction sequence.
- **How**: numbered steps usually work better than `Delegate, figure it out.` for browser tasks — be specific about selectors and wait conditions if known.
- **Constraints**: relevant files from `docs/carefully-crafted-plugins/constraints/` (often `security.md` if the target involves auth).
- **Output format**: e.g. `raw-prose.md`, `raw-code.md`, or a custom output format you ask the user to define.
- **Artifact path**: `docs/carefully-crafted-plugins/output/<slug>.<ext>`.

## Step 2: Pre-flight clarification — MANDATORY

1. Verify constraint and output-format files exist.
2. Confirm target URL(s), auth handling (if any), and exact output shape with the user.
3. Confirm whether screenshots are needed and where they should land.

## Step 3: Invoke

```bash
SPEC_PATH=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/spec-builder.mjs \
  --task-slug "<slug>" \
  --role "Headless browser automation agent" \
  --task "<full task>" \
  --how "<steps>" \
  --constraints "<abs paths>" \
  --output-format "<abs path>" \
  --artifact-path "docs/carefully-crafted-plugins/output/<slug>.<ext>" \
  --clarifications "<summary>")

node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs --spec-path "$SPEC_PATH"
```

## Step 4: Report

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/result-handler.mjs \
  --spec-path "$SPEC_PATH" \
  --type text
```

Report artifact path and any non-obvious findings to the user.
