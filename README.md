# carefully-crafted-plugins

[![Release](https://img.shields.io/github/v/release/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/releases)
[![License](https://img.shields.io/github/license/infroid/carefully-crafted-plugins)](LICENSE)
[![Stars](https://img.shields.io/github/stars/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/stargazers)

A small, opinionated set of multi-agent plugins for Claude Code. Bridges
to OpenAI Codex and Google Antigravity, a Delphi debate primitive,
token-efficient task triage, and a seven-phase software lifecycle —
sufficient for every capability worth multi-agenting, deliberately
lightweight by construction.

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
- Image generation via Nano Banana Pro
- Video generation via Veo
- Raw `agy -p` passthrough

```
/agy:longctx     audit @src/ and @packages/ for callsites that bypass requireAuth
/agy:nanobanana  generate a 256x256 todo icon using Google's Nano Banana Pro
/agy:veo         generate a 6-second product demo showing the hero feature
/agy:exec        <any raw prompt to agy>
```

### `contexthub` — multi-agent debate

Stage a systematic four-phase debate (independent answers → mutual critique
→ refinement → synthesis) among Claude Code, Codex, and Antigravity on a
single hard prompt. Converges on a final response that surfaces consensus
and remaining disagreements.

```
/contexthub:converge should we move auth from session cookies to JWTs?
```

### `triage` — token-efficient task grading

Grade a task low/medium/hard before delegating. The codex bridge now
defaults to `medium` reasoning effort instead of `xhigh` — `triage`
escalates only when difficulty warrants it. Spend the big effort where
it matters; save tokens on the rest.

```
/triage:grade audit src/auth.ts for race conditions
```

Writes a routing plan to `docs/carefully-crafted-plugins/triage/` that
downstream specialists read to set their effort.

### `forge` — the multi-agent software lifecycle

Seven phases that route every step to the strongest specialist. What
Superpowers does, with three minds.

```
/forge:spec   <rough idea>           # spec refinement, debate-aware
/forge:plan   <spec path>            # plan + codex stress-test + agy coverage
/forge:tdd    <plan path>            # RED-GREEN-REFACTOR; codex on stuck subproblems
/forge:review <branch>               # three-way: Claude + codex + agy
/forge:verify <branch>               # tests + playwright + blast-radius scan
/forge:debug  <symptom>              # triangulate root cause across three agents
/forge:ship   <hint>                 # commit message, retro, push (with consent)
```

Each phase writes an artifact to `docs/carefully-crafted-plugins/forge/<phase>/`
for full audit-trail.

## Install

In Claude Code:

```bash
/plugin marketplace add https://github.com/infroid/carefully-crafted-plugins
/plugin install codex@carefully-crafted-plugins
/plugin install agy@carefully-crafted-plugins
/plugin install contexthub@carefully-crafted-plugins
/plugin install triage@carefully-crafted-plugins
/plugin install forge@carefully-crafted-plugins
```

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
- For `contexthub`: both the Codex and Antigravity CLIs (the debate calls
  all three agents)
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
│   ├── skills/{longctx,nanobanana,veo,exec}/SKILL.md
│   └── scripts/agy-invoke.mjs   # wraps Antigravity's `agy -p`
├── contexthub/
│   ├── .claude-plugin/plugin.json
│   └── skills/converge/SKILL.md # 4-phase multi-agent debate protocol
├── triage/
│   ├── .claude-plugin/plugin.json
│   ├── skills/grade/SKILL.md    # difficulty grading + routing plan
│   └── scripts/triage-write.mjs # writes the JSON artifact
└── forge/
    ├── .claude-plugin/plugin.json
    ├── skills/{spec,plan,tdd,review,verify,debug,ship}/SKILL.md
    └── scripts/forge-write.mjs  # writes phase artifacts
tests/unit/                      # node --test, no external deps
tools/lint-skill.mjs             # quality-bar enforcer (run in CI via tests/)
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

The suite includes `lint-skill.mjs`, which gates every `SKILL.md` against
the quality bar (`quality-bar.md`). To lint just the skills without
running the full suite:

```bash
node tools/lint-skill.mjs
```

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

## License

MIT (see [LICENSE](LICENSE)).
