---
name: setup
description: (context-hub:setup) Optional — copy the Codex bridge's editable default constraint/output-format files into this repo, verify the Codex CLI install, and update .gitignore. Runs only on explicit invocation; no Codex skill scaffolds or mutates the repo automatically. Slash-command only: invoke as /codex:setup.
disable-model-invocation: true
---

# Codex Bridge Setup

This skill runs only when the user invokes `/codex:setup` explicitly — it
never auto-triggers and no other Codex skill calls it. The `exec`,
`imagegen`, `reason`, `resume`, and `review` skills reference the packaged
defaults directly under `${CLAUDE_PLUGIN_ROOT}/reference/defaults/` when no
project-local file exists; none of them scaffold anything into the repo.
Run `/codex:setup` when you want your own editable copies of those defaults
in the project (so you can customize them), or to re-verify the Codex CLI
install.

## What it does

1. Checks `codex --version`. If absent, prints install instructions (does not auto-install).
2. Copies the packaged defaults into the user's repo (only files that don't
   already exist there — never overwrites):
   - `docs/carefully-crafted-plugins/constraints/` with `code-style.md`, `design-system.md`, `security.md`
   - `docs/carefully-crafted-plugins/output-formats/` with `image-icon-256.md`, `image-hero-1024x768.md`, `raw-prose.md`, `raw-code.md`, `code-review.md`
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
