---
name: imagegen
description: (context-hub:imagegen) Generate raster images via OpenAI gpt-image-2 (Codex CLI's built-in $imagegen). Use whenever the user wants images, icons, logos, illustrations, mockups, hero graphics, screenshots-as-output, or any visual asset — even if they don't name OpenAI, Codex, or image generation. Default image-generation path in this marketplace.
argument-hint: <image generation prompt>
---

# Codex Image Generation

You are about to delegate an image-generation task to Codex's built-in
`$imagegen` skill (gpt-image-2). Claude Code cannot natively produce raster
images.

We use Codex's image-generation capability **as-is**. Codex's skill knows how
to call `gpt-image-2` and where to write the output file. Our job is to give
it a clear, evocative visual description that respects the user's design
language — then get out of the way.

## Your input

When invoked as `/codex:imagegen <prompt>`, the user's text arrives as
`$ARGUMENTS` — treat it as the visual brief that becomes the **Task** in
Step 1. When this skill auto-triggers from conversation instead, derive the
same brief from the surrounding context.

## Step 1: Draft sections 1–4 of the handoff spec

- **Task slug**: short kebab-case (e.g. `todo-app-icon`).
- **Role**: `Image generator using Codex $imagegen (gpt-image-2)`.
- **Task**: a natural, visual description of the image — subject, mood,
  composition, what feeling it should evoke. Write the way a designer
  briefs an illustrator, not the way a programmer specifies an API. Be
  evocative; do not over-constrain. Give the model room to make choices.
- **How**: almost always `Delegate, figure it out.` for image tasks. The
  image model handles composition.
- **Constraints**: relevant files from `docs/carefully-crafted-plugins/constraints/`
  (typically `design-system.md` — palette and tone guidance, not strict
  rules). If the project has no such file, use the packaged default at
  `${CLAUDE_PLUGIN_ROOT}/reference/defaults/constraints/design-system.md` —
  never scaffold the project file yourself.
- **Output format**: relevant file from `docs/carefully-crafted-plugins/output-formats/`
  (defines dimensions, file type, where to save). If absent, use the
  packaged default at `${CLAUDE_PLUGIN_ROOT}/reference/defaults/output-formats/<file>.md`
  (e.g. `image-icon-256.md`, `image-hero-1024x768.md`).
- **Artifact path**: `docs/carefully-crafted-plugins/output/images/<YYYY-MM-DD>-<slug>.png`.

If a relevant superpowers spec exists in this session, pass its absolute
path as `--session-artifact`.

## Step 2: Pre-flight clarification — MANDATORY

Verify in this conversation:

1. Every constraint path resolves — either the project-local file or the
   packaged default under `${CLAUDE_PLUGIN_ROOT}/reference/defaults/` (always
   present, so this never blocks).
2. Same for the output-format path.
3. The visual brief is clear enough to act on. Ask the user only if
   something material is missing (e.g. "what mood?" or "what should the
   focal subject be?") — do NOT over-pre-flight with dozens of detail
   questions. The model can handle reasonable interpretation.

## Step 3: Invoke (with $imagegen)

Codex's `$imagegen` works best when the prompt is a direct visual
description. The `--imagegen` flag prepends the canonical activation:
`$imagegen Generate an image based on the following requirements:\n…`

```bash
SPEC_PATH=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/spec-builder.mjs \
  --task-slug "<slug>" \
  --role "Image generator using Codex \$imagegen (gpt-image-2)" \
  --task "<visual description>" \
  --how "Delegate, figure it out." \
  --constraints "<comma-separated abs paths>" \
  --output-format "<abs path>" \
  --artifact-path "docs/carefully-crafted-plugins/output/images/<date>-<slug>.png" \
  --clarifications "<Q&A summary or 'None'>")

CODEX_TIMEOUT_SEC=180 \
  node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs \
  --spec-path "$SPEC_PATH" \
  --imagegen \
  --sandbox workspace-write
```

`--sandbox workspace-write` is required so Codex can write the PNG to the
artifact path. The spec is written to disk for audit. Codex reads it, then
runs its `$imagegen` skill to produce the image.

### Iterating on an existing image

Pass the previous image as a reference:

```bash
CODEX_TIMEOUT_SEC=180 \
  node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs \
  --imagegen \
  --raw "<refinement description>" \
  --ref "docs/carefully-crafted-plugins/output/images/<previous>.png" \
  --sandbox workspace-write
```

## Step 4: Report

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/result-handler.mjs \
  --spec-path "$SPEC_PATH" \
  --type image
```

Then summarize for the user: artifact path, any visual choices Codex
documented, offer next steps (iterate with `--ref`, etc.). For sandbox
escalation and error handling, follow
`${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md`.
