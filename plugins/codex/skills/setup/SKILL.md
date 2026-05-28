---
name: setup
description: (context-hub:setup) Optional — re-scaffold the Codex bridge in this repo (refresh starter constraint/output-format files, verify the Codex CLI install, update .gitignore). Other Codex skills auto-run setup on first use; /codex:setup is only needed to refresh or re-verify. Slash-command only.
---

# Codex Bridge Setup

This skill runs only when the user invokes `/codex:setup` explicitly. It is
**optional**: the `imagegen`, `reason`, `playwright`, and `review` skills
automatically run a quick one-time setup (`setup.mjs --ensure`) the first
time they are used in a repo. Use `/codex:setup` to re-scaffold, refresh
starter files, or check the Codex CLI install.

## What it does

1. Checks `codex --version`. If absent, prints install instructions (does not auto-install).
2. Idempotently scaffolds in the user's repo:
   - `docs/carefully-crafted-plugins/constraints/` with `code-style.md`, `design-system.md`, `security.md`
   - `docs/carefully-crafted-plugins/output-formats/` with `image-icon-256.md`, `image-hero-1024x768.md`, `raw-prose.md`, `raw-code.md`
   - `docs/carefully-crafted-plugins/handoffs/` (empty)
   - `docs/carefully-crafted-plugins/output/images/` (empty)
3. Appends to `.gitignore` (if not present): `docs/carefully-crafted-plugins/handoffs/` and `docs/carefully-crafted-plugins/output/`

Existing files are never overwritten.

## How to run

Invoke the single command that does it all:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs
```

The script prints a summary of what was created, what was skipped (already existed), and any warnings (e.g. codex CLI not installed). Relay the summary to the user.

## What to tell the user after running

- Edit the starter files in `docs/carefully-crafted-plugins/constraints/` to encode your project's standards (these are referenced by every handoff).
- Edit the starter files in `docs/carefully-crafted-plugins/output-formats/` to define expected output shapes per use case.
- Both directories grow over time as you encounter new use cases.
- If `codex` was not detected, install it: `npm install -g @openai/codex` or `brew install codex`, then run `codex auth`.
