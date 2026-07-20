# carefully-crafted-plugins

[![Release](https://img.shields.io/github/v/release/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/releases)
[![Stars](https://img.shields.io/github/stars/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/stargazers)

A small, opinionated set of multi-agent plugins for Claude Code. Two
single-agent bridges — `codex` (OpenAI Codex) and `agy` (Google
Antigravity) — plus `contexthub`, the multi-agent hub for cross-provider
convergence and token-efficient Claude supervision of Codex workers. Three
plugins, ten skills, deliberately lightweight by construction.

Superpowers provides the development methodology. Carefully Crafted
provides Codex/Agy bridges, explicit cross-provider convergence, and
token-efficient Claude supervision of Codex workers.

## What you can delegate

### `codex` — OpenAI Codex CLI

Codex CLI fills capability gaps from Claude Code:

- Image generation (`gpt-image-2` via Codex's built-in `$imagegen`)
- Hard reasoning at xhigh effort (GPT-5.6 Sol)
- An independent, read-only code review on explicit request
- Session resume across follow-ups
- Raw `codex exec` passthrough
- Optional, explicit bridge setup

```
/codex:imagegen   generate a 256x256 todo app icon
/codex:reason     solve this dynamic programming problem ...
/codex:review     audit src/auth for security bugs
/codex:resume     <follow-up for the most recent Codex session>
/codex:exec       <any raw prompt to codex>
/codex:setup      optional — copy editable defaults into this repo, re-verify the Codex CLI
```

Only `/codex:imagegen` and `/codex:reason` auto-trigger from natural
language; the other four are slash-command only. `codex` is an optional,
separately-installed plugin — install it if you want `/codex:*` commands.
`/contexthub:supervise` talks to Codex directly through its own scripts and
does not require this plugin.

### `agy` — Google Antigravity CLI

Antigravity's terminal coding agent (`agy`) is a narrow two-skill bridge:

- Nano Banana text-to-image generation through the authenticated `agy` CLI
- Raw `agy -p` passthrough

```
/agy:nanobanana  a poster of a lighthouse at dusk, warm palette
/agy:exec        <any raw prompt to agy>
```

Nano Banana no longer has a wired multi-tool image backend — there is no
story/multi-scene generation, natural-language editing, photo restoration,
icon-set, pattern, or diagram tooling here anymore. It is plain
text-to-image only, generated directly through the authenticated `agy` CLI,
and may require access or billing for whichever image model your
Antigravity account is configured with. For a first-choice default image
generator, or for any of the retired capabilities, prefer `/codex:imagegen`.

Both `agy` skills are slash-command only.

### `contexthub` — the multi-agent hub

The hub ties Claude, Codex, and Antigravity together for two things
Superpowers does not do on its own: cross-provider debate, and bounded
external-worker execution.

```
/contexthub:converge  [--full] <question>   # cross-provider debate: Claude + Codex + Antigravity
/contexthub:supervise <task>                # Claude plans/reviews; isolated Codex workers implement
```

`/contexthub:converge` stages a short cross-provider debate — independent
answers by default, full mutual critique and refinement with `--full` — and
produces consensus, disagreements, and a recommendation. It writes nothing
to disk.

`/contexthub:supervise` is the token-efficient execution engine: Claude
plans (via Superpowers), grades the task, and reviews; isolated GPT-5.6 Sol
Codex workers implement in their own worktrees and report back compact
evidence, never their full transcripts. At most one correction wave runs
before Claude accepts the final result and, with your consent, finishes the
branch. Every methodology step — brainstorming, planning, TDD, debugging,
review, verification, branch-finishing — is delegated to the corresponding
Superpowers skill; `contexthub` never re-implements it.

Both `contexthub` skills are slash-command only and manual-invocation gated
(`disable-model-invocation: true`) — that defers each skill's larger body
cost until you explicitly run it and blocks automatic invocation. It does
not remove the skill's name/description from Claude's always-on context;
measured manual-only skills carry ~60–100 tok always-on, the same order as
model-invocable ones.

## Install

In Claude Code:

```bash
/plugin marketplace add anthropics/claude-plugins-official
/plugin marketplace add https://github.com/infroid/carefully-crafted-plugins
/plugin install contexthub@carefully-crafted-plugins
/plugin install codex@carefully-crafted-plugins
/plugin install agy@carefully-crafted-plugins
```

**Add `claude-plugins-official` first.** `contexthub` requires
`superpowers@claude-plugins-official`, and Claude Code resolves that
dependency only from a marketplace you have already added. With it present,
installing `contexthub` pulls in and enables Superpowers automatically —
no separate install step. **Without it, the install still reports success
and gives you `contexthub` alone**; the unresolved dependency surfaces only
on a later install attempt, as `1 dependency still unresolved:
superpowers@claude-plugins-official`. If you see that, add the marketplace
and re-run the install.

`codex` and `agy` are optional, separately-installed bridges: install
`codex` only for `/codex:*` commands, `agy` only for `/agy:*` commands.
Neither is required by `/contexthub:supervise`.

## Requirements

- `contexthub` requires Superpowers (`superpowers@claude-plugins-official`)
  — installing `contexthub` auto-resolves and enables it; you never install
  it separately.
- `codex`, the public bridge behind `/codex:*` commands, is optional and
  installed separately; `/contexthub:supervise` talks to Codex directly and
  does not need it.
- Claude Code `2.1.143` or later is required for dependency enable/disable
  enforcement (older versions can still install `contexthub`, but won't
  reject an attempt to disable its required Superpowers dependency).
- Codex CLI auth (`codex login`) remains a user prerequisite for every
  Codex-touching skill.
- Codex-side Superpowers (`superpowers@openai-curated`, installed and
  enabled inside Codex, with its worker skills present) is a separately
  required prerequisite that `/contexthub:supervise` checks before running
  and never installs on your behalf.
- Antigravity CLI auth is only needed for `/contexthub:converge` and the
  `agy` bridge skills — `/contexthub:supervise` never spawns Antigravity
  workers.
- Node.js ≥ 20 and Git are the only script/runtime dependencies — pure
  standard library, no npm packages.
- `/codex:setup` is optional and explicit; nothing auto-scaffolds a repo on
  first use of any skill.
- Nano Banana (`/agy:nanobanana`) generates through the authenticated `agy`
  CLI directly: a smaller, text-to-image-only guarantee that may require
  access or billing for whichever image model your Antigravity account is
  configured with.

## Layout

```
.claude-plugin/marketplace.json   # 3 plugins listed
plugins/
├── codex/
│   ├── .claude-plugin/plugin.json
│   ├── skills/{imagegen,reason,review,exec,resume,setup}/SKILL.md
│   ├── skills/{imagegen,reason}/evals/evals.json   # the two model-invocable skills only
│   ├── reference/critical-evaluation.md
│   ├── reference/defaults/{constraints,output-formats}/   # packaged defaults, copied in by /codex:setup
│   ├── reference/schemas/code-review.schema.json
│   └── scripts/
│       ├── spec-builder.mjs     # writes the 5-section spec
│       ├── codex-invoke.mjs     # wraps `codex exec` (+ resume, model, sandbox)
│       ├── result-handler.mjs   # parses output, places artifacts
│       ├── setup.mjs            # optional, explicit repo scaffolding
│       └── output-schema.json
├── agy/
│   ├── .claude-plugin/plugin.json
│   ├── skills/{exec,nanobanana}/SKILL.md
│   └── scripts/
│       └── agy-invoke.mjs        # wraps `agy -p` (+ --collect artifact retrieval)
└── contexthub/
    ├── .claude-plugin/plugin.json
    ├── skills/converge/{SKILL.md,references/critique-and-refinement-prompts.md}
    ├── skills/supervise/{SKILL.md,references/protocol.md}
    ├── schemas/{complexity,worker-report}.schema.json
    └── scripts/
        ├── agent-availability.mjs # detects Claude/codex/agy for converge
        ├── supervise.mjs          # supervise's phase-machine entry point
        └── supervise/{checkpoint,codex,contracts,git,scheduler,state,verify}.mjs
tests/unit/                      # node --test, no external deps
tools/
├── lint-skill.mjs               # quality-bar enforcer (run in CI via tests/)
├── eval-check.mjs               # evals.json structural validator
└── run-supervise-live-evals.mjs # paid, human-run release-eval harness (not part of ordinary supervision)
quality-bar.md                   # the gates every skill must clear
```

## How the codex bridge works

The `codex` bridge writes a **5-section spec** to
`docs/carefully-crafted-plugins/handoffs/` for every **structured**
delegation — `/codex:imagegen`, `/codex:reason`, and `/codex:review`. The
sections are: *what to do* (role + task), *how to do* (numbered steps or
open delegation), *standard constraints*, *expected output format*, and any
*pre-flight clarifications* Claude resolved with you. Codex receives a tiny
prompt pointing at the spec file and reads everything from disk — no 800KB
prompt limit, no opaque handoffs.

The constraint and output-format sections link to packaged defaults under
`${CLAUDE_PLUGIN_ROOT}/reference/defaults/` unless you have opted in to
project-local copies. Because `/codex:setup` is optional and never runs on
its own, those packaged defaults — not files in your repo — are what a
fresh install references; run `/codex:setup` if you want editable copies
under `docs/carefully-crafted-plugins/` to customize.

`/codex:exec` and `/codex:resume` deliberately skip this scaffolding —
`exec` is a raw passthrough and `resume` continues an existing session, so
neither builds a spec. The `agy` and `contexthub` bridges skip it by design
too: Antigravity reads the repo itself, `/contexthub:converge` is its own
debate protocol, and `/contexthub:supervise` drives Codex through a compact
machine task graph instead of a handoff spec.

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

## Migrating to 6.0.0

v6 narrows the marketplace to ten high-value skills and adds
`/contexthub:supervise`, a token-efficient engine where Claude plans and
reviews while isolated GPT-5.6 Sol Codex workers implement. Twelve commands
were removed with no aliases — Superpowers, not a new Carefully Crafted
command, now owns every methodology step they used to perform.

Upgrading from 4.x or earlier? See the 5.0.0 release notes for the
`forge`/`triage` → `contexthub` renames first, then apply the table below.

### Removed methodology commands → the Superpowers skill that replaces them

| Removed | Use instead |
|---|---|
| `/contexthub:spec` | `superpowers:brainstorming` — explore intent, requirements, and design before implementation |
| `/contexthub:plan` | `superpowers:writing-plans` |
| `/contexthub:tdd` | `superpowers:test-driven-development`, run via `superpowers:executing-plans` or `superpowers:subagent-driven-development` |
| `/contexthub:review` | `superpowers:requesting-code-review` (or `superpowers:receiving-code-review` on the receiving end) |
| `/contexthub:verify` | `superpowers:verification-before-completion` |
| `/contexthub:debug` | `superpowers:systematic-debugging` |
| `/contexthub:ship` | `superpowers:finishing-a-development-branch` |
| `/contexthub:triage` | grading is now a built-in step of `/contexthub:supervise`, not a standalone command |

### Removed capabilities — cut, not replaced

| Removed | Why |
|---|---|
| `/codex:playwright` | Browser automation is out of scope for this marketplace; no replacement command |
| `/agy:longctx` | 1M-token long-context analysis is out of scope for this marketplace; no replacement command |
| `/agy:veo` | Video generation is out of scope for this marketplace; no replacement command |
| `/agy:setup` | Nano Banana no longer has a wired multi-tool backend to set up — `/agy:nanobanana` now generates directly through the authenticated `agy` CLI with no setup step |

`/codex:exec`, `/codex:imagegen`, `/codex:reason`, `/codex:resume`,
`/codex:setup`, `/agy:exec`, `/agy:nanobanana` (now text-to-image only), and
`/contexthub:converge` are unchanged in name; `/contexthub:supervise` is
new.

<!-- end migration -->

Everything above this marker is the v6 migration record and is the only
place in this README permitted to name removed commands. Anything added
below it is held to the current-surface standard by
`tests/unit/stale-references.test.mjs`.
