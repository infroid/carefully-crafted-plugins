---
name: converge
description: (context-hub:converge) Stage a four-phase Delphi debate among Claude, OpenAI Codex, and Google Antigravity on one hard question — each agent answers, critiques, refines, then Claude synthesizes consensus and remaining disagreement. Slash-command only: invoke as /contexthub:converge <question>. ~6 external CLI calls; reach for it only on genuinely hard architecture, design, or correctness questions where diverse perspectives are worth the cost.
argument-hint: <prompt to debate>
---

# Converge: Systematic Multi-Agent Debate

You orchestrate a four-phase Delphi-style debate among **three agents**:

1. **Claude** — you, in this session.
2. **OpenAI Codex** — `codex exec` (frontier reasoning, OpenAI lineage).
3. **Google Antigravity** — `agy -p` (Gemini 3 Pro, 1M context, Google lineage).

The goal is **not** to pick a winner. The goal is to **converge on a refined
answer that surfaces consensus, remaining disagreements, and the reasoning on
each side** — so the user can make an informed call.

## When to use this

Reach for `/contexthub:converge` only when diverse perspectives genuinely add
value:

- Hard technical decisions — architecture choices, tradeoff calls.
- Ambiguous design problems with multiple defensible answers.
- High-stakes analysis — security audits, correctness reviews.
- Recent or contentious topics where any single model could be stale or biased.

Do **not** use it for trivial questions, routine coding tasks, or time-
sensitive requests. The full protocol is 6 external CLI calls and takes
several minutes; the lightweight variant (Phase 1 + Phase 4 only) takes 2.

## Prerequisites

- `codex` CLI on PATH and signed in (`codex login`).
- `agy` CLI on PATH and signed in (run `agy` once interactively first).
- If either is missing, tell the user how to install it and **stop**. Do not
  silently fall back to a two-agent debate without their explicit permission.

## Your input

When invoked as `/contexthub:converge <prompt>`, the user's text arrives as
`$ARGUMENTS` — that is **the prompt under debate**. Refer to it as `Q`
throughout. Keep a clean text copy of `Q` to feed into every external call.

## Step 0: Detect available agents

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agent-availability.mjs
```

This prints `{ "claude": true, "codex": <bool>, "agy": <bool>, "count": N, "externalCount": M }`.
Run only the delegation steps below whose agent is `true`. When you skip a step
because its agent is absent, say so in one line. If `count` is 1 (Claude only),
do the work solo and tell the user once: *"Ran this with Claude only — install or
log into codex/agy for fuller cross-checks."*

**Lazy auth:** if a `codex`/`agy` call later fails with a not-logged-in / auth
error, treat that agent as unavailable for the rest of this run — drop its role,
print the degraded note, and continue with the remaining agents.

## Phase 0: Pre-flight — choose depth

Before any external calls, decide depth with the user (one quick line, not a
ceremony):

- **Full protocol** (default) — 4 phases, 6 external calls. The right choice
  for genuinely hard or high-stakes questions.
- **Lightweight** — Phase 1 + Phase 4 only. 2 external calls. Use when the
  user wants diverse views but not the full critique/refinement ceremony.

State which one you are running so the user is not surprised by the cost.

## Phase 1 — Independent first responses (parallel)

Each agent answers `Q` **without seeing the others**. This preserves diversity
— no anchoring on whoever spoke first.

1. Write **your own** first answer to `Q` and call it `CLAUDE_R1`. Self-
   contained, concrete, falsifiable. A paragraph or short structured
   response — not chain-of-thought, not "let me think about this".

2. In parallel (single message, two `Bash` calls), run:

   ```bash
   codex exec --skip-git-repo-check --sandbox read-only \
     -c model_reasoning_effort=high "$Q" 2>/dev/null
   agy -p "$Q" 2>/dev/null
   ```

   Capture stdout as `CODEX_R1` and `AGY_R1`.

3. If either call fails (binary missing, auth error, timeout), surface that
   to the user and ask whether to proceed as a 2-agent debate or stop.

## Phase 2 — Mutual critique (parallel) — skip in lightweight mode

Each external agent receives **all three Round 1 answers** and produces a
critique. You critique in your own context.

1. Write your critique, `CLAUDE_CRIT`. For each of `CODEX_R1` and `AGY_R1`,
   list: (a) what you agree with, (b) what you disagree with and **why**,
   (c) what's missing, (d) anything outright wrong (cite the evidence).

2. Load the **Phase 2 critique prompt** from
   `${CLAUDE_PLUGIN_ROOT}/skills/converge/references/critique-and-refinement-prompts.md`,
   substitute `<Q>`, `<CLAUDE_R1>`, `<CODEX_R1>`, `<AGY_R1>`, and invoke Codex
   and agy in parallel. Capture `CODEX_CRIT` and `AGY_CRIT`.

## Phase 3 — Refinement (parallel) — skip in lightweight mode

Each agent updates its answer in light of the critiques.

1. Update your own answer, `CLAUDE_R2`. **Explicitly state** which critique
   points you accepted and which you rejected, with one-sentence reasoning
   each. Do not silently change positions.

2. Load the **Phase 3 refinement prompt** from
   `${CLAUDE_PLUGIN_ROOT}/skills/converge/references/critique-and-refinement-prompts.md`.
   Send a tailored copy to each external agent (Codex gets `CODEX_R1` +
   critiques against it; agy gets `AGY_R1` + critiques against it). Invoke
   in parallel. Capture `CODEX_R2` and `AGY_R2`.

## Phase 4 — Synthesis (Claude only)

You produce the converged final response. **Do not** call any more external
agents. Structure it like this:

### Consensus
Points where all three agents now agree (after refinement). State each
briefly and concretely.

### Disagreements
For each genuine disagreement that survived refinement, surface:
- The competing positions (who holds what).
- Each side's strongest argument.
- **Your read** of which side is more defensible — or "genuinely uncertain,
  user call" if neither is clearly stronger.

### Recommendation
Your synthesized best answer. Build it from the consensus points; resolve
disagreements with your best judgment. **Flag explicitly** any judgment call
where you resolved on weak evidence, so the user can override.

### What the user should decide
1–3 specific decision points you are leaving to the user, each with the
relevant evidence compiled. Do not punt on everything — only on points where
the user's preferences or context legitimately matter.

### Audit trail (brief)
A small table showing how each agent's position evolved across rounds:

| Topic | Claude R1 → R2 | Codex R1 → R2 | Antigravity R1 → R2 |
|---|---|---|---|

Keep it tight — one row per major point, not per word.

## Lightweight variant (Phase 1 + Phase 4)

Skip Phases 2 and 3. Go straight from independent answers to synthesis. Tell
the user up front you are doing this so they know the depth. The synthesis is
the same structure, but **Disagreements** becomes dominant — agents had no
chance to move, so most differences remain.

## Honesty rules

These are **mandatory**, not optional:

- **Do not silently degrade.** If only one external agent is reachable,
  stop and get explicit user permission to run a 2-agent debate.
- **Do not ratify a majority.** Two agents agreeing is evidence, not proof.
  If two agree but you suspect a shared blind spot (same training-data era,
  same vendor's marketing line, same canonical-but-wrong source), say so in
  the synthesis.
- **Do not paper over disagreement.** A genuine disagreement after
  refinement IS valuable signal. Surface it — that is the deliverable.
- **Do not invent positions.** If an agent's response was incoherent or
  off-topic, say so plainly rather than steel-manning it into something it
  did not say.

### Degradation

Scale the debate to the agents available in the Step 0 report:

- **count 3** — full Delphi debate (Claude + codex + agy).
- **count 2** — a *2-way* debate, explicitly labeled "(Claude + codex)" or
  "(Claude + agy)" depending on which external agent is present.
- **count 1** — a direct Claude answer, prefixed
  "No debate possible (no external agents) —".
