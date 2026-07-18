# Output Format: Code Review

<!-- Used by /codex:review. This is the *human-readable* description of the
     contract; the machine-enforced version is the JSON Schema passed via
     --output-schema (reference/schemas/code-review.schema.json). Both must
     stay in sync — treat the schema as the source of truth for exact limits. -->

Return **only** a single JSON object matching the schema below — no prose,
no markdown fences, no commentary outside the object.

```json
{
  "status": "FINDINGS",
  "scope": "staged, unstaged, and named untracked changes",
  "findings": [
    {
      "id": "F-001",
      "severity": "high",
      "title": "Authorization check occurs after the write",
      "path": "src/orders.ts",
      "line": 84,
      "claim": "An unauthorized caller can mutate an order before rejection.",
      "evidence": "updateOrder executes before requireOwner on lines 84-91.",
      "impact": "Cross-tenant data mutation.",
      "confidence": "high",
      "minimal_fix": "Move requireOwner before updateOrder and add the denied-path test."
    }
  ],
  "limitations": []
}
```

## Fields

- **status**: `FINDINGS` | `NO_FINDINGS` | `INCOMPLETE`.
  - `FINDINGS` requires at least one finding.
  - `NO_FINDINGS` requires zero findings — this means "no actionable
    findings for the declared scope," not "the code is correct." Do not use
    it to paper over a review you didn't actually complete.
  - `INCOMPLETE` requires at least one non-empty `limitations` entry
    explaining what failed or was truncated. Use this instead of silently
    truncating when you know more findings exist than you can return.
- **scope**: the exact reviewed scope, ≤480 characters.
- **findings**: at most 20 entries, in priority order. IDs must be
  sequential and unique, starting at `F-001` (no gaps, duplicates, or
  reordering). Ask for the 20 *highest-impact, actionable* findings — pure
  style preferences are excluded unless they violate a cited project rule.
  - **severity**: `critical` | `high` | `medium` | `low`.
  - **title**: ≤160 characters.
  - **path**: the affected file.
  - **line**: a 1-based positive integer, or `null` when not line-scoped.
  - **claim**: the falsifiable claim, ≤480 characters.
  - **evidence**: concrete evidence for the claim — code, line ranges,
    reasoning — not a restatement of the claim, ≤480 characters.
  - **impact**: ≤480 characters.
  - **confidence**: `high` | `medium` | `low`.
  - **minimal_fix**: the smallest concrete change that resolves it, ≤480
    characters.
- **limitations**: at most 8 entries, each ≤240 characters.

## What "good" looks like

Falsifiable correctness, security, performance, and design risks with
concrete evidence and a minimal fix — not vague impressions. Every claim
should be checkable against the cited file and line.
