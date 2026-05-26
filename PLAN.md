# PLAN — The Multi-Agent Software Lifecycle

> An opinionated, end-to-end development methodology in the spirit of
> Superpowers — but where every phase routes to the strongest specialist
> available across Claude, OpenAI Codex, and Google Antigravity. The
> whole is more capable than any single agent.

## Thesis

Superpowers proved that an opinionated lifecycle (brainstorm → plan →
TDD → review → verify → ship) beats ad-hoc prompting. But Superpowers
runs that lifecycle on a single agent, so every phase inherits that
agent's ceiling.

We have three agents already wired in. The opportunity is a lifecycle
where:

- **Claude orchestrates** — owns the conversation, state, and decisions
- **Codex executes hard reasoning and runs Playwright** — capabilities
  Claude lacks
- **Antigravity sees the whole repo** — 1M tokens of context Claude
  can't fit
- **Three-way debate is available** as a primitive when divergent
  thinking matters

The result: a methodology Superpowers cannot match on any phase where
multi-agent capability dominates single-agent capability.

## Architecture — two layers

### Layer 1: Capability primitives (existing plugins, sharpened)

These stop being the user-facing product and become building blocks the
lifecycle calls into.

- **`codex`** — image gen, hard reasoning, code review, Playwright
  browser, exec/resume
- **`agy`** — 1M-token long-context, Nano Banana image, Veo video, exec
- **`contexthub`** — four-phase debate primitive

Track A from RECOMMENDATIONS.md still applies here: pushy descriptions,
`evals/` per skill, `references/` split, `quality-bar.md`,
`lint-skill.mjs`. The primitives must be airtight before the lifecycle
leans on them.

### Layer 2: The lifecycle plugin

Working name: **`forge`**. One plugin, multiple lifecycle-phase skills.
Each skill is a phase of the methodology. Each phase delegates to the
right specialist for that phase.

## Phase-by-phase design

| # | Skill | Primary | Specialist call(s) | Why multi-agent wins |
|---|---|---|---|---|
| 1 | `forge:spec` | Claude | `contexthub:converge` for contested design calls | Divergent thinking needs ≥3 independent minds |
| 2 | `forge:plan` | Claude drafts | `codex:reason` stress-tests for missed edge cases; `agy:longcontext` verifies the plan covers every callsite | Claude alone misses combinatorial gaps + can't see the full repo |
| 3 | `forge:tdd` | Claude (RED/GREEN/REFACTOR in a worktree) | `codex:reason` on hard subproblems; `codex:browser` for live docs | Routing relieves Claude's weak spots without losing the loop |
| 4 | `forge:review` | Claude in-context | `codex:review` (fresh eyes, no authoring bias) + `agy:longcontext` (whole-repo regression scan) | Three-way review > single reviewer, by construction. Catches the "orthogonal change" Karpathy worry. |
| 5 | `forge:verify` | Claude | `codex:browser` runs Playwright; `agy:longcontext` checks blast radius across untouched modules | Claude can't drive a browser and can't fit the whole repo |
| 6 | `forge:debug` | Claude orchestrates | `codex:reason` (high-effort hypothesis generation); `agy:longcontext` (where else does this bug pattern live?) | Codex high-effort > Claude on combinatorial root-cause |
| 7 | `forge:ship` | Claude | Optional `contexthub:converge` retro on hard design calls | Captures lessons across all three agents |

## Why this beats Superpowers

Same lifecycle shape, every phase strictly stronger:

- Superpowers can't fit 1M tokens → its review misses orthogonal regressions. `forge:review` doesn't.
- Superpowers can't run Playwright → its verify is "I think it works." `forge:verify` actually verifies.
- Superpowers can't get a second model's opinion → its brainstorm is one perspective. `forge:spec` gets three.
- Superpowers can't reason at high effort on a stuck subproblem without burning Claude tokens. `forge:tdd` and `forge:debug` route to Codex.

## Mechanics absorbed into `forge`

Of the six "delegation thesis" plugins from the prior recommendations,
five fold into `forge` as internal mechanics rather than user-facing
plugins:

| Concept | Where it lives in `forge` |
|---|---|
| `gatekeeper` | Routing logic inside every `forge:*` skill — each phase knows when to delegate vs. stay in Claude |
| `echo` | The handoff snapshot mechanism between phases (and into/out of specialists) |
| `bench` | Personalized routing table that `forge` consults — over time, learns which specialist wins for *this* codebase |
| `citation` | Cross-agent verification step inside `forge:review` |
| `replay` | Subsumed into `codex:resume` / `agy:exec` resumes triggered from inside `forge:debug` |
| `hush` | Stays standalone — cost is orthogonal to lifecycle and reusable outside `forge` |

## Open design decisions

Before implementation begins, three calls to make:

1. **Public name.** `forge` is a placeholder. Alternatives: `loom`,
   `relay`, `convoy`, `meridian`, `triad`, `compose`. Pick one before
   writing user-facing copy.
2. **One mega-plugin or one plugin per phase?** Lean mega-plugin
   (`forge` with seven skills inside): single install, tighter handoffs
   between phases, one version number. Trade-off: users who only want
   `forge:review` carry the whole bundle. Acceptable — the bundle is
   light because primitives live in separate plugins.
3. **Graceful degradation when a specialist is missing.** If `agy`
   isn't installed, should `forge:review` skip the long-context pass or
   refuse to run? Recommendation: skip with a visible warning, never
   refuse — but track in `bench` so the user sees what they're missing.

## Marketplace positioning (revised)

The README/website pivots from "bridges between coding agents" to:

> **The multi-agent software lifecycle.**
> What Superpowers does, with three minds.
> Claude orchestrates. Codex executes hard reasoning. Antigravity sees
> the whole repo. Every phase routes to the strongest specialist.

`forge` is the headline. The capability primitives (`codex`, `agy`,
`contexthub`) are documented but de-emphasized — they exist for users
who want à la carte, but the recommended path is `forge`.

## Sequencing

| Week | Work | Why this order |
|---|---|---|
| 1–2 | Track A from RECOMMENDATIONS.md in full | Primitives must be airtight before lifecycle leans on them |
| 3–4 | Ship `forge:spec` + `forge:plan` | Front-of-funnel pair, highest visible value, easiest to demo |
| 5–6 | Ship `forge:review` + `forge:verify` | Back-of-funnel pair, where multi-agent superiority is most provable (long-context regression + Playwright) |
| 7–8 | Ship `forge:tdd` + `forge:debug` | Fill in the middle; routing logic now well-tested |
| 9 | Ship `forge:ship` + `forge:onboard` walkthrough; rewrite README/website around the lifecycle | The story is now complete; positioning catches up |
| 10+ | Build `bench` data collection; iterate routing logic on real usage; submit to Trail of Bits | Marketplace moves on a battle-tested product |

## Track C (marketplace moves) unchanged

The marketplace-as-product work from RECOMMENDATIONS.md still applies:
list on aggregators, submit to Trail of Bits, publish benchmark
evidence once `bench` data exists. The lifecycle gives it a stronger
story to tell.

## What stays out of scope

Same exclusions as RECOMMENDATIONS.md, reinforced by the multi-agent
focus:

- No generic single-agent persona plugins
- No generic memory (claude-mem) or behavioral rule files (Karpathy)
- No document-creation skills (Anthropic owns this)
- Specifically: no lifecycle phase that doesn't have a clear
  multi-agent advantage. If a phase is just "Claude does X," it belongs
  in CLAUDE.md, not in `forge`.

This last rule is the quality bar for `forge` skills. Every phase must
answer: *what does multi-agent unlock that single-agent can't?* If the
answer is "nothing," the phase doesn't ship.
