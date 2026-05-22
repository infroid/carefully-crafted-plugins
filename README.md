# carefully-crafted-plugins

A marketplace of Claude Code plugins that bridge Claude Code to other coding
agents, so you can stay in your CC session and reach for the strongest tool
per task.

## What's in v1

- **`codex`** — real bridge to OpenAI Codex CLI for capabilities CC can't do
  natively or where Codex measurably outperforms: raster image generation
  (`gpt-image-2`), hard-reasoning offload (GPT-5.5), code review and
  refactoring, headless browser automation, multi-turn session resume, and a
  raw `codex exec` escape hatch.
- **`gemini`** — placeholder (coming soon).
- **`cursor`** — placeholder (coming soon).

## The handoff contract

Every delegation produces a **5-section spec** written to
`docs/carefully-crafted-plugins/handoffs/`:

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
```

`/gemini:delegate` and `/cursor:delegate` print "coming soon."

Under the hood, `codex-invoke.mjs` selects the model (`--model`), reasoning
effort (`--reasoning-effort low|medium|high|xhigh`), and sandbox
(`--sandbox read-only|workspace-write|danger-full-access`, default
`read-only`). Codex's verbose trace is kept out of CC's context by default;
pass `--verbose` to stream it.

## Requirements

- Claude Code (recent enough to support plugins + skills)
- Codex CLI: `npm install -g @openai/codex` or `brew install codex`, then
  `codex login`
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
├── gemini/                      # stub
└── cursor/                      # stub
tests/unit/                      # node --test, no external deps
```

## Run the tests

```bash
node --test tests/unit/*.test.mjs
```

## License

MIT (see [LICENSE](LICENSE)).
