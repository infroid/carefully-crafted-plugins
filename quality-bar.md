# Quality Bar

Every skill in this marketplace must clear every gate below. No
exceptions. The bar is not "is this useful?" — the bar is "does the
marketplace get sharper with this added?"

## 1. Context budget

Tighter than Anthropic's official bar across the board, because every
installed skill's frontmatter lives in Claude's preamble on every turn:

| Element | Budget |
|---|---|
| Frontmatter `description` | Manual-only (`disable-model-invocation: true`): 8–60 words. Model-invocable: 15–60 words. Same 60-word ceiling either way — that protects Claude's always-on context regardless of invocation mode. |
| `SKILL.md` body | <200 lines (hard ceiling 250) |
| `references/*.md` | unlimited — loaded on demand |
| `scripts/*` | unlimited — never in context |

Bodies that exceed 200 lines must split into `references/`. Skills that
can't compress into the description budget don't ship.

## 2. Pushy description template & native invocation metadata

Every description follows this shape:

> {What it does in one sentence}. Use whenever the user mentions
> {primary triggers}, asks for {related actions}, or needs {underlying
> capability} — even if they don't explicitly say "{plugin name}" or
> "{specialist name}".

**Manual-only vs. model-invocable is a native frontmatter fact, not a
prose convention.** Set `disable-model-invocation: true` to make a
skill explicit-invocation only: this defers the skill's larger body
cost (350 tok–2k, paid only on invocation) and disables automatic
invocation entirely — the skill runs only when the user explicitly
invokes it (`/{plugin}:{skill}`), matching current Claude Code
platform behavior for that field. It does **not** remove the skill's
name/description from Claude's always-on context: measured manual-only
skills carry ~60–100 tok always-on, the same order as model-invocable
ones. The field's real value is invocation control and deferred body
cost, not a context-free skill. A skill with the field absent (or
`false`) is model-invocable and **must** include trigger language
("Use whenever …", "Reach for …") so Claude knows when to fire it —
this is a hard lint error, not a style note. A model-invocable skill
with no routing language spends always-on context on every turn while
giving Claude nothing to route on.

A description may still add "Slash-command only: invoke as
/{plugin}:{skill} <args>." for human readability, but that phrase is
never authoritative by itself — the linter rejects a "Slash-command
only" claim made without `disable-model-invocation: true` also set in
frontmatter. The frontmatter field is the only thing that actually
turns off auto-invocation; prose alone cannot.

The linter reads frontmatter more strictly than YAML does, deliberately:
its accept set must be a **subset** of what a real parser accepts. A key
written without the `": "` separator (`disable-model-invocation:true`)
or a duplicated key is a hard error, because in both cases the platform
and the linter could otherwise disagree about which keys exist — and a
rule keyed on a field the platform never sees guards nothing.

## 3. Naming convention

1. Plugin prefix is mandatory (Claude Code platform rule).
2. Skill names are unique across the entire marketplace.
3. Capability skills name themselves by the distinguishing technology
   (`imagegen`, `nanobanana`, `reason`), never by the generic capability
   (`image`, `browser`).
4. Lifecycle/phase-named skills (`spec`, `plan`, `tdd`, `review`, `verify`,
   `debug`, `ship`, `triage`) are not shipped here — gate 9 reserves that
   territory for Superpowers. `contexthub`'s only skills are `converge`
   and `supervise`, and neither is phase-named.
5. Raw passthroughs use `exec` — the plugin prefix disambiguates.

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

## 6. Audit & observability

Not every delegation writes a structured artifact to disk — only
**structured** ones do; raw passthroughs and session-resumes
intentionally skip it, and this gate must not claim otherwise:

- `codex` bridge writes the 5-section spec to
  `docs/carefully-crafted-plugins/handoffs/` for its structured
  delegations (`imagegen`, `reason`, `review`) — `exec` (raw
  passthrough) and `resume` (continues an existing session) skip it by
  design; there is nothing to structure
- `contexthub:supervise` writes a full run ledger — checkpoints,
  receipts, logs — to disk for every run
- `contexthub:converge` writes nothing to disk by design; its audit
  trail is the in-context, Claude-visible debate itself
- `agy` bridge streams prompts to stderr on `--verbose`

Opaque LLM-to-LLM streams are not acceptable — every multi-agent call
must be auditable after the fact, whether that is an on-disk artifact
or a visible in-context transcript.

## 7. Evals

Every model-invocable skill (`disable-model-invocation` absent or
`false`) ships with `evals/evals.json` containing 2–3 realistic
prompts and programmatically verifiable assertions per Anthropic's
spec. Manual-only skills (`disable-model-invocation: true`) are
exempt — they can't be mis-triggered, since Claude never auto-invokes
them.

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
  (a long Codex review, a full Codex worker transcript) into a small,
  lossless, auditable index Claude can act on.
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

### Exception: `/contexthub:supervise`

Read literally, `/contexthub:supervise`'s primary purpose lands on four
items in gate 9's disqualifying list at once — plan execution, worktree
setup, completion verification, and branch finishing. It is retained
because none of those four are actually performed by Carefully Crafted
code; they are performed by Superpowers, invoked in place, every time:

- It is **manual-invocation only** (`disable-model-invocation: true`),
  run only on an explicit `/contexthub:supervise` request.
- Every real methodology step is **delegated to the corresponding
  Superpowers skill, never re-implemented**: `superpowers:brainstorming`
  for design, `superpowers:writing-plans` for the human plan,
  `test-driven-development` / `systematic-debugging` /
  `receiving-code-review` for each Codex worker's own session,
  `superpowers:verification-before-completion` before any completion
  claim, and `superpowers:finishing-a-development-branch` for the
  finish decision. `SKILL.md` hard-requires each by name at the point
  it is needed (`**REQUIRED SUB-SKILL:**`), and the transport does not
  advance without it.
- Carefully Crafted's own code — the private worktree allocator and
  the host verification runner — are **enforcement primitives, not
  replacement methodology**: they make no planning or completion
  judgment of their own, and only enforce isolation and execute the
  exact plan-approved checks, producing authenticated evidence for the
  required Superpowers skill (and Claude) to judge.
  `superpowers:using-git-worktrees` remains the normal human-facing
  workflow outside `/supervise`; inside it, deterministic ledger-owned
  worktrees exist only because concurrent external Codex processes
  cannot share a checkout.
- Every judgment call — design approval, plan quality, acceptance
  classification (`SATISFIED|GAP|UNCERTAIN`, then `SATISFIED|BLOCKED`),
  and finish choice — is Claude's, recorded through a CLI subcommand,
  **never inferred by the transport**.
- Its reason for existing at all is **bounded orchestration** and
  **evidence compression** (gate 4/9's core-value list): isolated
  Codex workers under hard call/token/timeout limits, reporting back
  compact checkpoints and receipts instead of full transcripts — not a
  competing path through planning, TDD, debugging, review,
  verification, or branch-finishing.

Any future skill claiming a similar exception must clear the same bars:
manual invocation, full delegation of every real methodology step to the
Superpowers skill that owns it (never re-implemented), primitives limited
to enforcement with no planning/completion judgment of their own, every
judgment call left to Claude and recorded rather than inferred, and a
genuine bounded-orchestration or evidence-compression reason (gate 9) for
existing at all.

### Dependency-resolution failure contract

The `superpowers` dependency is hard, not advisory. When Claude Code
cannot resolve it because the `claude-plugins-official` marketplace is
unavailable, unreachable, or blocked, every diagnostic we write about
that failure — in release notes, README troubleshooting, support
guidance, or any skill that surfaces the condition — must:

1. **Name the marketplace** by its identifier, `claude-plugins-official`,
   so the reader knows exactly which source failed.
2. **Raise organization policy** as a possible cause. In managed
   environments a blocked marketplace is usually an administrative
   restriction, not a broken install, and the reader should be pointed
   at their Claude Code administrator.
3. **Never suggest bypassing dependency enforcement.** Specifically, we
   do not tell users to disable dependency enforcement, bypass the
   check, skip validation, pass `--no-verify`, remove the dependency,
   ignore the failure, or install anyway. `contexthub` without
   Superpowers is a broken configuration — it would present lifecycle
   entry points whose methodology is missing. Failing closed with an
   actionable message is the correct behavior.

The remedy we offer is always to restore access to the marketplace
(ask the administrator to allow `claude-plugins-official`, or use a
network/account where it is reachable), never to weaken the dependency.

`tests/unit/plugin-dependencies.test.mjs` reads this subsection from
disk and asserts properties 1–3 hold, so deleting or weakening it
fails the suite.

## Enforcement

`tools/lint-skill.mjs` enforces gates 1–3 in CI — run via
`tests/unit/lint-skill.test.mjs` (`node --test`) and standalone as
`node tools/lint-skill.mjs`. Gates 4–9 are reviewed manually at PR
time. A skill that fails any gate doesn't merge.
