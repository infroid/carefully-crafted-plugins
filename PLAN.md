# PLAN — The Multi-Agent Software Lifecycle

> An opinionated, end-to-end development methodology in the spirit of
> Superpowers — but where every phase routes to the strongest specialist
> available across Claude, OpenAI Codex, and Google Antigravity. The
> whole is more capable than any single agent.

## Thesis

A **small, opinionated, lightweight set of carefully-crafted plugins**
— sufficient for everything multi-agent unlocks, refusing to sprawl
into a 2,800-skill marketplace. The discipline is the product.

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

**First-class user-facing skills AND building blocks the lifecycle
calls into.** Users who want à la carte capability access keep direct
invocation; users who want the full methodology go through `forge`.
Both paths are documented, marketed, and tested.

- **`codex`** — image gen, hard reasoning, code review, Playwright
  browser, exec/resume
- **`agy`** — 1M-token long-context, Nano Banana image, Veo video, exec
- **`contexthub`** — four-phase debate primitive

Track A from RECOMMENDATIONS.md still applies here: pushy descriptions,
`evals/` per skill, `references/` split, `quality-bar.md`,
`lint-skill.mjs`. The primitives must be airtight because they're now
load-bearing in two ways — as the user-facing surface AND as the engine
of the lifecycle.

### Layer 2: The lifecycle plugin

Working name: **`forge`**. One plugin, multiple lifecycle-phase skills.
Each skill is a phase of the methodology. Each phase delegates to the
right specialist for that phase.

## Naming convention

A real problem already: `codex:image` and `agy:image` collide. Claude
auto-routes to `codex:image` every time because two skills sharing a
name with overlapping descriptions can't be disambiguated by the
trigger model. As more plugins ship, this compounds.

The rules going forward:

1. **Plugin prefix is mandatory** (Claude Code platform rule).
2. **Skill names must be unique across the entire marketplace**, not
   just within a plugin. No two skills share a name even if they sit
   under different plugins.
3. **Capability skills name themselves by the distinguishing
   technology, not the generic capability.** `codex:imagegen` (OpenAI
   gpt-image-2) and `agy:nanobanana` (Google Nano Banana Pro) — never
   two skills called `image`.
4. **Lifecycle skills name themselves by phase**: `forge:spec`,
   `forge:plan`, `forge:review`. `forge:review` and `codex:review` are
   intentionally different things — the plugin prefix makes the
   distinction explicit and descriptions disambiguate for auto-trigger.
5. **Router skills for multi-provider capabilities live in `forge`**
   and use the generic capability name. `forge:image` decides between
   `codex:imagegen` and `agy:nanobanana` based on the task (style,
   speed, quality, prior preferences). This is the "let the system
   choose" entry point.
6. **Raw passthrough keeps `exec`** — `codex:exec` and `agy:exec` are
   explicit-by-construction; users always type the prefix.

### Rename plan

| Current | New | Reason |
|---|---|---|
| `codex:image` | `codex:imagegen` | Tech-specific (gpt-image-2) |
| `agy:image` | `agy:nanobanana` | Tech-specific (Nano Banana Pro) |
| `agy:video` | `agy:veo` | Tech-specific (Veo) |
| `agy:longcontext` | `agy:longctx` | Shorter, no collision |
| `codex:browser` | `codex:playwright` | Tech-specific |
| `codex:reason`, `codex:review`, `codex:resume`, `codex:setup`, `codex:exec`, `agy:exec`, `contexthub:converge` | unchanged | No collision today |

Ship as a major version bump. Keep old names as deprecated aliases for
one minor version with a visible warning, then drop. Migration must be
painless or users will resent it.

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

## Token efficiency — the USP

Single-agent lifecycles can't grade effort because they only have one
gear. We have three agents, each with multiple effort levels and model
tiers. **The differentiator: every task is graded for difficulty
before any specialist runs, and effort scales to match.**

Today's bridge defaults are "best model + highest effort + lowest
verbosity" (commit f1dded5) — correct for hard tasks, expensive
overkill for easy ones. The triage layer fixes this.

### The triage primitive

A new primitive, **`triage`** — shipped as its own micro-plugin so
direct primitive users get token efficiency without installing the
full lifecycle. `forge` takes a hard dependency on it.

**Input:** task description (from user, or from a lifecycle phase).

**Output:** structured plan written to
`docs/carefully-crafted-plugins/triage/`:

```json
{
  "decomposition": "single" | "subtasks",
  "tasks": [
    {
      "id": "t1",
      "summary": "...",
      "difficulty": "low" | "medium" | "hard",
      "suggested_specialist": "claude" | "codex" | "agy" | "contexthub",
      "suggested_effort": "low" | "medium" | "high",
      "suggested_model": "..."
    }
  ]
}
```

### Difficulty heuristics

| Difficulty | Signals |
|---|---|
| Low | Single-file edit; well-defined spec; no ambiguity; no cross-cutting impact; no research required |
| Medium | 2–3 files; standard pattern; some ambiguity but solvable in-context |
| Hard | Cross-cutting; ambiguous spec; root-cause debugging from symptom; novel architecture; performance work; anything requiring 1M context to verify |

### Effort mapping

| Difficulty | Codex effort | Codex model | Antigravity model | Claude routing |
|---|---|---|---|---|
| Low | `low` | mini-tier | Flash-tier | Stay in Claude; don't delegate |
| Medium | `medium` | best | Pro | Single specialist if needed |
| Hard | `high` | best | Pro (full 1M) | Multi-agent (contexthub or sibling verification) |

### How it plugs in

Three integration points:

1. **Inside every `forge:*` lifecycle skill**, call `triage` first.
   The skill uses the result to choose specialist + effort. Users get
   token efficiency for free.
2. **Inside primitive bridges** (`codex-invoke.mjs`, `agy-invoke.mjs`),
   if a triage result file is present for the current task, use it.
   Otherwise fall back to defaults — see point 3.
3. **Lower the bridge defaults.** Commit f1dded5 sets max effort.
   Lower the floor to `medium`, and let triage escalate to `high` only
   when difficulty warrants it. Direct `/codex:reason` users who skip
   triage spend fewer tokens by default for the same correctness on
   most tasks. Hard tasks call triage or pass `--effort high`
   explicitly.

### The USP claim

> The only multi-agent lifecycle that grades every task before it runs,
> matching effort to difficulty across three providers. Spend 5–10×
> fewer tokens on the easy work that fills 80% of the day, and full
> effort where it actually matters.

Concrete proof requires `bench` data once the lifecycle ships.

## Context discipline & trigger probability

Skills cost context. Every installed skill's frontmatter sits in
Claude's preamble on every turn whether used or not. A bloated
marketplace makes Claude slower and dumber for everyone who installs
it. Our north star: **maximum trigger probability per byte of context
loaded.**

Two halves of the same principle:

- **Pushy descriptions** earn the trigger. Anthropic explicitly warns
  Claude under-triggers by default — we counter aggressively.
- **Tiny bodies** earn the right to live in preamble. If our skills
  bloat context, users uninstall. If our skills earn their byte budget,
  they stay forever.

### Per-skill context budget

Tighter than Anthropic's official bar across the board:

| Element | Our budget | Anthropic's bar | Why we go tighter |
|---|---|---|---|
| Frontmatter `description` | 80–100 words | ~100 words | Stays in preamble every turn; must be pushy enough to win triggers without bloating |
| `SKILL.md` body | <200 lines | <500 lines | Loaded on trigger; small enough to read fast, narrow enough to stay sharp |
| `references/*.md` | unlimited | unlimited | Loaded only on explicit reference from body |
| `scripts/*` | unlimited | unlimited | Never in context |

The `lint-skill.mjs` from Track A enforces these as CI gates. A skill
that exceeds budget either splits into `references/` or doesn't ship.

### Pushiness template

Every skill description must follow this shape:

> {What it does in one sentence}. Use this skill whenever the user
> mentions {primary triggers}, asks for {related actions}, or needs
> {underlying capability} — even if they don't explicitly say
> "{plugin name}" or "{specialist name}". This is the default for
> {category} in this marketplace.

The closing claim — *"this is the default for {category} in this
marketplace"* — is the pushiness lever. It tells Claude that in our
installed set, *we own this category*. Combined with a deliberately
small set of plugins, this maximizes the odds Claude reaches for us
first.

### Examples

**`codex:imagegen`**

- ❌ "Generate images with OpenAI Codex."
- ✅ "Generate images using gpt-image-2 (Codex's built-in image gen).
  Use this skill whenever the user mentions images, icons, logos,
  illustrations, screenshots, mockups, diagrams, or any visual asset —
  even if they don't say 'Codex' or 'OpenAI'. This is the default
  image-generation path in this marketplace."

**`codex:reason`**

- ❌ "Run high-effort reasoning via Codex."
- ✅ "Delegate hard reasoning to OpenAI Codex at high effort. Use this
  skill whenever the user asks for help with algorithm design, complex
  debugging hypotheses, math, optimization problems, architecture
  decisions, or anything they describe as 'hard', 'tricky', 'I'm stuck
  on', or 'I can't figure out' — even if they don't mention Codex.
  This is the default deep-reasoning path in this marketplace."

**`agy:longctx`**

- ❌ "Long-context analysis via Antigravity."
- ✅ "Analyze code at 1M-token scale using Gemini 3 Pro via Antigravity.
  Use this skill whenever the user asks about cross-file impact,
  whole-repo audits, finding all callsites, regression risk, or any
  question that needs reading more code than Claude can fit — even if
  they don't mention Antigravity, Gemini, or long context. This is the
  default whole-repo analysis path in this marketplace."

Every existing skill gets rewritten to this standard as part of Track A.

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
4. **Triage as its own micro-plugin or a `forge` skill?**
   Recommendation: its own plugin. Direct primitive users (the people
   typing `/codex:reason` without ever installing `forge`) deserve
   token efficiency too.
5. **Renaming = breaking change. Deprecation alias or hard cut?**
   Recommendation: ship both names for one minor version with a
   deprecation warning, then drop. Painless migration or users
   resent it.
6. **Default effort floor when no triage was run.** Recommendation:
   `medium` for Codex, equivalent for Antigravity. Conservative
   compared to today's `highest` — saves tokens by default, escalates
   on demand.

## Marketplace positioning (revised)

> **A small, opinionated set. Sufficient for what we cover. Refuses to
> sprawl.**
>
> Most marketplaces race to plugin count — 2,800 skills, 425 plugins,
> 200 agents. Ours is the opposite: a tight set that an experienced
> developer adopts wholesale because every plugin is best-in-class for
> its domain, and the set as a whole covers every capability worth
> multi-agenting.

Three reinforcing stories on the README/website:

> **1. The multi-agent software lifecycle.** What Superpowers does,
> with three minds. Claude orchestrates. Codex executes hard reasoning.
> Antigravity sees the whole repo. Every phase routes to the strongest
> specialist.

> **2. Token-efficient by default.** Every task is graded for
> difficulty before any specialist runs. Spend 5–10× fewer tokens on
> the easy work that fills 80% of the day, full effort where it
> matters.

> **3. Lightweight by construction.** A handful of plugins, each
> sharper than the marketplace alternatives. Pushy descriptions earn
> the trigger; tiny bodies keep your context clean. Install all of
> them; that's the point.

`forge` is the headline. The primitives are the foundation. `triage`
is the efficiency layer. That's the whole set — and we don't add to it
unless the new plugin earns its place.

## Sequencing

| Week | Work | Why this order |
|---|---|---|
| 1 | **Naming migration** — rename per the convention, ship a major bump with deprecated aliases, document migration in README | Collision is a live bug today; unblocks everything else |
| 1–2 | Track A from RECOMMENDATIONS.md in full — primitives sharpened (pushy descriptions, evals, `references/`, quality bar, lint) | Primitives must be airtight: load-bearing as user surface AND lifecycle engine |
| 2–3 | **Ship `triage` micro-plugin + lower bridge defaults from `highest` to `medium`** | Token-efficiency USP must exist before the lifecycle leans on it; immediate user-visible win on direct primitive use |
| 4–5 | Ship `forge:spec` + `forge:plan` | Front-of-funnel pair, highest visible value, easiest to demo |
| 6–7 | Ship `forge:review` + `forge:verify` | Back-of-funnel pair, where multi-agent superiority is most provable (long-context regression + Playwright) |
| 8–9 | Ship `forge:tdd` + `forge:debug` | Fill in the middle; routing logic now well-tested |
| 10 | Ship `forge:ship` + `forge:onboard` walkthrough; rewrite README/website around the dual narrative (lifecycle + primitives + token efficiency) | The story is now complete |
| 11+ | Build `bench` data collection; publish token-efficiency benchmarks; submit to Trail of Bits | Marketplace moves backed by hard numbers |

## Track C (marketplace moves) unchanged

The marketplace-as-product work from RECOMMENDATIONS.md still applies:
list on aggregators, submit to Trail of Bits, publish benchmark
evidence once `bench` data exists. The lifecycle gives it a stronger
story to tell.

## What stays out of scope

Same exclusions as RECOMMENDATIONS.md, reinforced by the multi-agent
focus and the discipline of staying small:

- No generic single-agent persona plugins
- No generic memory (claude-mem) or behavioral rule files (Karpathy)
- No document-creation skills (Anthropic owns this)
- No framework-specific packs (Elixir, Flutter, etc.)
- No lifecycle phase that doesn't have a clear multi-agent advantage.
  If a phase is just "Claude does X," it belongs in CLAUDE.md, not in
  `forge`.

### The hard admission rule

A new plugin or skill ships only if it clears **all three** gates:

1. **Category exclusivity** — solves a category no existing plugin in
   our set already solves.
2. **Differentiator** — uses multi-agent capability OR token-grading
   as its core mechanic. If neither, it's not for us.
3. **Context budget** — meets the per-skill budget (80–100 word
   description, <200-line body) and follows the pushy template.

Failing any gate, it doesn't ship. The bar is not "is this useful?"
The bar is "does the marketplace get sharper, smaller, or more
opinionated with this added?" If not, the answer is no — even for
genuinely useful skills.

This is the quality bar in one rule: **every plugin must justify the
context it costs every user on every turn.**
