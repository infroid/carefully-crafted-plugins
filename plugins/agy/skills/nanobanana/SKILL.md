---
name: nanobanana
description: (context-hub:nanobanana) Generate raster images via Google's Nano Banana Pro (Antigravity CLI). Slash-command only — pick this when the user explicitly asks for Google's image model, Nano Banana, or lives in the Google ecosystem. For default image generation prefer /codex:imagegen.
argument-hint: <image description>
---

# Image Generation via Antigravity (Nano Banana Pro)

You are about to delegate raster image generation to Antigravity CLI, which
routes the request to **Nano Banana Pro** (Google DeepMind's image model).
Claude Code cannot natively produce raster images.

Two image bridges exist in this marketplace; pick deliberately:

- `/codex:imagegen` — OpenAI's `gpt-image-2` (default), with the structured
  5-section handoff, constraint/design-system files, and audit trail.
- `/agy:nanobanana` (this skill) — Google's Nano Banana Pro, light and direct.
  Reach for it when the user wants Google's image-model style, has Antigravity
  credentials configured, or is already in the Google ecosystem.

## Your input

When invoked as `/agy:nanobanana <description>`, the user's text arrives as
`$ARGUMENTS` — that is the visual brief. Write it the way a designer briefs
an illustrator: subject, mood, composition, what it should evoke.

## Step 1: Frame the request

Make the intent unambiguous to Antigravity ("Generate an image of …",
"Create a 256×256 PNG icon for …"), and include an output-path preference:
the exact path, filename, dimensions, and format if any of them matter.
Antigravity will pick the artifact location otherwise.

## Step 2: Invoke

```bash
AGY_TIMEOUT_SEC=300 node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs \
  --prompt "Generate an image: <description>. Save as <path/filename.png>."
```

The 300s timeout accommodates image-generation runtime.

## Step 3: Report

Relay where Antigravity saved the image, mention any visual choices it
documented, and offer to iterate. If Antigravity declined or fell back to a
non-image output, say so plainly — do not pretend an image was produced.
