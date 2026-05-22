# I made three frontier AI agents argue with each other before answering hard questions

> Demo (15s): **[paste your asciinema embed or GIF link here — see launch/demo-script.md]**

I built a Claude Code plugin that orchestrates a structured four-phase
debate between **Claude (Anthropic), OpenAI Codex CLI (GPT-class), and
Google's Antigravity CLI (Gemini 3 Pro)** — all in one terminal session —
and then converges on a single synthesized answer that surfaces consensus,
remaining disagreements, and the reasoning on each side.

It is called `converge`. MIT licensed. Repo at the bottom.

---

## The problem: single-AI answers sound confident even when wrong

For routine code, asking one frontier model is fine. For *hard* questions —
architecture choices, security audits, contentious technical decisions,
anything where multiple defensible answers exist — single-agent output is
dangerous. The response is fluent. It sounds sure. You cannot tell from
the prose whether the model is right or merely confident.

The usual workaround is to open three browser tabs (ChatGPT, Claude,
Gemini), paste the same question, read all three, and reconcile in your
head. This:

- is tedious;
- gives you raw outputs with no synthesis;
- leaves you exactly where you started — still uncertain who is right —
  but with three answers instead of one.

What you actually want, on a hard question, is for the three models to
**see each other's answers and tell you where they disagree**.

## What `converge` does

A single command:

```bash
/converge:debate "Should our microservice migrate from REST to gRPC?"
```

…runs a four-phase Delphi-style protocol across three frontier agents:

```
Phase 1  Independent first responses     parallel: Codex + agy + Claude
Phase 2  Mutual critique                 parallel: Codex + agy + Claude
Phase 3  Refinement                      parallel: Codex + agy + Claude
Phase 4  Synthesis                       Claude only
```

- **Phase 1** — each agent answers independently, *without seeing the
  others*. This preserves diversity. No anchoring on whoever spoke first.
- **Phase 2** — each agent now receives all three Round 1 answers and
  produces a structured critique: what it agrees with, what it disagrees
  with and why, what's missing, what's outright wrong with cited evidence.
- **Phase 3** — each agent revises its answer in light of critiques it
  found compelling. Each must explicitly state which critique points were
  *accepted* and which were *rejected*, with reasoning. No silent flips.
- **Phase 4** — Claude (the orchestrator) produces the converged final
  response: a structured output with sections for consensus, remaining
  disagreements (with each side's strongest argument), a recommendation,
  the decision points to leave to the user, and a brief audit trail of
  how each agent's position moved across rounds.

Six external CLI calls in three parallel batches. A lightweight variant
(Phase 1 + Phase 4 only — two calls, no critique/refinement) is also
documented, for when you want diverse views without the full ceremony.

## What the output actually looks like

The synthesis is the deliverable. It is structured deliberately so that
the *disagreements* are surfaced, not papered over:

```markdown
### Consensus
- gRPC's binary protocol and streaming model are well-suited for internal
  service-to-service calls.
- The migration cost is non-trivial for any client surface that already
  consumes the REST API.

### Disagreements
- Codex argues the move is worthwhile for internal traffic only; external
  clients should keep REST. Argument: ...
- Antigravity argues for a full migration with a thin REST shim; the
  cost saving from a single transport across the org dominates. Argument: ...
- Claude leans toward Codex's split-stack position because [reasoning].

### Recommendation
[Claude's synthesized best answer, with weak-evidence calls flagged]

### What you should decide
1. Is your client surface mostly internal or external?
2. Do you have load-test data showing the wire-format saving matters?
3. ...

### Audit trail
| Topic | Codex R1 → R2 | Antigravity R1 → R2 | Claude R1 → R2 |
| --- | --- | --- | --- |
| ... | ... | ... | ... |
```

You get an answer **and** the dissent. You decide.

## Honesty rules — the part I actually care about

The hardest engineering problem here was not making three CLIs talk to
each other. It was preventing the protocol from regressing into agreement
theatre. Four rules are written directly into the skill prompt (they are
not optional):

1. **Do not silently degrade.** If only one external agent is reachable
   (auth failure, missing binary, timeout), stop and ask the user before
   running a degraded two-agent debate.
2. **Do not ratify a majority.** Two agents agreeing is *evidence*, not
   proof. If two agree but Claude suspects a shared blind spot — same
   training-data era, same canonical-but-wrong source — say so in the
   synthesis.
3. **Do not paper over disagreement.** A genuine post-refinement
   disagreement IS the deliverable on hard questions. Surface it.
4. **Do not invent positions.** Incoherent or off-topic responses are
   reported as such, not steel-manned into something they did not say.

These rules exist because **the failure mode of multi-agent systems is
convergence on confident wrong answers, not divergence into confusion**.
If you do not write the protocol to actively resist consensus, you will
get a worse answer than asking one model.

## Install

You need three things on your `PATH`:

- Claude Code (the CLI must support plugins + skills).
- OpenAI Codex CLI: `npm install -g @openai/codex`, then `codex login`.
- Google Antigravity CLI:
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`,
  then run `agy` once to sign in.

Then, inside Claude Code:

```bash
/plugin marketplace add https://github.com/raiaman15/carefully-crafted-plugins
/plugin install converge@carefully-crafted-plugins
```

The marketplace also ships the underlying `codex` and `agy` bridge
plugins. You can install only `converge` if you only want the debate
protocol, but it requires both CLIs to be present at runtime.

## Run it

```bash
/converge:debate "Should we move auth from session cookies to JWTs?"
```

Use it on:

- Hard technical decisions where multiple defensible answers exist.
- Security audits and correctness reviews on critical code paths.
- Recent or contentious topics where any one model could be stale or biased.

Do **not** use it for:

- Trivial questions you could answer alone.
- Routine coding tasks (just ask Claude Code directly).
- Time-sensitive requests — the full protocol is six external calls and
  takes several minutes.

## What this is not

It is not a benchmark, a ranker, a model-evaluation framework, or a
"better than ChatGPT" tool. It is a protocol for getting three frontier
models to tell you when they disagree, so you can decide on the disputed
points yourself.

It does not eliminate model errors. It surfaces them.

## Caveats I owe you up front

- **Antigravity CLI (`agy`) is three days old at time of writing.** Google
  launched it at I/O 2026 (replacing Gemini CLI). The wrapper here targets
  the documented `agy -p "<prompt>"` surface; the design degrades gracefully
  if a flag turns out to be different, but expect some rough edges.
- **`/agy:video` (Veo routing) is not end-to-end verified** without a live
  install. The skill flags this and reports if Veo isn't reached, rather
  than pretending a video was produced.
- **The synthesis is done by Claude.** That introduces a structural bias
  — the orchestrator is also a participant. The honesty rules above are
  what I've written to mitigate it, but if you can think of a cleaner
  arrangement, open an issue.

## What's next

The repo also includes two single-vendor bridges that `converge` builds on:
`codex` (seven skills — structured 5-section handoff, model + sandbox
controls, session resume) and `agy` (four skills for capabilities Claude
Code lacks: 1M-token long-context analysis on Gemini 3 Pro, Nano Banana
Pro image generation, Veo video generation, and a raw passthrough).

If you find a hard question where `/converge:debate` gives you a
genuinely better answer than any single model, drop the question + the
synthesis into an issue. I'd like to build the failure-mode corpus.

---

**Repo:** [github.com/raiaman15/carefully-crafted-plugins](https://github.com/raiaman15/carefully-crafted-plugins)

**License:** MIT.

Stars are how I'll know whether to keep building this. If the idea is
worth your second of an attention, ⭐ it.
