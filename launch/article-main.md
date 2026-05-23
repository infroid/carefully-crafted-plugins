# Get a converged answer from three frontier AIs in one terminal

> Demo (15s): **[paste your asciinema embed or GIF link here — see launch/demo-script.md]**

```
/contexthub:converge "Should our microservice migrate from REST to gRPC?"
```

That's it. Three frontier AIs — **Claude (Anthropic), OpenAI Codex
(GPT-class), Google's Antigravity (Gemini 3 Pro)** — work the question
together and hand you back one synthesized answer.

No more switching between ChatGPT, Claude, and Gemini in three browser tabs
and reconciling in your head. No more guessing which model's confidence to
trust on a hard call.

## What you actually get back

A structured response designed to make hard decisions fast:

```markdown
### Consensus
- gRPC's binary protocol and streaming model are well-suited for internal
  service-to-service calls.
- The migration cost is non-trivial for any client surface already on REST.

### Disagreements
- Codex argues split-stack: gRPC internal, REST external. Argument: …
- Antigravity argues full migration with a thin REST shim. Argument: …
- Claude leans toward the split-stack position because [reasoning].

### Recommendation
[Synthesized best answer, weak-evidence calls flagged for override]

### What you should decide
1. Is your client surface mostly internal or external?
2. Do you have load-test data showing the wire-format saving matters?
3. …

### Audit trail
| Topic | Codex R1 → R2 | Antigravity R1 → R2 | Claude R1 → R2 |
```

You get an answer **and** the dissent. The "Disagreements" block is the
genuinely useful part: that's where you stop pretending one model has the
truth and decide for yourself, with three frontier perspectives in front of
you.

## What you can do with this

The kind of question where this changes the outcome:

- **Architecture calls** you can't afford to bet on one model's opinion —
  framework choice, transport, data layer, service boundaries.
- **Security audits** where any single AI might miss what another catches.
- **Recent-tech decisions** (new frameworks, new APIs) where training
  cutoffs matter and any one model might be stale.
- **Contentious calls** (X vs. Y, deprecate vs. maintain) where multiple
  defensible answers exist.

For routine coding tasks, keep asking Claude Code directly. This is for
the tail of questions where confident single-AI answers are not enough.

## Other capabilities in the same install

`contexthub` is the headline, but the same marketplace gets you:

**Codex bridge** (`/codex:…`)

- **Image generation** — Claude Code can't produce raster images natively;
  Codex's `gpt-image-2` can.
- **Frontier reasoning offload** at high effort, for problems where you
  want a second-strongest pass.
- **Code review and refactoring** delegated to Codex with structured handoff.
- **Headless browser automation** (Playwright via Codex).
- **Multi-turn Codex session resume** for iterative follow-ups.
- **Raw `codex exec`** passthrough.

**Antigravity bridge** (`/agy:…`)

- **1M-token long-context analysis** on Gemini 3 Pro — roughly 5× what
  Claude Code holds. Analyze entire monorepos in one pass.
- **Image generation** via Google's Nano Banana Pro (alternative model
  style to Codex's).
- **Video generation** via Veo. No other terminal tool does this.
- **Raw `agy -p`** passthrough.

All from inside your Claude Code session. No tool-switching. No context
loss between agents.

## Install

You need three things on your `PATH`:

- Claude Code (with plugin support).
- OpenAI Codex CLI:
  `npm install -g @openai/codex`, then `codex login`.
- Google Antigravity CLI:
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`, then run
  `agy` once interactively to sign in.

Then, inside Claude Code:

```bash
/plugin marketplace add https://github.com/infroid/carefully-crafted-plugins
/plugin install contexthub@carefully-crafted-plugins
/plugin install codex@carefully-crafted-plugins
/plugin install agy@carefully-crafted-plugins
```

## Try it on something real

Pick a question you've actually been debating with yourself — an
architecture call, a tooling choice, a deprecation you keep putting off,
something where you weren't sure. Run:

```bash
/contexthub:converge "your hard question here"
```

See whether the converged synthesis genuinely helps you decide.

If it does, ⭐ the repo. If it doesn't, drop the question + the output
into an issue — I'm collecting the failure-mode corpus and want to know
what breaks.

---

**Repo:** [github.com/infroid/carefully-crafted-plugins](https://github.com/infroid/carefully-crafted-plugins)
**License:** MIT
**Tests:** `node --test tests/unit/*.test.mjs` (31 tests, zero external dependencies)
