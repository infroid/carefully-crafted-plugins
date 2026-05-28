# Difficulty Heuristics

The full rubric Claude consults when grading a task. Bias toward `low`
— the bridge defaults are `medium`, and over-grading burns tokens.

## low

A task is **low** if ALL of the following are true:

- Touches one file (or a tightly scoped set of obviously-related files).
- Spec is unambiguous — Claude knows exactly what "done" means without
  asking.
- No cross-cutting impact — changes don't ripple outside the touched
  files.
- No research required — the relevant docs/conventions are already in
  context or are trivial to find.
- The pattern is familiar to Claude (a standard CRUD endpoint, a
  rename, a comment fix, a small refactor following an existing pattern).

Examples:

- "Fix the typo in line 42 of README.md."
- "Add a `data-testid` attribute to the submit button."
- "Rename `getUserById` to `findUserById` and update callers."
- "Generate a 256×256 todo-app icon" (visual brief is clear, single output).

Suggested routing: **Claude inline** (no delegation), or specialist at
`low` effort if delegation is unavoidable.

## medium

A task is **medium** if it satisfies ALL of the following:

- Touches 2–3 files or a single moderately complex file.
- Spec has minor ambiguity but solvable in-context (Claude can decide
  reasonably without a clarifying turn).
- Standard pattern — not novel, but requires some judgment.
- May require one quick lookup (a doc, a config, a referenced file).
- No risk of orthogonal regression.

Examples:

- "Add input validation to the signup form."
- "Extract this duplicated logic into a helper."
- "Audit src/auth.ts for obvious bugs."
- "Write tests for the new module."

Suggested routing: single specialist at `medium` effort. This is the
default — don't over-grade.

## hard

A task is **hard** if ANY of the following are true:

- Cross-cutting — changes propagate across many files or modules.
- Ambiguous spec — Claude genuinely cannot decide without input or
  research.
- Root-cause debugging from a symptom (vs. fixing a known issue).
- Novel architecture or design decision — multiple defensible answers.
- Performance work — needs measurement, profiling, careful trade-offs.
- Requires reading >Claude's context to verify (long-context audit).
- Combinatorial / algorithmic — graph problems, optimization,
  competition-style.
- High-stakes — security, correctness, irreversible operations.

Examples:

- "Find every callsite in this monorepo that bypasses requireAuth."
  (cross-cutting + long-context → `agy:longctx`)
- "Should we move auth from session cookies to JWTs?" (design debate →
  `contexthub:converge`)
- "Why does the test suite hang intermittently on CI?" (root-cause
  debug → `codex:reason` at `xhigh`)
- "Optimize this 10k-row SQL query." (perf work → `codex:reason` at
  `xhigh`)

Suggested routing: specialist at `high` or `xhigh`; consider
multi-agent (`contexthub:converge`) when perspectives genuinely
diverge.

## When you can't decide

If you're 50/50 between two grades, **pick the lower one**. The bridge
default at `medium` is graceful. The user can always re-invoke with a
higher effort if the lower one falls short — but tokens already spent
can't be refunded.
