# carefully-crafted-plugins

[![Release](https://img.shields.io/github/v/release/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/releases)
[![Stars](https://img.shields.io/github/stars/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/stargazers)

A small, opinionated set of multi-agent plugins for Claude Code. Two
single-agent bridges — `codex` (OpenAI Codex) and `agy` (Google
Antigravity) — plus `contexthub`, the multi-agent hub that ties Claude,
codex, and agy together across a software lifecycle, token-efficient task
triage, and the Delphi converge debate. Three plugins, deliberately
lightweight by construction.

`contexthub` works with Claude alone; `codex` and `agy` are optional
collaborators that each skill uses when present. Every contexthub skill
degrades gracefully — it detects which of Claude, codex, and agy are
installed and runs the richest flow available, falling back to Claude-solo
(with a note) rather than failing.

## What you can delegate

### `codex` — OpenAI Codex CLI

Codex CLI fills several capability gaps from Claude Code:

- Image generation (`gpt-image-2` via Codex's built-in `$imagegen`)
- Hard reasoning at high effort
- Code review and refactoring
- Headless browser automation (Playwright)
- Session resume across follow-ups
- Raw `codex exec` passthrough

```
/codex:imagegen   generate a 256x256 todo app icon
/codex:reason     solve this dynamic programming problem ...
/codex:review     audit src/auth for security bugs
/codex:playwright scrape product titles from https://example.com/store
/codex:exec       <any raw prompt to codex>
/codex:resume     <follow-up for the most recent Codex session>
```

### `agy` — Google Antigravity CLI

Antigravity's terminal coding agent (`agy`, which replaced Gemini CLI)
brings capabilities Claude Code lacks:

- 1M-token long-context analysis on Gemini 3 Pro (up to 2M enterprise) —
  roughly 5× what Claude Code can hold
- Image generation **and** editing via Nano Banana (Gemini image models):
  text→image plus sequential **story**/multi-scene, natural-language **edit**,
  photo **restore**, **icon**, seamless **pattern**, and **diagram** — through
  the `nanobanana` MCP backend, with an agy-direct fallback for simple one-offs
- Video generation via Veo
- Raw `agy -p` passthrough

```
/agy:longctx     audit @src/ and @packages/ for callsites that bypass requireAuth
/agy:nanobanana  a four-panel story of a seed growing into a tree
/agy:setup       wire up the Nano Banana MCP backend (explicit, collaborative)
/agy:veo         generate a 6-second product demo showing the hero feature
/agy:exec        <any raw prompt to agy>
```

The richer Nano Banana capabilities (story, edit, restore, icon, pattern,
diagram) run through an MCP server that you wire into Claude Code **explicitly**
via `/agy:setup` — nothing installs or touches your API key implicitly. Until
then, `/agy:nanobanana` still does simple generation through agy directly.

### `contexthub` — the multi-agent hub

The hub that ties Claude, Codex, and Antigravity together: a full software
lifecycle, token-efficient task triage, and the Delphi converge debate.
Every skill degrades gracefully — it runs the richest flow available across
whichever of {Claude, codex, agy} are installed, and falls back to
Claude-solo (with a note) rather than failing.

The software lifecycle — seven phases that route every step to the
strongest specialist available. What Superpowers does, with up to three
minds:

```
/contexthub:spec   <rough idea>      # spec refinement, debate-aware
/contexthub:plan   <spec path>       # plan + codex stress-test + agy coverage
/contexthub:tdd    <plan path>       # RED-GREEN-REFACTOR; codex on stuck subproblems
/contexthub:review <branch>          # three-way: Claude + codex + agy
/contexthub:verify <branch>          # tests + playwright + blast-radius scan
/contexthub:debug  <symptom>         # triangulate root cause across the agents
/contexthub:ship   <hint>            # commit message, retro, push (with consent)
```

Each phase writes an artifact to
`docs/carefully-crafted-plugins/lifecycle/<phase>/` for a full audit trail.

Token-efficient task triage — grade a task low/medium/hard before
delegating. The codex bridge defaults to `medium` reasoning effort instead
of `xhigh`; triage escalates only when difficulty warrants it. Spend the
big effort where it matters; save tokens on the rest.

```
/contexthub:triage audit src/auth.ts for race conditions
```

The Delphi converge debate — stage a systematic four-phase debate
(independent answers → mutual critique → refinement → synthesis) among the
installed agents on a single hard prompt. Converges on a final response
that surfaces consensus and remaining disagreements.

```
/contexthub:converge should we move auth from session cookies to JWTs?
```

## Install

In Claude Code:

```bash
/plugin marketplace add https://github.com/infroid/carefully-crafted-plugins
/plugin install codex@carefully-crafted-plugins
/plugin install agy@carefully-crafted-plugins
/plugin install contexthub@carefully-crafted-plugins
```

`contexthub` works with Claude alone; install `codex` and `agy` as optional
collaborators that each contexthub skill uses when present.

The codex bridge auto-scaffolds `docs/carefully-crafted-plugins/` standards
the first time you use one of its skills. Run `/codex:setup` to re-scaffold
or refresh the starter files later.

## Requirements

- Claude Code (recent enough to support plugins + skills)
- For `codex`: Codex CLI — `npm install -g @openai/codex` or
  `brew install codex`, then `codex login`
- For `agy`: Antigravity CLI —
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run
  `agy` once interactively to sign in
- For `contexthub`: nothing beyond Claude Code itself — every skill runs
  Claude-solo if neither bridge is present. The Codex and Antigravity CLIs
  are optional; each skill enriches its flow with whichever are installed
- Node.js ≥ 20 (for the bridge scripts; pure standard library, no deps)

## Layout

```
.claude-plugin/marketplace.json   # 3 plugins listed
plugins/
├── codex/
│   ├── .claude-plugin/plugin.json
│   ├── skills/{imagegen,reason,review,playwright,exec,resume,setup}/SKILL.md
│   ├── reference/critical-evaluation.md
│   └── scripts/
│       ├── spec-builder.mjs     # writes the 5-section spec
│       ├── codex-invoke.mjs     # wraps `codex exec` (+ resume, model, sandbox)
│       ├── result-handler.mjs   # parses output, places artifacts
│       ├── setup.mjs            # scaffolds user repo
│       └── output-schema.json
├── agy/
│   ├── .claude-plugin/plugin.json
│   ├── skills/{longctx,nanobanana,veo,exec,setup}/SKILL.md
│   │   └── nanobanana/references/{capabilities,setup}.md  # tool surface + setup
│   └── scripts/
│       ├── agy-invoke.mjs        # wraps `agy -p` (+ --collect artifact retrieval)
│       ├── nanobanana-detect.mjs # which image backend is usable (mcp/agy/none)
│       └── nanobanana-setup.mjs  # explicit, flag-gated Nano Banana MCP wiring
└── contexthub/
    ├── .claude-plugin/plugin.json
    ├── skills/{spec,plan,tdd,review,verify,debug,ship}/SKILL.md  # lifecycle
    ├── skills/triage/SKILL.md   # difficulty grading + routing plan
    ├── skills/converge/SKILL.md # 4-phase multi-agent debate protocol
    └── scripts/
        ├── phase-write.mjs      # writes lifecycle phase artifacts
        ├── triage-write.mjs     # writes the triage JSON artifact
        └── agent-availability.mjs # detects Claude/codex/agy for graceful degradation
tests/unit/                      # node --test, no external deps
tools/
├── lint-skill.mjs               # quality-bar enforcer (run in CI via tests/)
└── eval-check.mjs               # evals.json structural validator
quality-bar.md                   # the gates every skill must clear
```

## How the codex bridge works

The `codex` bridge writes a **5-section spec** to
`docs/carefully-crafted-plugins/handoffs/` for every delegation: *what to
do* (role + task), *how to do* (numbered steps or open delegation),
*standard constraints* (links to your repo's `.md` standards), *expected
output format* (links to your repo's format definitions), and any
*pre-flight clarifications* Claude resolved with you. Codex receives a tiny
prompt pointing at the spec file and reads everything from disk — no 800KB
prompt limit, no opaque handoffs. The `agy` and `contexthub` bridges skip
this scaffolding by design (Antigravity reads the repo itself; the
multi-agent debate is its own protocol).

## Run the tests

```bash
node --test tests/unit/*.test.mjs
```

The suite includes `lint-skill.mjs` (gates every `SKILL.md` against
`quality-bar.md`) and `eval-check.mjs` (validates every `evals/evals.json`
structure). To run them standalone:

```bash
node tools/lint-skill.mjs    # SKILL.md quality bar
node tools/eval-check.mjs    # evals.json structural validation
```

## Migrating to 5.0.0

The marketplace consolidated from five plugins to three. The `forge` and
`triage` plugins were removed; their skills now live under `contexthub`,
which also gained graceful degradation (it runs Claude-solo when codex/agy
are absent). The command renames:

| Old | New |
|---|---|
| `/forge:<phase>` | `/contexthub:<phase>` (spec, plan, tdd, review, verify, debug, ship) |
| `/triage:grade` | `/contexthub:triage` |

The lifecycle artifact directory moved from
`docs/carefully-crafted-plugins/forge/` to
`docs/carefully-crafted-plugins/lifecycle/`. `/contexthub:converge` and all
`codex`/`agy` commands are unchanged.

## Migrating from 2.x

Skill names were tightened in 3.0.0 to remove cross-plugin collisions
(both `codex` and `agy` previously had a skill called `image`). The
renames:

| Old | New |
|---|---|
| `/codex:image` | `/codex:imagegen` |
| `/codex:browser` | `/codex:playwright` |
| `/agy:image` | `/agy:nanobanana` |
| `/agy:video` | `/agy:veo` |
| `/agy:longcontext` | `/agy:longctx` |

`/codex:reason`, `/codex:review`, `/codex:exec`, `/codex:resume`,
`/codex:setup`, `/agy:exec`, and `/contexthub:converge` are unchanged.
