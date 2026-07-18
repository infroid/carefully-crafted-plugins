---
name: nanobanana
description: Generate a raster image through the authenticated Antigravity CLI and collect the resulting local artifact. Use when the user explicitly wants Google's Nano Banana image style and accepts direct Antigravity generation without the former structured MCP backend. Slash-command only.
argument-hint: <image prompt>
disable-model-invocation: true
---

# Nano Banana: Direct Image Generation

This skill hands a text-to-image prompt to the authenticated Antigravity CLI
(`agy`) and retrieves the resulting file. It is plain text-to-image only —
there is no structured MCP backend behind it, so there is no story/multi-scene
generation, natural-language editing, photo restoration, icon-set, pattern, or
diagram tooling here. For those, or for a first-choice default image
generator, prefer `/codex:imagegen`. Reach for this specifically when the
user wants Google's Nano Banana image style for a single image.

## Your input

`/agy:nanobanana <description>` arrives as `$ARGUMENTS` — the visual brief.

## Step 0: Confirm a destination

Antigravity writes generated images into its own sandbox and ignores any save
path stated in the prompt — the only way to land the file where the user
wants it is to collect it afterward. Ask for (or infer from context) an
explicit output directory before invoking the CLI; do not hardcode a default
like the current working directory unless the user has already indicated
that's where they want it.

## Step 1: Generate and collect

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs \
  --prompt "Generate one image from this brief: $ARGUMENTS" \
  --collect "<user-approved-output-directory>" \
  --require-artifact
```

`--collect` copies the artifact out of Antigravity's sandbox into the
approved directory and prints `collected: <path>` for each file.
`--require-artifact` turns a run that produced no retrievable image into a
clear failure (exit 1) instead of a silent no-op.

## Step 2: Report

If the command succeeds, state the `collected:` path(s) verbatim — don't
assume or reformat them. If it exits non-zero, say plainly that image
generation did not produce a usable file (and why, from the error output) —
never claim an image was produced when it wasn't. Offer to retry with an
adjusted prompt.
