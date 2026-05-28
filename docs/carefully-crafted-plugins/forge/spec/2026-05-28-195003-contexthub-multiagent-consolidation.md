# Consolidate multi-agent flows under `contexthub` + agent-aware degradation

## Goal
After shipping, all multi-agent / cross-agent orchestration lives under a
single `contexthub` plugin, and every multi-agent skill automatically
adapts to however many external agents (`codex`, `agy`) are installed and
authenticated — running the richest flow available and degrading
gracefully (down to Claude-solo with a one-line warning) instead of
assuming all three agents always exist. `codex` and `agy` remain the
single-agent bridges; `contexthub` becomes the one place multi-agent work
lives.

## Deliverables
- **Reorganized `contexthub` plugin** with 9 skills — `spec`, `plan`,
  `tdd`, `review`, `verify`, `debug`, `ship` (the 7 former forge phases),
  `triage` (former triage:grade), and `converge` (unchanged). The `forge`
  and `triage` plugins are deleted.
- **Shared agent-availability module** (`contexthub/scripts/agent-availability.mjs`)
  that probes which of {codex, agy} are present AND authenticated, prints a
  JSON capability report (`{claude, codex, agy, count}`), and is invoked at
  the start of every multi-agent skill.
- **Degradation policy in every multi-agent skill** — explicit
  role-reassignment rules for 3 / 2 / 1 available agents; Claude-solo runs
  print "ran degraded — install/log into codex or agy for cross-checks".
- **Updated metadata + docs** — marketplace.json (now 3 plugins, with a
  major bump for the breaking removal), README, website install +
  capability sections, and all inter-skill cross-references.

## Non-goals
- No backward-compatible `forge:*` / `triage:*` alias shims. This is a
  deliberate clean break (user chose "All forge + triage", not the alias
  option); old commands stop working.
- No change to what each phase *does* conceptually — only its namespace and
  its agent-adaptivity change.
- No auto-installing or auto-logging-into missing agents. Detection only;
  we never run installers or `login` on the user's behalf.
- No changes to the `codex` / `agy` single-agent bridge skills themselves.

## Edge cases
- **Claude only (0 external agents)** — every multi-agent skill runs solo
  and prints the degraded note. `converge` collapses to a direct Claude
  answer (no debate possible) plus the note.
- **One external agent** — two-agent flow; the missing agent's role is
  reassigned to the available agent or to Claude. e.g. `review` with no
  agy → Claude + codex; with no codex → Claude + agy.
- **CLI installed but not logged in** — counts as unavailable (bar = PATH +
  auth). Routed identically to not-installed.
- **Auth probe slow / hangs** — probe runs under a short timeout; a timeout
  is treated as unavailable rather than blocking the flow.
- **Name uniqueness** — all 9 contexthub names are unique; `contexthub:review`
  legitimately coexists with `codex:review` (cross-plugin reuse passes lint).
- **triage routing** — `triage` only proposes routes to agents detected as
  available; never suggests `/codex:*` when codex is absent.
- **converge with 2 agents** — runs and labels a 2-way debate rather than
  faking a third perspective.
- **Stale capability report** — if availability is cached within a session,
  define a TTL/per-invocation probe so a since-logged-out agent is not
  reported available.

## Success criteria
- `node tools/lint-skill.mjs` and `node --test tests/unit/*.test.mjs` pass
  with the 9 new contexthub skills and zero forge/triage plugins present.
- A unit test that stubs PATH/probes (codex absent, agy present) shows
  `agent-availability.mjs` reporting codex unavailable, agy available,
  `count: 2`.
- Following `contexthub:review`'s documented steps with both agents stubbed
  absent yields a Claude-solo review plus the degraded-mode note.
- marketplace.json lists exactly 3 plugins (codex, agy, contexthub); README
  and website show the `contexthub:*` command set and a 3-plugin install
  block; `grep` finds no `forge:` / `triage:` / old-plugin-dir references
  outside intentionally historical artifacts.
- Each of the 9 contexthub skills ships `evals/evals.json` (>=2 evals) and
  clears the quality bar.

## Open questions
- **Exact auth-probe per agent.** codex: is there a trustworthy
  non-interactive status/exit-code (e.g. `codex login status`)? agy: auth
  lives in the IDE/client, so is `agy --version` (install check) the
  practical ceiling with auth assumed? Resolve in `plan`.
- **Capability-report caching.** Per-invocation probe (simplest, always
  correct) vs. session cache with TTL (faster, staleness risk).
  Recommendation: per-invocation with a short timeout unless latency hurts.
- **Version strategy.** Removing two plugins is breaking — bump contexthub
  3.0.1 -> 4.0.0 and marketplace 4.0.1 -> 5.0.0? Confirm at ship.
- **triage scope.** Stays standalone, or also auto-invoked inside `plan` /
  `review` to grade effort? Default: standalone unless requested.
