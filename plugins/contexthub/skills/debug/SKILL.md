---
name: debug
description: (context-hub:debug) Systematic root-cause debugging from a symptom — Claude forms first hypothesis, /codex:reason at xhigh generates independent hypotheses, /agy:longctx scans the repo for similar patterns or where else the bug might live. Use whenever the user reports a bug, intermittent failure, mystery behavior, or asks 'why is this happening'. Default debugging path in this marketplace.
argument-hint: <symptom or bug description>
---

# contexthub:debug — Systematic Root-Cause Debugging

Called whenever something broke. Hard debugging is combinatorial — many
plausible causes, few that actually explain the symptom. Single-agent
debugging falls into "first plausible cause = root cause" too often.
`contexthub:debug` triangulates: Claude, Codex's hard-reasoning, and
Antigravity's whole-repo view all generate hypotheses independently.

This is the one phase that runs **out of order** — it's invoked whenever
something breaks, not at a specific lifecycle stage.

## Your input

When invoked as `/contexthub:debug <symptom>`, `$ARGUMENTS` is the bug
description: what was expected, what actually happened, any logs or
traces, when it started, how often it repeats.

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

## Step 1: Triage — confirm hard

Invoke `/triage:grade` on the symptom. If graded **low** (e.g. user
already knows where the bug is), handle inline — skip the multi-agent
debug protocol. Save it for genuinely hard cases.

For **medium** or **hard**, continue.

## Step 2: Claude's first hypothesis

In your own context: read the code, list 2–3 plausible causes ranked
by likelihood, and for each say what evidence would confirm or refute
it. **Resist** the urge to jump to "let me fix it" — root cause first.

Capture as `CLAUDE_HYPOTHESES`.

## Step 3: Independent hypothesis from codex:reason

Invoke `/codex:reason` at xhigh with the same symptom + code:

> Symptom: <bug description>
> Relevant code: <paths or snippets>
> What I've ruled out: <if anything>
>
> Generate 2–3 plausible root causes independently. For each: what
> evidence confirms it, what evidence refutes it, and how confident
> you are.

Capture as `CODEX_HYPOTHESES`. Codex hasn't seen Claude's hypotheses,
so it generates without anchoring.

## Step 4: Pattern scan via agy:longctx

Invoke `/agy:longctx`:

> The bug is: <symptom>. Scan `@<repo paths>` for OTHER callsites that
> use the same pattern, helper, or assumption that could exhibit the
> same bug. List file:line + one-sentence why.

Capture as `AGY_PATTERN_SCAN`. This is the unique multi-agent capability
— Claude and Codex can't fit the whole repo; agy can.

### Degradation

- Run the **codex:reason** hypothesis leg (Step 3) only if codex is present.
- Run the **agy:longctx** pattern scan (Step 4) only if agy is present.
- Note in one line any leg you skipped because its agent is absent.
- **count 1** — Claude hypotheses only.

## Step 5: Triangulate

Lay out all hypotheses + the pattern scan in one table:

| Hypothesis | Source | Confirming evidence | Refuting evidence | Where else it'd surface (from agy) |
|---|---|---|---|---|

Then:

- **Consensus hypothesis** — picked by ≥2 agents → start here.
- **Unique-to-one-agent hypothesis** — interesting if novel, but verify
  more carefully before committing time.
- **Refuted** — explicitly mark which hypotheses the evidence rules out.

## Step 6: Confirm, then fix

Run the minimum experiment that confirms (or refutes) the top
hypothesis: a failing test, a logging line, a one-liner script.
**Confirm before fixing** — fixing the wrong cause leaves the real bug
alive.

Once confirmed, fix it. Add a regression test. If the pattern scan
revealed the bug lives elsewhere, fix those too (or open follow-up
tasks).

## Step 7: Write the debug artifact

```
# Debug: <symptom>

## Symptom
<what was wrong>

## Hypotheses
<the table from Step 5>

## Confirmed cause
<the one>

## Fix
<file:line changes>

## Same pattern elsewhere
<from agy:longctx>

## Regression test
<path>
```

Write via:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs --phase debug --slug "<kebab-slug>"
<debug body>
EOF
```

## Honesty

- Never declare a cause "confirmed" without an experiment that would
  refute it if wrong. Plausible ≠ confirmed.
- If you fixed the bug but never confirmed the cause, say so — "fix
  applied, root cause still uncertain" is more honest than fake
  certainty.
- If the pattern scan found 10 callsites and you only fixed 1, list
  the unfixed ones. Don't paper over technical debt.
