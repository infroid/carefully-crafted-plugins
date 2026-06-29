# Nano Banana capability reference

The `nanobanana` Gemini CLI extension ships an **MCP server** exposing seven
structured image tools plus a natural-language router. When the extension's MCP
server is wired into Claude Code (see [setup.md](setup.md)), Claude calls these
tools directly — full parameter control. The server writes to a
`nanobanana-output/` directory relative to its launch working directory (usually,
but not guaranteed to be, your project root — see "Output" below); always trust
the absolute paths it returns in `generatedFiles`. Tool names and parameter
surfaces below are taken from the extension source (`mcp-server/src/index.ts`, v1.0.12).

## The seven MCP tools

### `generate_image` — text → image (the default)
| param | type | default | values |
|---|---|---|---|
| `prompt` | string | — | **required** |
| `outputCount` | number | 1 | 1–8 (batch / variations) |
| `styles` | string[] | — | photorealistic, watercolor, oil-painting, sketch, pixel-art, anime, vintage, modern, abstract, minimalist |
| `variations` | string[] | — | lighting, angle, color-palette, composition, mood, season, time-of-day |
| `format` | string | separate | `separate`, `grid` |
| `seed` | number | — | reproducibility |
| `preview` | boolean | false | low-cost preview pass |

### `generate_story` — sequential / multi-scene images
The headline capability. Produces a coherent sequence (visual story, process,
tutorial, timeline) holding characters/palette/style steady across frames.
| param | type | default | values |
|---|---|---|---|
| `prompt` | string | — | **required** |
| `steps` | number | 4 | 2–8 frames |
| `type` | string | story | `story`, `process`, `tutorial`, `timeline` |
| `style` | string | consistent | `consistent` (same look) · `evolving` (look develops) |
| `layout` | string | separate | `separate`, `grid`, `comic` |
| `transition` | string | smooth | `smooth`, `dramatic`, `fade` |
| `format` | string | individual | `individual`, `storyboard` |
| `preview` | boolean | false | |

### `edit_image` — natural-language edit of an existing image
| param | type | notes |
|---|---|---|
| `prompt` | string | **required** — the edit instruction |
| `file` | string | **required** — path to source image |
| `preview` | boolean | default false |

The model does semantic-mask / inpainting edits ("change the sky to sunset",
"remove the person on the left") while preserving the rest.

### `restore_image` — repair & enhance old/damaged photos
Same shape as `edit_image` (`prompt`, `file`, `preview`). Use for upscaling,
de-noising, scratch/tear repair, colorization.

### `generate_icon` — app icons / favicons / UI elements
| param | type | default | values |
|---|---|---|---|
| `prompt` | string | — | **required** |
| `sizes` | number[] | — | e.g. `[16,32,64,128,256]` |
| `type` | string | app-icon | `app-icon`, `favicon`, `ui-element` |
| `style` | string | modern | `flat`, `skeuomorphic`, `minimal`, `modern` |
| `format` | string | png | `png`, `jpeg` |
| `background` | string | transparent | `transparent`/`white`/`black`/color |
| `corners` | string | rounded | `rounded`, `sharp` |
| `preview` | boolean | false | |

### `generate_pattern` — seamless patterns & textures
| param | type | default | values |
|---|---|---|---|
| `prompt` | string | — | **required** |
| `size` | string | 256x256 | e.g. `128x128`, `512x512` |
| `type` | string | seamless | `seamless`, `texture`, `wallpaper` |
| `style` | string | abstract | `geometric`, `organic`, `abstract`, `floral`, `tech` |
| `density` | string | medium | `sparse`, `medium`, `dense` |
| `colors` | string | colorful | `mono`, `duotone`, `colorful` |
| `repeat` | string | tile | `tile`, `mirror` |
| `preview` | boolean | false | |

### `generate_diagram` — flowcharts / architecture / technical diagrams
| param | type | default | values |
|---|---|---|---|
| `prompt` | string | — | **required** |
| `type` | string | flowchart | `flowchart`, `architecture`, `network`, `database`, `wireframe`, `mindmap`, `sequence` |
| `style` | string | professional | `professional`, `clean`, `hand-drawn`, `technical` |
| `layout` | string | hierarchical | `horizontal`, `vertical`, `hierarchical`, `circular` |
| `complexity` | string | detailed | `simple`, `detailed`, `comprehensive` |
| `colors` | string | accent | `mono`, `accent`, `categorical` |
| `annotations` | string | detailed | `minimal`, `detailed` |
| `preview` | boolean | false | |

(The 8th slash command, `/nanobanana`, is a natural-language router that the
*Gemini* CLI exposes; from Claude Code you call the seven tools above directly.)

## Output
Every tool returns `{ success, message, generatedFiles: string[], error }`.
Images save to `./nanobanana-output/` (relative to the MCP server's working
dir) with auto-generated, de-duplicated filenames. Input images are searched in:
cwd, `./images/`, `./input/`, `./nanobanana-output/`, `~/Downloads/`, `~/Desktop/`.

## Model selection — `NANOBANANA_MODEL`
| env value | brand | use |
|---|---|---|
| `gemini-3.1-flash-image-preview` | Nano Banana 2 | **default (v1.0.11+)** — fast, high-volume |
| `gemini-3-pro-image-preview` | Nano Banana Pro | studio quality, best text rendering, complex instructions |
| `gemini-2.5-flash-image` | Nano Banana v1 | legacy |

Set per shell, e.g. `export NANOBANANA_MODEL=gemini-3-pro-image-preview` for
the Pro model. Note these `-preview` IDs are the extension's; the standalone GA
API id `gemini-3-pro-image` (no suffix) is a *different* string and not
interchangeable here.

**Billing required:** all Nano Banana image models are **paid** — a free-tier
Gemini API key returns `429 RESOURCE_EXHAUSTED` with `limit: 0` for every image
model (auth and the text models still work). Enable billing on the key's AI
Studio / Google Cloud project to generate. The `/agy:nanobanana` agy-direct
fallback needs no billable key (it uses your Antigravity quota) but only does
simple generation.

## Underlying API capabilities NOT exposed as MCP params (know the ceiling)
The Gemini image API can do more than the extension's tool schemas surface.
These are reachable only by describing them **in the prompt text**, not as
structured params:
- **Multi-image composition / blending** — up to 14 reference images (Pro: 6
  objects + 5 characters + 3 style refs; Flash: 10 objects + 4 characters).
- **Character / subject consistency** across a composition (reference characters).
- **Style transfer** from reference images.
- **Aspect ratio** (`aspect_ratio`: 1:1, 16:9, 9:16, 4:3, 3:4, 2:3, 3:2, 4:5,
  5:4, 21:9, …) and **resolution** (`image_size`: 512px/1K/2K/4K, uppercase K).
- **Multi-turn iterative editing** (server-side `previous_interaction_id`).
- **C2PA Content Credentials** provenance on outputs.

**Limitation:** the extension's MCP tools take none of `aspect_ratio`,
`image_size`, or explicit reference-image arrays — so for pixel-exact control of
ratio/resolution or precise multi-reference blending, put the request in the
prompt (e.g. "16:9, 2K") and verify the result, or call the raw Gemini image API
directly. This is the one capability gap between the extension and the model.
