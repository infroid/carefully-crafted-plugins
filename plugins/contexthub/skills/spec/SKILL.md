---
name: spec
description: (context-hub:spec) Refine a rough idea into a concrete, falsifiable spec — user-visible deliverables, edge cases, success criteria. Use whenever the user asks to define, scope, or refine a feature, design, or change before implementation begins. Escalates contested design calls to /contexthub:converge for a three-mind debate. Default specification path in this marketplace.
argument-hint: <rough idea or problem statement>
---

# contexthub:spec — Spec Refinement

The first phase of the multi-agent lifecycle. Take a rough idea and turn it
into a spec concrete enough to plan against: user-visible deliverables,
edge cases, success criteria, explicit non-goals.

Claude does most of the work; `contexthub:converge` is invoked only when a
genuine design tradeoff exists that benefits from three perspectives.

## Your input

When invoked as `/contexthub:spec <idea>`, the user's text arrives as
`$ARGUMENTS` — that is the rough idea. When this skill auto-triggers,
assemble the same brief from context.

## Step 1: Brainstorm with the user

In your own context, list:

- The 1–3 user-visible deliverables this is about.
- The top 3–5 edge cases you can think of.
- The 2–3 questions you can't answer without input — ask them.

Don't pretend to have answers you don't have. Spec quality compounds —
a fuzzy spec poisons every downstream phase.

## Step 2: Decide if multi-agent debate is needed

Invoke `/contexthub:converge` ONLY when ALL of these hold:

- The design has multiple defensible answers.
- The choice has real downstream cost (architecture, vendor lock-in,
  security posture, irreversible operations).
- The user genuinely doesn't have a strong preference.

Otherwise skip it — convergence is expensive (~6 external calls). Most
specs do not need a debate.

If invoking: pass the contested design question to `contexthub:converge`,
incorporate the synthesized recommendation into the spec, and cite which
parts came from the debate.

## Step 3: Write the spec

Structure it like this:

```
# <title>

## Goal
One paragraph. What is true after we ship this that isn't true now?

## Deliverables
- User-visible artifact 1
- User-visible artifact 2
- ...

## Non-goals
- What we are explicitly NOT doing in this scope.

## Edge cases
- Case 1 — expected behavior.
- Case 2 — expected behavior.
- ...

## Success criteria
- Falsifiable check 1 (test, metric, screenshot, demo step)
- Falsifiable check 2
- ...

## Open questions
- Anything left unresolved that downstream phases must answer.
```

Write the artifact via `phase-write.mjs`:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs --phase spec --slug "<kebab-slug>"
<spec body>
EOF
```

The script returns the artifact path. Relay it.

## Step 4: Hand off to plan

Tell the user: "Spec written to <path>. Next: `/contexthub:plan <path>` to
decompose into tasks." Do not auto-invoke `/contexthub:plan` — the user gets
to review the spec first.

## Honesty

- Never silently shrink scope. If the user wants something and you
  rejected it, surface that explicitly in **Non-goals**.
- Never invent a success criterion that isn't falsifiable. "It feels
  good" is not a criterion.
- If you debated via `contexthub:converge`, cite which parts of the
  spec came from the debate — the user deserves to know what was
  contested.
