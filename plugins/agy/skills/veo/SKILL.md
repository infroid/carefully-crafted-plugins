---
name: veo
description: Generate short videos via Veo (Google DeepMind's video model) through Antigravity CLI. Use whenever the user wants video, animation, motion clips, product-demo footage, or any moving visual asset — even if they don't name Veo or Google. The only video-producing skill in this marketplace. Slow and credits-heavy; always pre-flight confirm before running.
argument-hint: <video description>
---

# Video Generation via Antigravity (Veo)

You are about to delegate video generation to Antigravity CLI, which routes
to **Veo** (Google DeepMind's video model). Claude Code cannot generate
video at all — this skill is the only video-producing surface in this
marketplace.

Video generation is **slow and credits-intensive**. Treat each invocation as
a real cost; do not iterate without confirming with the user first.

## Your input

When invoked as `/agy:veo <description>`, the user's text arrives as
`$ARGUMENTS` — that is the video brief. Describe scene, motion, duration,
and style. A single shot or a short sequence is far easier to get right than
a long multi-cut clip.

## Step 1: Pre-flight clarification — MANDATORY

Before invoking, confirm with the user:

1. Subject, motion, and intended duration are clear enough to act on.
2. The user accepts that this consumes Veo credits and may take several
   minutes.
3. Output path and format (typically MP4).

## Step 2: Invoke

```bash
AGY_TIMEOUT_SEC=900 node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs \
  --prompt "Generate a video using Veo: <description>. Save as <path/clip.mp4>."
```

The 900s (15 minute) timeout accommodates video-generation runtime.

## Step 3: Report

Relay where Veo saved the video, surface any decisions it documented, and
offer to refine. If Antigravity declined the request or returned a non-video
output (e.g. it routed to image generation instead, or produced a description
rather than a file), say so explicitly — do not pretend a video was produced.
