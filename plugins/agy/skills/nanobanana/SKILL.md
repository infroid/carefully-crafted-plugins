---
name: nanobanana
description: (context-hub:nanobanana) Generate and manipulate images with Google's Nano Banana (Gemini image models) — text-to-image plus sequential story/multi-scene generation, natural-language editing, photo restoration, app icons, seamless patterns, and technical diagrams. Routes to the nanobanana MCP server's structured tools when wired into Claude Code, and falls back to agy-direct generation for simple one-offs. For default image generation prefer /codex:imagegen; reach for this for Google's image style or the story/edit/restore/icon/pattern/diagram capabilities. Setup is explicit via /agy:setup. Slash-command only: invoke as /agy:nanobanana <description>.
argument-hint: <image, or story/edit/restore/icon/pattern/diagram request>
---

# Image Generation & Editing via Nano Banana

Two backends produce images here; this skill picks the best **available** one
and never sets anything up implicitly.

- **MCP backend (preferred)** — the `nanobanana` Gemini-CLI extension's MCP
  server wired into Claude Code. Gives seven structured tools: `generate_image`,
  `generate_story` (sequential/multi-scene), `edit_image`, `restore_image`,
  `generate_icon`, `generate_pattern`, `generate_diagram`. Full parameter
  control; artifacts go to a `nanobanana-output/` dir (relative to the server's
  launch dir — report the absolute path the tool returns, not an assumed one).
  Requires one-time, explicit setup (`/agy:setup`) — a `NANOBANANA_API_KEY` and
  a server build.
- **agy-direct fallback** — `agy -p "generate an image…"`. Simple text→image
  only; no story/edit/icon/etc. Antigravity saves into its own sandbox and
  ignores requested paths, so we retrieve the file with `--collect`.

Capability/parameter detail: [references/capabilities.md](references/capabilities.md).
Setup detail: [references/setup.md](references/setup.md).

## Your input

`/agy:nanobanana <description>` arrives as `$ARGUMENTS` — the visual brief.
Note which capability it implies (a plain image, a multi-scene **story**, an
**edit** of an existing file, a **diagram**, an **icon**, etc.).

## Step 0: Detect the backend

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/nanobanana-detect.mjs
```

Read the JSON: `backend` is `"mcp"`, `"agy"`, or `"none"`; `mcpReady` means the
server is built and the key is set (it may still need loading into the session).

## Step 1: Route

**A. nanobanana MCP tools are available in this session** (you can see tools
like `generate_image` / `generate_story`, or `mcp__*nanobanana*`):
call the tool that matches the intent and pass parameters from
[capabilities.md](references/capabilities.md). Examples:
- multi-scene story → `generate_story` (`steps`, `style:"consistent"`, `layout`)
- edit an existing image → `edit_image` (`prompt`, `file`)
- icon set → `generate_icon` (`sizes`, `background:"transparent"`)
- diagram → `generate_diagram` (`type`, `style`)
For the Pro model, note `export NANOBANANA_MODEL=gemini-3-pro-image-preview`.

**B. `mcpReady` is true but the tools are NOT in this session yet:** the backend
is configured but unloaded. Tell the user to run `/mcp` (or `/reload-plugins`,
or restart Claude Code) so the `nanobanana` server connects, then retry. Do not
fall back silently — the structured tools are what they set up.

**C. Backend is `none`/`agy` and the request is a simple single image:** use the
agy-direct fallback. Pick an output dir the user wants (default: their cwd):

```bash
AGY_TIMEOUT_SEC=300 node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs \
  --prompt "Generate an image: <brief>. Save it as a PNG." \
  --collect "<output-dir>"
```

`--collect` copies the artifact out of Antigravity's sandbox into `<output-dir>`
and prints `collected: <path>`.

**D. The request needs a structured capability (story/edit/restore/icon/pattern/
diagram) but the MCP backend isn't ready:** do NOT install anything silently.
Explain that this capability lives in the nanobanana MCP backend and offer to
walk through setup together: **`/agy:setup`**. agy-direct cannot do these
reliably. Proceed only with the user's go-ahead.

## Step 2: Report

State the saved path(s) and any visual choices. For MCP tools, report the
absolute paths from `generatedFiles` verbatim (don't assume `./nanobanana-output/`).
For the agy fallback, report the `collected:` path (and
note it was simple generation via agy-direct, not the structured tools). If a
backend declined or fell back to non-image output, say so plainly — never claim
an image was produced when it wasn't. Offer to iterate (e.g. `edit_image` on the
result, or re-run with a different style/model).
