---
name: verify
description: (context-hub:verify) Pre-completion verification gate — run the test suite, drive Playwright via /codex:playwright for UI changes, scan blast radius with /agy:longctx. Use whenever the user asks to verify, validate, smoke-test, or confirm a change works before shipping. Default pre-ship verification path in this marketplace.
argument-hint: <branch, diff range, or 'current'>
---

# contexthub:verify — Pre-Completion Verification

The fifth phase. After implementation, before shipping. Three checks:
the test suite says green, the UI actually behaves (if there's a UI),
nothing else broke (long-context blast radius).

Where Superpowers stops at "I think the test passes," `contexthub:verify`
confirms with Playwright when there's a UI to drive, and with
Antigravity when the change might ripple into unrelated modules.

## Your input

When invoked as `/contexthub:verify <target>`, `$ARGUMENTS` is the diff
range, branch, or `current` (default: current branch's diff from
`origin/main`).

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

## Step 1: Run the test suite

Run the project's test command. If it fails, STOP — report failures
to the user. Do not proceed to Steps 2 or 3 until tests are green.
There is no point browser-testing or scanning blast radius for code
that doesn't pass unit tests.

If you don't know the test command, ask the user or check
package.json / Makefile / README.

## Step 2: UI verification via codex:playwright (when applicable)

Skip this step if the diff is backend-only / no UI changes.

If there's a UI change, invoke `/codex:playwright`:

> Start the dev server (the user's standard command), navigate to the
> changed feature, exercise the happy path + 1-2 edge cases described
> in the spec's success criteria. Report what worked, what didn't,
> and any visual regression suspicion. Take screenshots.

Capture the report. If Playwright surfaces a real failure, STOP and
report to the user — verification gate failed.

## Step 3: Blast radius scan via agy:longctx (when applicable)

Skip this step if the diff is tiny (<3 files) and clearly local.

Otherwise invoke `/agy:longctx`:

> Given this diff in `@<paths>`, scan `@<rest of repo>` for any module
> whose behavior might have changed indirectly — shared utilities,
> implicit assumptions, contract changes that propagate. List
> file:line for each suspected impact, with one-sentence reason.

Spot-check 2–3 of agy's findings against actual code before relaying.
Long-context output can hallucinate; pay the verification tax.

### Degradation

- The **test suite** (Step 1) always runs — it is the floor regardless of agents.
- Run **codex:playwright** UI verification (Step 2) only if codex is present.
- Run **agy:longctx** blast-radius scan (Step 3) only if agy is present.
- **count 1** — tests + Claude review only.

## Step 4: Synthesize a verification report

```
# Verification: <target>

## Tests
- Command: <test cmd>
- Result: <green | <N> failures>
- Failures: <list with file:line if any>

## UI (codex:playwright)
- Scenarios exercised: <list>
- Findings: <list>
- Screenshots: <paths>

## Blast radius (agy:longctx)
- Files scanned: <count>
- Suspected impacts: <list with verification notes>

## Gate
- [PASS] All checks clean. Safe to /contexthub:ship.
- [BLOCK] <N> blockers found. Address before shipping.
```

Write via:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs --phase verify --slug "<kebab-slug>"
<verify body>
EOF
```

## Step 5: Hand off

If gate is PASS, tell the user: "Verification clean. Next:
`/contexthub:ship`." If gate is BLOCK, list the blockers and STOP — do not
auto-ship.

## Honesty

- Never declare PASS while a test is failing, even one. The user pays
  for false confidence later.
- Never skip a step "because it probably doesn't matter." Either it
  matters and you do it, or you say in the report which step you
  skipped and why.
- Playwright "no errors" isn't verification — it's the floor. Did the
  feature ACTUALLY DO what the spec said? Answer that, not "Playwright
  ran cleanly."
