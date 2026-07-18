# Quality Bar

Every skill in this marketplace must clear every gate below. No
exceptions. The bar is not "is this useful?" — the bar is "does the
marketplace get sharper with this added?"

## 1. Context budget

Tighter than Anthropic's official bar across the board, because every
installed skill's frontmatter lives in Claude's preamble on every turn:

| Element | Budget |
|---|---|
| Frontmatter `description` | 30–120 words. Aim tight: pushy beats verbose. The minimum is "enough triggers + a closing claim"; the maximum is the hard ceiling. |
| `SKILL.md` body | <200 lines (hard ceiling 250) |
| `references/*.md` | unlimited — loaded on demand |
| `scripts/*` | unlimited — never in context |

Bodies that exceed 200 lines must split into `references/`. Skills that
can't compress into the description budget don't ship.

## 2. Pushy description template

Every description follows this shape:

> {What it does in one sentence}. Use whenever the user mentions
> {primary triggers}, asks for {related actions}, or needs {underlying
> capability} — even if they don't explicitly say "{plugin name}" or
> "{specialist name}". {Default-for-category claim, OR slash-command-only
> note if explicit-only}.

The closing line is the pushiness lever:

- **Default-for-category claim** (auto-triggers welcome): *"Default
  {category} path in this marketplace."*
- **Slash-command-only note** (explicit-only): *"Slash-command only:
  invoke as /{plugin}:{skill} <args>."*

Pick one. Never both. Skills that auto-trigger must own a category;
slash-only skills must say so.

## 3. Naming convention

1. Plugin prefix is mandatory (Claude Code platform rule).
2. Skill names are unique across the entire marketplace.
3. Capability skills name themselves by the distinguishing technology
   (`imagegen`, `nanobanana`, `playwright`, `veo`, `longctx`), never by
   the generic capability (`image`, `browser`).
4. Lifecycle skills use phase names (`forge:spec`, `forge:review`).
5. Router skills for multi-provider capabilities live in `forge` with
   the generic capability name (`forge:image`).
6. Raw passthroughs use `exec` — the plugin prefix disambiguates.

## 4. Differentiator gate

A new skill ships only if it uses **multi-agent capability** or
**token-grading** (effort/difficulty routing) as its core mechanic. If
neither, it doesn't fit our thesis.

We don't ship: generic persona agents, framework-specific packs,
behavioral CLAUDE.md rules, document-creation skills, memory layers,
single-agent methodology bundles. Those markets are already won.

## 5. Category exclusivity

A new skill ships only if it solves a category no existing skill in
this set already covers. We don't ship two image skills for the same
provider, two reasoning skills, etc.

The exception: lifecycle skills (`forge:*`) and primitives can share a
category — the lifecycle skill orchestrates, the primitive executes.
That's complement, not duplicate.

## 6. Audit & observability

Every delegation writes a structured artifact to disk:

- `codex` bridge writes the 5-section spec to `docs/carefully-crafted-plugins/handoffs/`
- `triage` (when shipped) writes the difficulty plan to `docs/carefully-crafted-plugins/triage/`
- `agy` bridge logs prompts on `--verbose`

Opaque LLM-to-LLM streams are not acceptable. Every multi-agent call
must be auditable after the fact.

## 7. Evals

Every auto-triggering skill ships with `evals/evals.json` containing
2–3 realistic prompts and programmatically verifiable assertions per
Anthropic's spec. Slash-command-only skills are exempt — they can't be
mis-triggered.

## 8. Critical evaluation

Every skill that returns specialist output must apply
`reference/critical-evaluation.md` before relaying — sanity-check
claims, flag disagreements, never silently switch positions.

## 9. Complementarity gate

Superpowers owns software-development methodology. A new Carefully
Crafted skill is rejected if its primary purpose is any of:

```text
specification refinement, implementation planning, TDD enforcement,
systematic debugging, generic code review, completion verification,
worktree setup, plan execution, or branch finishing
```

Those are Superpowers' job (`superpowers:brainstorming`,
`superpowers:writing-plans`, `superpowers:test-driven-development`,
`superpowers:systematic-debugging`, `superpowers:requesting-code-review`
/ `superpowers:receiving-code-review`,
`superpowers:verification-before-completion`,
`superpowers:using-git-worktrees`, `superpowers:executing-plans`,
`superpowers:finishing-a-development-branch`). Carefully Crafted does
not re-implement them, wrap them, or offer a competing path through
them. This is why `contexthub` declares a hard, unversioned dependency
on upstream `superpowers` (see `plugins/contexthub/.claude-plugin/plugin.json`)
rather than duplicating any of that methodology.

A skill is allowed only when its core value is one of:

- **External-provider transport** — moving a request/response across a
  process boundary to a different AI CLI (Codex, Antigravity) that
  Claude cannot reach on its own.
- **Bounded orchestration** — sequencing multiple external calls with
  hard limits (call count, token budget, timeout) that a human
  wouldn't want to hand-drive.
- **Evidence compression** — turning a large or noisy external result
  (a long review, a 1M-token scan) into a small, lossless, auditable
  index Claude can act on.
- **Cross-provider deliberation** — structured multi-agent debate
  (`contexthub:converge`) where the value is genuinely having more than
  one model in the room, not methodology.

If a proposed skill's pitch reduces to "do TDD/planning/debugging/review
but through us," it fails this gate regardless of how it's phrased.

### Exception: `/codex:review`

`/codex:review` is retained despite sitting next to Superpowers' review
territory, because it is narrowly scoped as transport, not methodology:

- It is a **manual, read-only** transport for an independent Codex
  audit, invoked only when the user or an active Superpowers workflow
  explicitly requests a second opinion from Codex.
- It **preserves the exact Codex result** verbatim and exposes a
  **bounded, all-finding index** (evidence compression), rather than
  summarizing or editorializing it away.
- It keeps **Claude's annotations visibly separate** from Codex's
  findings — no silent merging of the two voices.
- It does **not** select review methodology, apply refactors, verify
  completion, or supersede any Superpowers review skill.
- Actionable finding IDs it surfaces are handed off to
  `superpowers:receiving-code-review` for triage and response — the
  methodology of *what to do* with a finding stays with Superpowers.

Any future skill claiming a similar exception must clear the same five
bars: manual invocation, verbatim preservation, bounded compression,
visible separation of voices, and explicit handoff of actionable output
back into the relevant Superpowers skill.

## Enforcement

`tools/lint-skill.mjs` (to be built) enforces gates 1–3 in CI. Gates
4–9 are reviewed manually at PR time. A skill that fails any gate
doesn't merge.
