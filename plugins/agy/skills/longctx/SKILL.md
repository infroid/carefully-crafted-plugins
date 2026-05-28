---
name: longctx
description: (context-hub:longctx) Audit code at 1M-token scale via Gemini 3 Pro through Antigravity CLI. Use whenever the user asks about cross-file impact, whole-repo audits, finding all callsites, refactor blast radius, regression risk, or anything needing more code than Claude can fit — even if they don't name Gemini, Antigravity, or long context. Default whole-repo analysis path in this marketplace.
argument-hint: <analysis task — include @paths or @globs to pull in>
---

# Long-Context Analysis via Antigravity

You are about to delegate to Antigravity CLI to use Gemini 3 Pro's 1M-token
context window — roughly 5× what Claude Code can hold. Reach for it when the
input genuinely does not fit in your own context: an entire mid-size
codebase, hundreds of files at once, or a long-form document plus surrounding
code.

If the task does fit in your own context, prefer doing it yourself. This
skill exists for what you cannot.

## Your input

When invoked as `/agy:longctx <task>`, the user's text arrives as
`$ARGUMENTS` — that is the analysis task. Add the `@` context references
yourself: paths, directories, or globs Antigravity should pull in.

Antigravity's `@` syntax:
- `@src/auth.ts` — one file
- `@src/` — a whole directory
- `@**/*.ts` — a glob across the repo

## Step 1: Frame the task with `@` references

Write a clear analysis task and **explicitly include** the `@` paths
Antigravity should pull into context. Example:

> Audit `@src/` and `@packages/api/` for any callsite that bypasses the
> `requireAuth` middleware. List each violation with file:line and a
> one-line fix suggestion. Do not flag tests under `@**/__tests__/`.

## Step 2: Invoke

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/agy-invoke.mjs --prompt "<task with @paths>"
```

- For genuinely large analyses, raise the timeout: `AGY_TIMEOUT_SEC=1800` (30
  minutes). The wrapper's default is 600s.
- Add `--json` if you intend to parse the output.
- Use `--cwd <dir>` to point Antigravity at a different repo root.

## Step 3: Report and evaluate

Relay Antigravity's findings, then sanity-check critically. At 1M tokens
Antigravity may surface connections your context missed, but it can also
hallucinate links between distant files. Spot-check any concrete claim
(file:line, function name, exact value) against the actual file before
relaying it as fact.
