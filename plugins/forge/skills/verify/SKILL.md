---
name: verify
description: (context-hub:verify) Pre-completion verification gate — run the test suite, drive Playwright via /codex:playwright for UI changes, scan blast radius with /agy:longctx. Use whenever the user asks to verify, validate, smoke-test, or confirm a change works before shipping. Default pre-ship verification path in this marketplace.
argument-hint: <branch, diff range, or 'current'>
---

# forge:verify — Pre-Completion Verification

The fifth phase. After implementation, before shipping. Three checks:
the test suite says green, the UI actually behaves (if there's a UI),
nothing else broke (long-context blast radius).

Where Superpowers stops at "I think the test passes," `forge:verify`
confirms with Playwright when there's a UI to drive, and with
Antigravity when the change might ripple into unrelated modules.

## Your input

When invoked as `/forge:verify <target>`, `$ARGUMENTS` is the diff
range, branch, or `current` (default: current branch's diff from
`origin/main`).

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
- [PASS] All checks clean. Safe to /forge:ship.
- [BLOCK] <N> blockers found. Address before shipping.
```

Write via:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/forge-write.mjs --phase verify --slug "<kebab-slug>"
<verify body>
EOF
```

## Step 5: Hand off

If gate is PASS, tell the user: "Verification clean. Next:
`/forge:ship`." If gate is BLOCK, list the blockers and STOP — do not
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
