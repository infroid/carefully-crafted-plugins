---
name: converge
description: Stage a short cross-provider debate among Claude, OpenAI Codex, and Google Antigravity on one hard question — independent answers by default, or full critique-and-refinement with --full. Slash-command only: invoke as /contexthub:converge <question>. Read-only decision evidence; reach for it only on genuinely hard architecture, design, or correctness questions.
argument-hint: [--full] <prompt to debate>
disable-model-invocation: true
---

# Converge: Cross-Provider Decision Evidence

You orchestrate a debate among **up to three participants**:

1. **Claude** — you, in this session.
2. **OpenAI Codex** — `codex exec`, an independent OpenAI-lineage agent.
3. **Google Antigravity** — `agy -p`, an independent Google-lineage agent.

The goal is **not** to pick a winner. The goal is to **converge on a refined
answer that surfaces consensus, remaining disagreements, and the reasoning on
each side** — so the user can make an informed call.

This skill supplies cross-provider decision evidence. Applicable Superpowers
process skills retain ownership of design, debugging, planning, execution,
verification, and delivery. Converge never writes a spec or plan, implements
code, verifies a branch, or launches `/contexthub:supervise` — and neither
`/contexthub:supervise` nor any Superpowers skill auto-launches Converge.

## When to use this

Reach for `/contexthub:converge` only when diverse perspectives genuinely add
value: hard technical decisions, ambiguous design problems with multiple
defensible answers, high-stakes analysis, or recent/contentious topics where
a single model could be stale or biased. Not for trivial questions, routine
coding tasks, or time-sensitive requests.

## Modes

- **Default** — Claude's own answer plus one independent answer from each
  *available* external agent, then Claude's synthesis. Up to 2 external CLI
  calls.
- **`--full`** — adds mutual critique and refinement before synthesis: every
  external agent sees all Round-1 answers, critiques the other two, then
  refines its own answer. Up to 6 external CLI calls.

Prefer default for ordinary "give me multiple views" requests. `--full` is
opt-in — never upgrade to it silently just because a question looks hard.

## Your input

Invoked as `/contexthub:converge [--full] <prompt>`. If `$ARGUMENTS` begins
with `--full` (optionally followed by whitespace), strip it, run in `--full`
mode, and treat the remainder as the question under debate, `Q`. Otherwise
run in default mode and all of `$ARGUMENTS` is `Q`. Keep a clean text copy of
`Q` to feed into every external call unchanged.

## Step 0: Detect participants, then report before any call

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agent-availability.mjs
```

Prints `{ "claude": true, "codex": <bool>, "agy": <bool>, "count": N, "externalCount": M }`.
`codex`/`agy` mean **a candidate binary is on PATH** — not that it is
authenticated or working. That is checked lazily at call time, below, not
here.

Before making any external call, state the exact participant set in one
line — e.g. *"Participants: Claude + Codex (Agy not found on PATH)."* Then
proceed with exactly that set: don't add an agent you didn't report, and
don't drop one you did report without saying so. If the user's request named
specific agents, honor that instead of the auto-detected default.

If asked why an agent is missing: Codex needs `codex login`; Antigravity
needs `agy` run once interactively to sign in. Mention this only if asked —
never block the run on it.

**Lazy auth:** if a reported `codex`/`agy` call later fails (not logged in,
auth error, non-zero exit), drop that agent for the rest of this run, say so
in one line, and continue with the remaining participants.

## Phase 1 — Independent first responses (parallel)

Each agent answers `Q` **without seeing the others** — no anchoring on
whoever spoke first.

1. Write **your own** first answer to `Q` and call it `CLAUDE_R1`. Self-
   contained, concrete, falsifiable — a paragraph or short structured
   response, not chain-of-thought.

2. In parallel (single message, one `Bash` call per available agent), run:

   ```bash
   codex exec --skip-git-repo-check --sandbox read-only \
     -c model_reasoning_effort=high "$Q" 2>/dev/null
   agy -p "$Q" 2>/dev/null
   ```

   Capture stdout as `CODEX_R1` and `AGY_R1` for whichever agents are in the
   participant set.

3. If a call fails despite being reported as a candidate, apply the lazy-auth
   rule above and continue with the remaining participants.

## Phase 2 — Mutual critique (parallel) — `--full` mode only

Skip this phase entirely in default mode; go straight to Phase 4.

Each external agent receives **all Round 1 answers** and critiques the other
two.

1. Write your critique, `CLAUDE_CRIT`. For each of `CODEX_R1` and `AGY_R1`
   present: (a) what you agree with, (b) what you disagree with and **why**,
   (c) what's missing, (d) anything outright wrong (cite the evidence).

2. Load the **Phase 2 critique prompt** from
   `${CLAUDE_PLUGIN_ROOT}/skills/converge/references/critique-and-refinement-prompts.md`,
   substitute `<Q>`, `<CLAUDE_R1>`, `<CODEX_R1>`, `<AGY_R1>`, and invoke each
   present external agent in parallel. Capture `CODEX_CRIT` and `AGY_CRIT`.

## Phase 3 — Refinement (parallel) — `--full` mode only

Skip this phase entirely in default mode.

Each agent updates its answer in light of the critiques.

1. Update your own answer, `CLAUDE_R2`. **Explicitly state** which critique
   points you accepted and which you rejected, with one-sentence reasoning
   each. Do not silently change positions.

2. Load the **Phase 3 refinement prompt** from
   `${CLAUDE_PLUGIN_ROOT}/skills/converge/references/critique-and-refinement-prompts.md`.
   Send a tailored copy to each present external agent (its own Round 1
   answer plus the critiques against it). Invoke in parallel. Capture
   `CODEX_R2` and `AGY_R2`.

## Phase 4 — Synthesis (Claude only)

Produce the converged final response. **Do not** call any more external
agents. Structure it like this:

### Consensus
Points where every participant now agrees. State each briefly and
concretely. (Default mode: agreement across the Round 1 answers, since there
was no critique/refinement round.)

### Disagreements
For each genuine disagreement, surface: the competing positions (who holds
what), each side's strongest argument, and **your read** of which side is
more defensible — or "genuinely uncertain, user call" if neither is clearly
stronger. In default mode this section usually dominates, since agents had
no chance to move toward each other.

### Recommendation
Your synthesized best answer, built from consensus and your best judgment on
disagreements. **Flag explicitly** any judgment call resolved on weak
evidence so the user can override it.

### What the user should decide
1–3 specific decision points left to the user, each with the relevant
evidence compiled. Only points where the user's preferences or context
legitimately matter — do not punt on everything.

### Audit trail (brief, `--full` mode only)
A small table showing how each participant's position evolved:

| Topic | Claude R1 → R2 | Codex R1 → R2 | Antigravity R1 → R2 |
|---|---|---|---|

One row per major point, not per word. Omit this section entirely in default
mode — there is no R2 to show.

## Honesty rules

Mandatory, not optional:

- **Do not ratify a majority.** Two agents agreeing is evidence, not proof.
  If you suspect a shared blind spot (same training-data era, same vendor's
  marketing line, same canonical-but-wrong source), say so in the synthesis.
- **Do not paper over disagreement.** A genuine disagreement after
  refinement IS valuable signal — surface it, that is the deliverable.
- **Do not invent positions.** If an agent's response was incoherent or
  off-topic, say so plainly rather than steel-manning it into something it
  did not say.
- **Do not silently change scope.** Report the participant set once, at
  Step 0, and hold to it for the rest of the run (lazy-auth drops excepted,
  which are themselves reported when they happen).

## Side effects

None. No files are written, no state is persisted, no repository changes
are made — everything above lives in this conversation.
