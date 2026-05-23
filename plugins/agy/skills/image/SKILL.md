---
name: image
description: Generate raster images using Google's Nano Banana Pro (Imagen-class) model via Antigravity CLI — icons, illustrations, mockups, photos, hero images, UI assets. An alternative image-generation route to /codex:image (which uses OpenAI's gpt-image-2). Slash-command only so it does not compete with /codex:image for auto-triggers — pick this when you specifically want Google's image model.
argument-hint: <image description>
---

# Image Generation via Antigravity (Nano Banana Pro)

You are about to delegate raster image generation to Antigravity CLI, which
routes the request to **Nano Banana Pro** (Google DeepMind's image model).
Claude Code cannot natively produce raster images.

Two image bridges exist in this marketplace; pick deliberately:

- `/codex:image` — OpenAI's `gpt-image-2`, with the structured 5-section
  handoff, constraint/design-system files, and audit trail.
- `/agy:image` (this skill) — Google's Nano Banana Pro, light and direct.
  Reach for it when the user wants Google's image-model style, has Antigravity
  credentials configured, or is already in the Google ecosystem.

## Your input

When invoked as `/agy:image <description>`, the user's text arrives as
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
