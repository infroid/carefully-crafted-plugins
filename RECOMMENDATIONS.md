# Recommendations — Evolving carefully-crafted-plugins

Research-backed plan for becoming the world's best curated Claude Code
marketplace. Based on the agent-skills landscape as of mid-2026.

## 1. The skills ecosystem we're competing in

There are roughly 6,700 skills across 2,500 marketplaces ([claudemarketplaces.com](https://claudemarketplaces.com/)).
The market has stratified:

| Tier | Who | What | Quality bar |
|---|---|---|---|
| Official | [anthropics/skills](https://github.com/anthropics/skills) — 17 skills: `docx`, `pdf`, `pptx`, `xlsx`, `web-artifacts-builder`, `mcp-builder`, `webapp-testing`, `frontend-design`, `canvas-design`, `skill-creator`, `claude-api` | Reference implementations | De-facto SKILL.md spec |
| Vetted curators | [trailofbits/skills-curated](https://github.com/trailofbits/skills-curated), Agensi (8-point security checklist), Skills.sh (Vercel-backed) | Code-review every line of hooks/scripts | Trust signal |
| Methodology bundles | [obra/superpowers](https://github.com/obra/superpowers) (~20 skills), [compound-engineering](https://github.com/compounding-engineering) | Brainstorm → TDD → plan → subagent execution → verify | Battle-tested |
| Behavioral nudges | [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) (144k stars) | Anti-overreach rules in one CLAUDE.md | Maximum leverage per byte |
| Domain packs | bradleygolden/elixir, K-Dense-AI/scientific, Flutter packs | Framework-specific knowledge | Niche but sticky |
| Long tail | ~1,000+ "agent persona" plugins (`backend-architect`, `growth-hacker`, …) | Thin prompt wrappers | Mostly noise |

### What separates winners from noise

Four traits, repeatedly:

1. **They unlock a capability Claude genuinely lacks** — long context, image
   gen, persistent memory, a second model's opinion. Not a slightly better
   prompt.
2. **They enforce process, not just produce output** — Superpowers'
   TDD/plan/verify lifecycle; Karpathy's anti-overreach rules.
3. **They have observable handoffs** — files on disk you can audit, not
   opaque LLM-to-LLM streams.
4. **They cost almost nothing to load until needed** — strict progressive
   disclosure.

### Anthropic's published quality bar

From [skill-creator/SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md):

- **Descriptions must be "pushy"** — Claude under-triggers by default.
  Instead of "How to build a dashboard", write "How to build a dashboard.
  Use this skill whenever the user mentions dashboards, data
  visualization, internal metrics, or wants to display any kind of company
  data, even if they don't explicitly ask for a dashboard."
- **Progressive disclosure**: metadata (~100 words) always in context;
  SKILL.md body (<500 lines) when triggered; `references/` and `scripts/`
  loaded only on demand.
- **Evals/** with 2–3 realistic prompts + objectively verifiable
  assertions are table stakes.
- "Why" beats "MUST in all caps". Overuse of imperatives signals
  brittleness.
- No surprise content — skill body should match what the description
  promises.

## 2. Where we stand today

Our three plugins (`codex`, `agy`, `contexthub`) occupy a defensible,
under-served niche: **external-agent delegation with structured,
file-based handoffs**. The 5-section spec written to
`docs/carefully-crafted-plugins/handoffs/` is a real architectural
advantage — most multi-agent plugins do opaque streaming.

### Ahead of competitors on

- Observable handoffs (the spec file is the contract)
- Capability routing (image / long-context / reasoning each go to the
  right strong-suit agent)
- A real debate protocol (contexthub's four-phase structure)

### Behind on, measured against the 2026 bar

| Gap | Why it matters | Fix |
|---|---|---|
| No `evals/` directories | Anthropic's bar; needed to claim "tested" | Add 2–3 prompts + assertions per skill |
| Descriptions not "pushy" enough | Under-triggers when users describe needs without naming agents | Rewrite to list trigger contexts/keywords |
| Skill bodies are inline-only, no `references/` | Burns tokens even when only one path is used | Split rare paths into `references/foo.md` |
| Not listed on aggregators | Discovery is now external | Submit to claudemarketplaces.com, agentskills.io, trailofbits/skills-curated |
| Marketplace positioning is descriptive ("bridges") not aspirational | Doesn't compete with Superpowers' lifecycle narrative | Reposition as "the delegation layer for Claude Code" |

## 3. The plan — three tracks

### Track A — Sharpen the existing three (week 1–2)

1. **`evals/` per skill.** Pick 2–3 realistic prompts per skill, add
   `evals.json` with objective assertions (per Anthropic's spec). Wire into
   the existing `node --test` suite.
2. **Rewrite every frontmatter `description`** to follow the pushy
   template: *"What it does + when to trigger. Use this skill whenever
   users mention {X, Y, Z}, even if they don't explicitly ask for
   {Codex/Antigravity/multi-agent debate}."* Today
   `codex/skills/review/SKILL.md` will under-trigger because it doesn't
   claim ownership over phrases like "audit this", "find bugs in",
   "refactor".
3. **Split long bodies into `references/`.** The 223-line
   `contexthub/skills/converge/SKILL.md` should keep the workflow in
   SKILL.md and push phase-by-phase detail into `references/phase-*.md`.
   The `codex/skills/image` body should push the prompt-style guide into
   `references/`.
4. **Add `quality-bar.md`** at repo root describing our standards: pushy
   descriptions, evals required, <500 LOC bodies, observable handoffs,
   scripts for repeated patterns. Use it as the gate for accepting new
   plugins.
5. **Add `tools/lint-skill.mjs`** that validates SKILL.md frontmatter
   against the bar (description length, trigger keywords, body line
   count, presence of `evals/`). Run in CI. This *is* the marketplace's
   product.

### Track B — Build adjacent plugins that extend the delegation thesis (week 3–8)

Each compounds on existing architecture without competing with
Superpowers / claude-mem / Karpathy:

| New plugin | Job | Why it's defensible |
|---|---|---|
| **`gatekeeper`** | Pre-flight skill that reads the user's request and recommends *which* agent (Claude alone, Codex, Antigravity, or contexthub debate) based on task signature: long-context → agy; image → codex/agy; hard reasoning → codex; controversial design call → contexthub | Solves "users don't know which `/foo` to invoke" — the #1 reason multi-agent setups stall |
| **`echo`** | Conversational handoff: snapshot current Claude session state into a 5-section spec when switching agents mid-conversation (not just for one-shot delegation) | Extension of the existing spec-builder; nobody else does this |
| **`bench`** | Run the same prompt across all three agents on the user's actual codebase, log results, build a personalized routing table over time | Personalized → sticky; not replicable without the same multi-agent footprint |
| **`hush`** | Token/cost tracker across delegations; warns before expensive ops; suggests cheaper agent when the quality bar allows | Multi-agent setups make cost opaque — natural counterpart |
| **`replay`** | Given a Codex/Antigravity session ID, fetch its transcript and let Claude critique or continue it | Natural extension of `codex/skills/resume` |
| **`citation`** | Cross-agent fact-checking: when one agent makes a claim, a sibling verifies with file evidence before Claude accepts it | Directly attacks the Karpathy "silent wrong assumption" problem with a multi-agent twist |

If we ship two first: **`gatekeeper`** (highest impact on user perceived
value) and **`bench`** (highest moat — personalization compounds).

### Track C — Marketplace-as-product moves (parallel, ongoing)

1. **Submit to [trailofbits/skills-curated](https://github.com/trailofbits/skills-curated)** — they're the trust gatekeeper; being curated there is a discovery win.
2. **List on [claudemarketplaces.com](https://claudemarketplaces.com/) and [agentskills.io](https://agentskills.io)** — the npm-style aggregators.
3. **Write a positioning post** — "The Delegation Layer for Claude Code"
   — and pin it to README. Replace the current descriptive intro.
4. **Publish a benchmark page** ("Codex vs Antigravity vs Claude on real
   tasks") using `bench` data once it ships. Concrete evidence is the
   strongest sales tool in a crowded marketplace.

## 4. What NOT to build

Moats already too deep:

- Generic code-reviewer / planner / debugger persona plugins (1,000+ exist)
- Generic memory (`claude-mem` is the standard)
- Generic behavioral rules (Karpathy's CLAUDE.md owns the category)
- Document-creation skills (Anthropic's official `docx`/`pdf`/`pptx`/`xlsx`
  are unbeatable)
- TDD / lifecycle methodology (Superpowers owns this)

## 5. Suggested sequencing

| Weeks | Work |
|---|---|
| 1–2 | Track A in full: evals, pushy descriptions, `references/` split, `quality-bar.md`, `lint-skill.mjs` |
| 3–4 | Ship `gatekeeper` — single highest-value addition |
| 4 | Submit to Trail of Bits, list on aggregators, positioning README rewrite |
| 5–8 | Ship `bench`, then `echo`, then `hush`. Each compounds on the previous. |

## Sources

- [Anthropic — Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Anthropic skills repo](https://github.com/anthropics/skills) · [skill-creator SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
- [Claude Code skills documentation](https://code.claude.com/docs/en/skills)
- [Trail of Bits curated marketplace](https://github.com/trailofbits/skills-curated)
- [obra/superpowers](https://github.com/obra/superpowers)
- [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) · [TechTimes coverage](https://www.techtimes.com/articles/316798/20260518/karpathy-inspired-claudemd-passes-220000-combined-github-stars-four-rules-that-stop-ai-breaking.htm)
- [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) · [Chat2AnyLLM/awesome-claude-plugins](https://github.com/Chat2AnyLLM/awesome-claude-plugins)
- [claudemarketplaces.com](https://claudemarketplaces.com/) · [agentskills.io](https://agentskills.io)
- [Firecrawl — Best Claude Code Skills 2026](https://www.firecrawl.dev/blog/best-claude-code-skills)
- [Skills vs subagents vs slash commands — alexop.dev](https://alexop.dev/posts/claude-code-customization-guide-claudemd-skills-subagents/)
- [Claude Code Skills practical guide 2026 — DEV](https://dev.to/muhammad_moeed/claude-code-skills-a-practical-guide-for-2026-3f6p)
