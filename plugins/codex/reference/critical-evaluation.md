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

For `/codex:review`, when the exact session ID from that run is available,
prefer `--resume <session-id>` over `--resume-last` — the ambient "last
session in this directory" could resolve to an unrelated run by the time a
peer debate is warranted.

## Review-specific: provenance and annotation (structured `/codex:review` results only)

This section applies only to the structured evidence contract produced by
`result-handler.mjs --type review`. It does not apply to `reason`, `exec`,
`resume`, or `imagegen` — none of those are forced into this table format.

- **Preserve provenance.** The raw result file stays byte-for-byte unchanged
  on disk. Never edit, reformat, or "clean up" Codex's original JSON —
  quote or reference it, and always disclose its full path.
- **Account for every finding once.** Build a compact table from the printed
  index covering every returned `F-NNN` ID exactly once — no dropped,
  merged, or renumbered findings.
- **Annotate, don't overwrite.** For each finding, add two independent
  annotations without altering Codex's own `severity` or `claim`:
  - **Evidence**: confirmed / contradicted / context-missing / not yet
    evaluated.
  - **Kind**: bug / security / performance / design / other.
  Expand full detail (evidence, impact, minimal fix) only for critical/high,
  contradicted, or context-missing entries by default; keep the rest to the
  compact table.
- **A validation failure is a failure, not an empty review.** If
  `result-handler.mjs --type review` exits non-zero, report the failure and
  the named artifact path. Never convert it into `NO_FINDINGS`.
- **`NO_FINDINGS` is narrow.** It means only "no actionable findings for
  this declared scope" — report it that way, including any limitations. It
  is not evidence the code is correct or ready to ship.

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
