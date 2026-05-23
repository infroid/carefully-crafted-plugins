# carefully-crafted-plugins

[![Release](https://img.shields.io/github/v/release/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/releases)
[![License](https://img.shields.io/github/license/infroid/carefully-crafted-plugins)](LICENSE)
[![Stars](https://img.shields.io/github/stars/infroid/carefully-crafted-plugins)](https://github.com/infroid/carefully-crafted-plugins/stargazers)

A Claude Code marketplace of bridges between coding agents. Stay in your
Claude Code session and reach for the strongest tool per task — OpenAI
Codex, Google Antigravity, or all three at once in a multi-agent debate.

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
/codex:image  generate a 256x256 todo app icon
/codex:reason solve this dynamic programming problem ...
/codex:review audit src/auth for security bugs
/codex:browser scrape product titles from https://example.com/store
/codex:exec   <any raw prompt to codex>
/codex:resume <follow-up for the most recent Codex session>
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
/agy:longcontext audit @src/ and @packages/ for callsites that bypass requireAuth
/agy:image       generate a 256x256 todo icon using Google's Nano Banana Pro
/agy:video       generate a 6-second product demo showing the hero feature
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

## Install

In Claude Code:

```bash
/plugin marketplace add https://github.com/infroid/carefully-crafted-plugins
/plugin install codex@carefully-crafted-plugins
/plugin install agy@carefully-crafted-plugins
/plugin install contexthub@carefully-crafted-plugins
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
│   ├── skills/{image,reason,review,browser,exec,resume,setup}/SKILL.md
│   ├── reference/critical-evaluation.md
│   └── scripts/
│       ├── spec-builder.mjs     # writes the 5-section spec
│       ├── codex-invoke.mjs     # wraps `codex exec` (+ resume, model, sandbox)
│       ├── result-handler.mjs   # parses output, places artifacts
│       ├── setup.mjs            # scaffolds user repo
│       └── output-schema.json
├── agy/
│   ├── .claude-plugin/plugin.json
│   ├── skills/{longcontext,image,video,exec}/SKILL.md
│   └── scripts/agy-invoke.mjs   # wraps Antigravity's `agy -p`
└── contexthub/
    ├── .claude-plugin/plugin.json
    └── skills/converge/SKILL.md # 4-phase multi-agent debate protocol
tests/unit/                      # node --test, no external deps
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

## License

MIT (see [LICENSE](LICENSE)).
