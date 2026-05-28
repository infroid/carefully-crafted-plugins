---
name: review
description: (context-hub:review) Three-way code review of a diff or branch — Claude in-context, /codex:review with fresh eyes (no authoring bias), /agy:longctx for whole-repo regression scan. Use whenever the user asks for a thorough code review, audit, or multi-perspective sanity check of recent changes. Distinct from /codex:review (single-agent). Default multi-agent review path in this marketplace.
argument-hint: <diff range, branch name, or paths>
---

# contexthub:review — Three-Way Code Review

The fourth phase. Single-reviewer code review misses two things every
time: orthogonal regressions outside the diff, and biases the author
already shares. `contexthub:review` fixes both — three independent passes,
then synthesis.

## Your input

When invoked as `/contexthub:review <target>`, `$ARGUMENTS` is the diff
range (e.g. `HEAD~5..HEAD`), branch name (e.g. `contexthub/<plan-slug>`), or
a path glob. If empty, default to `git diff origin/main...HEAD`.

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

## Step 1: Claude's in-context pass

Read the diff. List findings by severity (block / consider / nit), each
with file:line and a one-paragraph rationale. Do NOT delegate yet.

Cover: correctness, security, error handling, naming, test coverage,
backwards compatibility.

## Step 2: codex:review — fresh eyes

Invoke `/codex:review` on the same target. Codex hasn't seen the
authoring conversation; it brings the perspective Claude can't because
Claude wrote some of this.

Pass the diff scope and ask for the standard review output. Capture
Codex's findings as `CODEX_FINDINGS`.

## Step 3: agy:longctx — whole-repo regression scan

Invoke `/agy:longctx` to scan the whole repo for orthogonal regressions:

> Given this diff in `@<paths>`, find every callsite IN THE REST OF
> THE REPO (`@<other-paths>`) that depends on the changed behavior and
> may break. List file:line for each, with a one-sentence reason. Do
> not flag the diff itself — only the unchanged code that depends on
> changed behavior.

Capture as `AGY_FINDINGS`. This is the specific capability single-agent
review cannot match — Claude's context cannot fit the whole repo.

Skip Step 3 only when the diff is tiny (<3 files) and clearly local
(e.g. a typo fix). Otherwise spend the long-context call.

### Degradation

Run the reviewers present in the Step 0 report:

- **all three** — Claude (in-context) + codex (fresh eyes) + agy (repo scan).
- **no codex** — Claude + agy.
- **no agy** — Claude + codex.
- **count 1** — Claude solo pass only.

## Step 4: Synthesize

Structure the review artifact:

```
# Review: <diff/branch/paths>

## Block — must fix before shipping
- [file:line] <issue> — sources: Claude / Codex / Antigravity

## Consider — should fix
- [file:line] <issue> — sources: ...

## Nit — optional
- [file:line] <issue> — sources: ...

## Consensus
Issues all three agents independently flagged. Highest confidence.

## Unique to each reviewer
- Claude found (not Codex/agy): ...
- Codex found (not Claude/agy): ...
- agy found (not Claude/Codex): ...

## False positives
Issues one reviewer raised that you verified are NOT bugs, with
evidence.
```

Write via:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs --phase review --slug "<kebab-slug>"
<review body>
EOF
```

## Step 5: Hand off

Tell the user: "Review at <path>. <N> blockers, <M> consider, <K>
nits. Next: address blockers, then `/contexthub:verify` before shipping."

## Honesty

- Never silently drop a reviewer's finding. If you think Codex is
  wrong, say so in **False positives** with evidence — don't ignore.
- Never inflate **Consensus**. If only 2/3 agents flagged something,
  it's not consensus.
- If Antigravity flagged a long-context regression you can't verify
  without reading the cited code, READ THE CODE before deciding —
  long-context output can hallucinate. The hallucination cost is real;
  pay it down by spot-checking.
