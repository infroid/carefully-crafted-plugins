# Quality Bar

Every skill in this marketplace must clear every gate below. No
exceptions. The bar is not "is this useful?" — the bar is "does the
marketplace get sharper with this added?"

## 1. Context budget

Tighter than Anthropic's official bar across the board, because every
installed skill's frontmatter lives in Claude's preamble on every turn:

| Element | Budget |
|---|---|
| Frontmatter `description` | 80–100 words (hard ceiling 120) |
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

## Enforcement

`tools/lint-skill.mjs` (to be built) enforces gates 1–3 in CI. Gates
4–8 are reviewed manually at PR time. A skill that fails any gate
doesn't merge.
