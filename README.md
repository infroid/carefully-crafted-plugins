# carefully-crafted-plugins

A marketplace of Claude Code plugins that bridge Claude Code to other coding
agents, so you can stay in your CC session and reach for the strongest tool
per task.

## What's in the marketplace

- **`codex`** — structured bridge to OpenAI Codex CLI for capabilities CC
  can't do natively or where Codex measurably outperforms: raster image
  generation (`gpt-image-2`), hard-reasoning offload at high reasoning effort,
  code review and refactoring, headless browser automation, multi-turn session
  resume, and a raw `codex exec` escape hatch.
- **`agy`** — bridge to Google's Antigravity CLI (`agy`, the terminal coding
  agent that replaced Gemini CLI) for capabilities Claude Code lacks: 1M-token
  long-context analysis on Gemini 3 Pro, image generation via Nano Banana Pro,
  and video generation via Veo. A raw passthrough fills any other gap.
- **`converge`** — meta-orchestrator. Stages a systematic four-phase debate
  (independent answers → mutual critique → refinement → synthesis) among
  Claude Code, Codex, and Antigravity on a single hard prompt, then converges
  on a final response surfacing consensus and remaining disagreements.

## The codex handoff contract

The `codex` bridge writes a **5-section spec** to
`docs/carefully-crafted-plugins/handoffs/` for every delegation:

1. **What to do** — role + task elaboration
2. **How to do** — numbered steps OR `"Delegate, figure it out."`
3. **Standard constraints** — references to `.md` files in
   `docs/carefully-crafted-plugins/constraints/` (your reusable standards)
4. **Expected output & format** — references to `.md` files in
   `docs/carefully-crafted-plugins/output-formats/`
5. **Pre-flight clarifications** — Q&A resolved with you in CC *before*
   Codex is invoked

Codex receives a tiny prompt pointing at the spec file and reads everything
it needs from disk. No 800KB prompt limit, no opaque handoffs.

The `agy` bridge skips this scaffolding on purpose — Antigravity is itself an
agent that reads the repo, so `/agy:delegate` just passes a well-framed task
straight to the CLI.

## Install

```bash
# In Claude Code:
/plugin marketplace add https://github.com/raiaman15/carefully-crafted-plugins
/plugin install codex@carefully-crafted-plugins
```

That's it. The first time you use any `codex` skill in a repo, it runs a quick
one-time setup automatically — scaffolding
`docs/carefully-crafted-plugins/{constraints,output-formats,handoffs,output/images}/`
with starter `.md` files and updating `.gitignore`. You are told once, and the
task continues without interruption.

To re-scaffold or refresh those starter files later, run `/codex:setup`
explicitly (optional).

## Use

Skills both auto-trigger (CC notices a matching task) and work as explicit
slash commands — the text after the command is passed straight through:

```
/codex:image  generate a 256x256 todo app icon
/codex:reason solve this dynamic programming problem ...
/codex:review audit src/auth for security bugs
/codex:browser scrape product titles from https://example.com/store
/codex:exec   <any raw prompt to codex>
/codex:resume <follow-up for the most recent Codex session>
/agy:longcontext audit @src/ and @packages/ for callsites that bypass requireAuth
/agy:image    generate a 256x256 todo icon using Google's Nano Banana Pro
/agy:video    generate a 6-second product demo showing the hero feature
/agy:exec     <any raw prompt to agy>
/converge:debate should we move auth from session cookies to JWTs?
```

Under the hood, `codex-invoke.mjs` selects the model (`--model`), reasoning
effort (`--reasoning-effort low|medium|high|xhigh`), and sandbox
(`--sandbox read-only|workspace-write|danger-full-access`, default
`read-only`). Codex's verbose trace is kept out of CC's context by default;
pass `--verbose` to stream it.

## Requirements

- Claude Code (recent enough to support plugins + skills)
- For `codex`: Codex CLI — `npm install -g @openai/codex` or
  `brew install codex`, then `codex login`
- For `agy`: Antigravity CLI —
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run `agy`
  once to sign in
- For `converge`: both the Codex and Antigravity CLIs above (the debate calls
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
│   ├── hooks/hooks.json
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
└── converge/
    ├── .claude-plugin/plugin.json
    └── skills/debate/SKILL.md   # 4-phase multi-agent debate protocol
tests/unit/                      # node --test, no external deps
```

## Run the tests

```bash
node --test tests/unit/*.test.mjs
```

## License

MIT (see [LICENSE](LICENSE)).
