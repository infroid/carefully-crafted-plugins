---
name: setup
description: (context-hub:setup) Explicitly set up the Antigravity (agy) bridge's Nano Banana image backend — verify the gemini CLI, install the gemini-cli nanobanana extension, build its MCP server, and wire it into Claude Code so /agy:nanobanana can call the structured tools (story, edit, restore, icon, pattern, diagram). Nothing is installed or changed without your explicit go-ahead at each step, and your NANOBANANA_API_KEY is referenced by env expansion — never written to disk. Use when wiring up or repairing Nano Banana's full capabilities. Slash-command only: invoke as /agy:setup.
---

# Antigravity / Nano Banana Setup

This skill runs **only** when the user invokes `/agy:setup`. It never auto-runs.
Every state-changing step below is gated on the user's explicit go-ahead — walk
them through it one consent at a time. The engine is read-only by default; each
mutation needs its own flag.

The goal: make the **MCP backend** usable so `/agy:nanobanana` gets the seven
structured tools (`generate_story`, `edit_image`, `generate_icon`, …) instead of
only agy-direct simple generation. Deep reference: [../nanobanana/references/setup.md](../nanobanana/references/setup.md).

## Step 0: Read-only status

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/nanobanana-setup.mjs --status
```

Relay the report. Only the steps below that are marked missing need doing. If
everything is present, stop — just have the user run `/mcp` to confirm.

## Step 1: Gemini CLI (prerequisite)

If `gemini CLI: no`, the extension can't be installed. Give install instructions
and stop here (do **not** auto-install):
`npm install -g @google/gemini-cli` (or `brew install gemini-cli`), then `gemini` once to sign in.

## Step 2: Install the extension (ask first)

Confirm with the user, then:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/nanobanana-setup.mjs --install-extension
```

This runs `gemini extensions install <repo> --consent`, cloning the official
`gemini-cli-extensions/nanobanana` into `~/.gemini/extensions/`. Preview the
exact command first with `--install-extension --dry-run` if the user wants.

## Step 3: Build the MCP server (ask first)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/nanobanana-setup.mjs --build
```

Runs `npm install` in the extension's `mcp-server/` (its `prepare` script builds
`dist/index.js`). Idempotent — a no-op if already built.

## Step 4: API key (the user's hands, not yours)

The backend needs a Gemini API key from https://aistudio.google.com/apikey.
**Never** ask the user to paste it to you, and never put it in a file. Have them
export it in their shell so the wired config can reference it:

```bash
export NANOBANANA_API_KEY="<their key>"   # add to ~/.zshrc to persist
```

Re-run `--status` to confirm `NANOBANANA_API_KEY: set`.

## Step 5: Wire into Claude Code (ask scope first)

Ask the user which scope they want, then run it:

```bash
# project scope → merges <cwd>/.mcp.json (committable; holds no secret)
node ${CLAUDE_PLUGIN_ROOT}/scripts/nanobanana-setup.mjs --wire --scope project

# user scope → prints the `claude mcp add` command for them to run themselves
node ${CLAUDE_PLUGIN_ROOT}/scripts/nanobanana-setup.mjs --wire --scope user
```

The key is wired as `${NANOBANANA_API_KEY}` (env expansion) — it is never stored
in the config. Preview with `--wire --scope project --dry-run` first if asked.

## Step 6: Load and verify

Tell the user to run `/mcp` (or `/reload-plugins`, or restart Claude Code) so the
`nanobanana` server connects. `/mcp` should list it with its tools. Then
`/agy:nanobanana a three-panel story of a seed growing into a tree` exercises
`generate_story`. If the tools don't appear, re-run `--status` and check the
`nextSteps`.

## Note

`.mcp.json` carries no secret (only the `${...}` reference), so committing it is
safe — but the user may prefer user-scope to keep it off the repo. Consider
adding `nanobanana-output/` to `.gitignore` so generated images aren't committed.
