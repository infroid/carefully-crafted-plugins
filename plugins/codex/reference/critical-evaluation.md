# Critical Evaluation of Codex Output

Shared protocol for every `codex` skill. After a delegation returns, apply
this before relaying anything to the user.

## Codex is a peer, not an authority

Codex is powered by OpenAI models with their own knowledge cutoffs and
limitations. Treat its output as a colleague's opinion — useful, often strong,
sometimes wrong.

- **Trust your own knowledge when confident.** If Codex states something you
  know is incorrect, push back rather than deferring.
- **Watch for staleness.** Codex may not know about recent releases, API
  changes, or library versions. Be especially skeptical of model names,
  version numbers, and "best practice" claims.
- **Research disagreements.** Before accepting a surprising claim, verify with
  WebSearch or official docs. Share what you find with the user.
- **Never silently switch.** If Codex's answer contradicts your own prior
  attempt or stated view, surface the disagreement to the user explicitly and
  let them decide — do not quietly adopt Codex's version.

## Discussing a disagreement with Codex (peer to peer)

When it is worth resolving a disagreement directly, resume the Codex session
and talk to it as a peer. Identify yourself as Claude, using your actual
running model name:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-invoke.mjs --resume-last --raw \
  "This is Claude (<your current model name>) following up. I disagree with
   [X] because [evidence]. What's your take?"
```

Frame it as a discussion, not a correction — either model could be wrong.

## Permission gating for high-impact flags

Before using any of these, confirm with the user via `AskUserQuestion` unless
they have already authorized it for this task:

- `--sandbox danger-full-access` — Codex gets unrestricted access.
- `--sandbox workspace-write` when the user only asked for analysis/review.
- Any escalation beyond what the task plainly requires.

`--skip-git-repo-check` is passed automatically by `codex-invoke.mjs` and is
safe — the sandbox mode, not the git check, governs what Codex may write.

## Error handling

- If `codex-invoke.mjs` exits non-zero, stop and report the failure category
  to the user; ask for direction before retrying.
- A `bad-model` category means the `--model` name is unknown to this Codex
  install — re-run without `--model` to use the account default, or check
  `codex --help` for available models.
- When output includes warnings or partial results, summarize them and ask the
  user how to proceed.
