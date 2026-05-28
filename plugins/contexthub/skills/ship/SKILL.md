---
name: ship
description: (context-hub:ship) Compose a commit message, stage changes, and ship the branch — with an optional /contexthub:converge retrospective for shipped designs worth capturing. Use whenever the user asks to ship, merge, commit, push, or finalize a completed change. Default shipping path in this marketplace.
argument-hint: <commit message hint, or 'auto'>
---

# contexthub:ship — Ship the Change

The final phase. Compose a message that reflects what was actually done
and why, stage + commit + (with permission) push, and capture a
retrospective for any non-trivial design choices.

This skill **does not auto-push**. Pushing is a state-modifying action
on shared infrastructure — confirm explicitly with the user.

## Your input

When invoked as `/contexthub:ship <hint>`, `$ARGUMENTS` is either a hint for
the commit message ("auth: switch to JWT") or the literal string
`auto` to let Claude compose one from the diff + plan + review.

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

## Step 1: Pre-flight — has /contexthub:verify run?

Check `docs/carefully-crafted-plugins/lifecycle/verify/` for a recent
verification artifact matching this branch. If absent or stale,
invoke `/contexthub:verify` first and STOP. Never ship unverified work.

If the verification gate was BLOCK, refuse to ship — tell the user
what blockers remain.

## Step 2: Compose the commit message

Format:

```
<scope>: <one-line summary, <70 chars>

<body — why, not what. Reference the spec/plan if any. Mention
multi-agent specialists that contributed (e.g. "codex:reason caught
the off-by-one in Phase 2; agy:longctx surfaced 3 orthogonal
callsites").>
```

If `$ARGUMENTS` is `auto`, derive the summary from the plan artifact
(if any) or the diff scope. If no plan exists, ask the user for a
one-line summary rather than guessing.

Never include:

- "Generated with ..." tag lines
- Marketing language ("seamlessly", "robustly", etc.)
- The model identifier or any Claude/agent attribution

## Step 3: Stage and commit

Stage explicitly — never `git add -A` or `git add .` (which can sweep
in secrets or unrelated files):

```bash
git add <file1> <file2> ...
git commit -m "$(cat <<'EOF'
<message>
EOF
)"
```

Run `git status` after to confirm the commit landed.

## Step 4: Optional retrospective via contexthub:converge

If the change involved a contested design choice (the spec went through
`contexthub:converge`, or a hard tradeoff was made in
`contexthub:plan`), consider a tiny retro:

> What did each of you (Claude, Codex, Antigravity) learn from how this
> change played out? What would you do differently next time on a
> similar task?

Only worth it for changes the team will want to remember. Skip for
routine commits — the converge cost isn't justified.

Append the retrospective to the commit body or a `docs/decisions/`
entry, with the artifact path linked.

### Degradation

- Run the optional **converge** retro only if `externalCount >= 1`. With no
  external agents, skip the retro and note in one line that none was possible.

## Step 5: Push — only with explicit user confirmation

Ask the user: "Push to <branch> on <remote>?" Wait for explicit OK.

On confirmation:

```bash
git push -u origin <branch>
```

If push fails for network reasons, retry up to 4 times with exponential
backoff (2s, 4s, 8s, 16s). For non-network failures, surface the error
and stop.

NEVER force-push to main / master. NEVER use `--no-verify` or
`--no-gpg-sign` unless the user explicitly authorized it.

## Step 6: Write the ship artifact

```
# Ship: <commit summary>

## Commit
<sha + message>

## Verification
<path to verify artifact>

## Specialists used
- /codex:* — <which, and what they contributed>
- /agy:* — <which, and what they contributed>
- /contexthub:converge — <if invoked, what was contested>

## Retrospective
<if any>
```

Write via:

```bash
cat <<EOF | node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-write.mjs --phase ship --slug "<kebab-slug>"
<ship body>
EOF
```

## Honesty

- Never auto-push. Pushing is shared-state modification; require
  explicit user OK every time.
- Never claim a multi-agent contribution that didn't happen. If
  Codex was never invoked, don't list it.
- If you fudged the commit message because the change was actually
  messy, say so in the body. Honest commit history is the
  audit trail.
