# r/ClaudeAI post

Reddit downweights overt self-promotion. Lead with the technical content;
self-reference sparingly.

## Title

```
I built a Claude Code plugin that makes Claude, Codex, and Antigravity (Gemini 3 Pro) debate each other before answering hard questions
```

(Reddit titles can run long, but ~120 chars renders best in the feed.)

## Body

```
For routine coding tasks, asking Claude Code directly is fine. For hard
architectural calls, security audits, or contentious technical decisions,
single-agent answers sound confident even when wrong — and you can't tell
from the response which.

I got tired of pasting the same question into three browser tabs (Claude,
ChatGPT, Gemini), so I built a Claude Code plugin called `converge` that
runs a structured 4-phase debate between three frontier agents:

  Phase 1  Independent first answers — each agent answers without seeing
           the others (preserves diversity, no anchoring)
  Phase 2  Mutual critique — each agent sees all three round-1 answers and
           critiques the other two (agreements, disagreements with reasoning,
           missing points, anything outright wrong with cited evidence)
  Phase 3  Refinement — each agent revises its answer in light of critiques
           it found compelling, explicitly stating which it accepted and
           which it rejected
  Phase 4  Synthesis — Claude (the orchestrator) produces the converged
           final response: consensus, remaining disagreements with each
           side's argument, a recommendation, decision points left to the
           user, and an audit trail of how each agent moved

The output is structured so the *disagreements* are surfaced, not papered
over. That's actually the deliverable on hard questions.

Six external CLI calls in three parallel batches. A lightweight variant
(Phase 1 + Phase 4 only) does it in two calls when you want diverse views
without the full ceremony.

What I spent the most time on was preventing the protocol from regressing
into agreement theatre. Four honesty rules are written into the skill:

  1. Don't silently degrade if one agent is unreachable — stop and ask.
  2. Don't ratify a majority (2-against-1 is evidence, not proof; if you
     suspect a shared blind spot, say so).
  3. Don't paper over disagreement — that IS the deliverable.
  4. Don't invent positions for incoherent responses.

The failure mode of multi-agent systems is convergence on confident wrong
answers, not divergence into confusion. If you don't write the protocol to
actively resist consensus, you get a worse answer than asking one model.

The repo also has two underlying bridges that converge builds on:

  - `codex` — 7-skill structured bridge to OpenAI Codex CLI: image
    generation (`gpt-image-2`), hard-reasoning offload at high reasoning
    effort, code review and refactoring, headless browser via Playwright,
    multi-turn session resume, a 5-section handoff spec written to disk,
    and a raw exec escape hatch.
  - `agy` — 4-skill bridge to Google's brand-new Antigravity CLI for
    capabilities Claude Code doesn't have natively: 1M-token long-context
    analysis on Gemini 3 Pro, Nano Banana Pro image generation, Veo video
    generation, and a raw passthrough.

MIT licensed. Node.js standard library only, no external deps.

Install (inside Claude Code):

    /plugin marketplace add https://github.com/raiaman15/carefully-crafted-plugins
    /plugin install converge@carefully-crafted-plugins

Repo: https://github.com/raiaman15/carefully-crafted-plugins

A few caveats up front, because I'd rather you hear them from me:

  - Antigravity CLI is three days old at time of posting (Google launched
    it at I/O 2026). The wrapper degrades gracefully if a flag differs from
    documentation, but expect some rough edges.
  - The synthesis is done by Claude, which is also a participant — that
    introduces a structural bias the honesty rules mitigate but don't
    eliminate. Cleaner-arrangement ideas welcome.
  - Six calls per question is real cost. This is for hard questions, not
    routine queries.

Curious whether this is genuinely useful or just clever. If you try it on
a real hard question and the synthesis helps (or doesn't), I'd appreciate
the feedback — open an issue.
```

## Posting tips

- Post Tuesday–Thursday morning US time.
- Reply to every substantive comment within 4 hours.
- If a comment finds a bug, acknowledge it in the same comment and
  reference an issue you opened to track it. (Visible accountability.)
- Do not crosspost the same body to r/programming or r/MachineLearning —
  different audiences want different framings. If you want to hit those,
  rewrite specifically for them.
