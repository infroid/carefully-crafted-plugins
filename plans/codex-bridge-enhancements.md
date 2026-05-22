# Codex Bridge Enhancement Plan

Status: proposed — not yet implemented.
Branch: `claude/codex-integration-features-5J3VC`.

## 1. Motivation

A comparison of our `codex` plugin against the reference skill
[`skills-directory/skill-codex`](https://github.com/skills-directory/skill-codex)
(v1.3.0) shows a clear split:

- **Our plugin is architecturally ahead.** It has the 5-section handoff spec
  written to disk, reusable constraint / output-format files, a structured
  JSON output schema, a result parser, setup scaffolding, and unit tests.
- **Our plugin is operationally behind.** `codex-invoke.mjs` only ever runs a
  bare `codex exec` with a `--sandbox` value and optional `-i` images. It does
  not select a model, set reasoning effort, resume a session, or skip the git
  repo check.

The goal of this plan is to layer the missing Codex CLI capability onto the
existing spec-based architecture **without regressing it**. Every change is
additive and backward compatible: existing skill invocations keep working.

### Confirmed Codex CLI surface

Verified against OpenAI's Codex CLI docs (developers.openai.com/codex):

- `codex exec resume --last "<prompt>"` resumes the most recent session in the
  current working directory, keeping transcript, plan history, and approvals.
- `-c` / `--config` overrides arbitrary config keys for one run, e.g.
  `-c model_reasoning_effort="high"`.
- `xhigh` reasoning effort exists for non-latency-sensitive tasks.
- `--skip-git-repo-check` allows running outside a git repository.

Model names (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`,
`gpt-5.3-codex`) come from skill-codex and **must be re-verified against
`codex --help` / `codex` at implementation time** — model lists drift.

## 2. Known defect to fix along the way

`plugins/codex/skills/reason/SKILL.md` markets *"GPT-5.5 frontier reasoning"*,
but `codex-invoke.mjs` never passes `-m gpt-5.5` or any reasoning effort. The
skill currently delivers whatever the Codex default model is. Feature 2 fixes
this. Until then the skill description overpromises.

## 3. Feature catalogue

### Tier 1 — core operational gaps

#### F1. Session resume (multi-turn Codex)

**Why.** Today every invocation is cold. There is no iterative refinement, no
follow-up, and no peer discussion with Codex. The `reason` skill even tells the
user to "resume the Codex session to discuss" — machinery that does not exist.

**Changes.**

- `codex-invoke.mjs`:
  - New mode `--resume-last` (boolean). When set, build the command as
    `codex exec [global flags] resume --last <prompt>` instead of
    `codex exec [flags] <prompt>`.
  - Flags (`--sandbox`, `-m`, `-c …`) must be placed **between `exec` and
    `resume`**, never after `resume`. Per skill-codex guidance, do not pass
    model/reasoning overrides on resume unless the caller explicitly asks —
    the resumed session inherits them.
  - Prompt is passed as the positional argument after `resume --last`
    (documented form). Keep stdin piping as a fallback only if the positional
    form proves unreliable in testing.
  - A resume still writes an `--output-last-message` result file so
    `result-handler.mjs` works unchanged.
- New skill `plugins/codex/skills/resume/SKILL.md`, slash-command only
  (`disable-model-invocation: true`), invoked as `/codex:resume <follow-up>`.
  It calls `codex-invoke.mjs --resume-last --raw "<follow-up>"`.
- Spec linkage: a resume is a follow-up, not a new task, so it does not get a
  new spec. `result-handler.mjs` should accept an optional `--spec-path` that,
  when present, appends a dated "Follow-up" log entry to the original spec so
  the handoff file remains the audit trail. When absent, just print the
  summary.

**Acceptance.** `/codex:resume "tighten the error handling"` continues the
previous Codex session and surfaces the new result.

#### F2. Model + reasoning-effort control

**Why.** We cannot pick GPT-5.5 for hard reasoning or a cheap model for trivial
tasks. This is both a cost lever and the fix for the §2 defect.

**Changes.**

- `codex-invoke.mjs`:
  - New flags `--model <name>` and `--reasoning-effort <low|medium|high|xhigh>`.
  - Env fallbacks `CODEX_MODEL` and `CODEX_REASONING_EFFORT` (flags win).
  - When set, append `-m <name>` and `-c model_reasoning_effort="<effort>"` to
    the `exec` argument list (before the prompt; before `resume` if resuming).
  - Validate `--reasoning-effort` against the allowed set; exit 2 on a bad
    value.
- `spec-builder.mjs`: optionally accept `--model` / `--reasoning-effort` and
  record them in the spec header metadata block (audit only — informational).
- Per-skill defaults (encoded in each `SKILL.md`):
  - `reason` → `--model gpt-5.5 --reasoning-effort high`; offer `xhigh` for
    genuinely hard problems.
  - `image` → no model override (the `$imagegen` route picks `gpt-image-2`);
    leave reasoning unset.
  - `browser` → a mid-tier model, `--reasoning-effort medium`.
  - `exec` → no default; honor anything the user names in their raw prompt.
- For runs the user did not parameterise, skills may confirm model + effort in
  a single `AskUserQuestion` (two questions in one prompt) — but only when the
  task is plausibly expensive. Do not over-prompt on trivial calls.

**Acceptance.** `/codex:reason …` demonstrably runs `codex exec -m gpt-5.5
-c model_reasoning_effort="high" …`.

#### F3. Sandbox discipline + permission gating

**Why.** `codex-invoke.mjs:101` defaults `CODEX_SANDBOX` to `workspace-write`
for **every** skill. `reason` and `browser` are read-shaped tasks that should
not be able to mutate the workspace. There is also no confirmation before
`--full-auto` / `danger-full-access`.

**Changes.**

- `codex-invoke.mjs`: change the default sandbox from `workspace-write` to
  `read-only`.
- Each skill explicitly sets the sandbox it needs (via `CODEX_SANDBOX` env or a
  new `--sandbox` passthrough flag on `codex-invoke.mjs`):
  - `reason` → `read-only` (it only needs to produce text/code at the artifact
    path — confirm whether writing the artifact file requires `workspace-write`;
    if so use `workspace-write` but document why).
  - `image` → `workspace-write` (must write the PNG).
  - `browser` → `workspace-write` (writes scrape output / screenshots).
  - `exec` → `read-only` default; escalate only on explicit user request.
- Permission gating: any skill that would use `--full-auto`,
  `--sandbox danger-full-access`, or `--skip-git-repo-check` in a way the user
  has not already authorised must first confirm via `AskUserQuestion`. Document
  this rule once and reference it (see F5).

**Acceptance.** A `reason` run cannot write outside its declared artifact path;
`danger-full-access` always prompts first.

### Tier 2 — robustness & quality

#### F4. Robustness fixes

**Why.** Two reliability/cost issues.

1. `codex-invoke.mjs` never passes `--skip-git-repo-check`, so invocations fail
   outside a git repo or in some worktrees.
2. `codex-invoke.mjs` streams **all** child stdout and stderr live into the
   calling process (`process.stdout.write(s)` / `process.stderr.write(s)`).
   That dumps Codex's full reasoning/JSONL trace into Claude's context window.

**Changes.**

- `codex-invoke.mjs`:
  - Always pass `--skip-git-repo-check` (it is safe — Codex still sandboxes;
    F3 governs write access). Gate it behind confirmation only if a project
    decides to treat it as high-impact.
  - Add `--verbose` (also `CODEX_VERBOSE=1`). Default behaviour: do **not**
    live-stream child output to the parent; buffer it, write the full trace to
    a log file next to the result file (e.g. `log-<base>.txt`), and print only
    a short status line. With `--verbose`, restore live streaming.
  - The user-facing result is unchanged: `result-handler.mjs` reads the
    `--output-last-message` file, which already isolates the final answer.

**Acceptance.** A delegated run adds only a brief summary to Claude's context;
the full trace is on disk; `--verbose` restores streaming.

#### F5. Shared "critical-evaluation" reference doc

**Why.** skill-codex has a developed "Codex is a colleague, not an authority"
protocol. Our plugin has only a light note inside `reason`. The peer-discussion
pattern depends on F1 (resume).

**Changes.**

- New file `plugins/codex/reference/critical-evaluation.md` covering:
  - Treat Codex output as a peer opinion; trust your own knowledge when
    confident; push back on errors.
  - Watch for knowledge-cutoff staleness (model names, library versions, APIs);
    research disagreements with WebSearch / docs before accepting claims.
  - When Codex disagrees with a prior attempt, surface the disagreement to the
    user — never silently switch.
  - To discuss peer-to-peer, resume the session and identify as Claude with the
    actual running model name.
  - The permission-gating rule from F3 (one canonical statement).
- Each `SKILL.md` (`reason`, `browser`, `exec`, `image`, new `review`) links to
  it via `${CLAUDE_PLUGIN_ROOT}/reference/critical-evaluation.md` in its
  "Report" / follow-up step.

**Acceptance.** Every skill references one shared evaluation protocol; no
duplicated prose.

### Tier 3 — coverage

#### F6. New structured `/codex:review` skill

**Why.** Codex's primary strength is code review / analysis / refactoring —
that is literally what skill-codex exists for. Our plugin has no structured
code-analysis skill; only the unstructured `exec` escape hatch. `reason` is for
puzzles/math, not codebase work.

**Changes.**

- New skill `plugins/codex/skills/review/SKILL.md`. Same 4-step shape as
  `reason`/`browser`:
  1. Draft the 5-section spec (role: `Code reviewer / refactoring agent`;
     task: the review target — a diff, a file set, or a refactor brief).
  2. Mandatory pre-flight clarification.
  3. Invoke via `spec-builder.mjs` + `codex-invoke.mjs`.
  4. Report via `result-handler.mjs`, then apply F5 critical evaluation.
- Sandbox: `read-only` for pure review; `workspace-write` only when the user
  asked Codex to actually apply the refactor (confirm which mode is intended in
  pre-flight).
- Add a starter output-format file to `setup.mjs` (e.g.
  `output-formats/code-review.md` describing the review report shape).

**Acceptance.** `/codex:review` delegates a structured code review and returns
findings against the output-format contract.

## 4. Cross-cutting changes

- **Versioning.** Bump `codex` plugin to `1.1.0` in
  `plugins/codex/.claude-plugin/plugin.json` and in
  `.claude-plugin/marketplace.json`; bump marketplace `metadata.version`.
- **README.md.** Document resume, model/reasoning flags, the sandbox-per-skill
  table, `--verbose`, and (if F6 ships) the `review` skill and `/codex:review`
  command.
- **hooks.json.** No required change. Optionally extend the `PreToolUse` Bash
  matcher note to also recognise `codex exec … resume`.
- **output-schema.json.** No change needed; the existing schema still applies
  to structured results, including reviews.

## 5. Testing strategy

`node --test tests/unit/*.test.mjs`, no external deps — keep that contract.

- **New: `tests/unit/codex-invoke.test.mjs`.** `codex-invoke.mjs` currently has
  **zero tests**. Add a fake `codex` executable (a small shell/node script on a
  temp `PATH`, or via `CODEX_BIN`) that records the argv it was called with.
  Assert:
  - `--model` / `--reasoning-effort` produce `-m` and
    `-c model_reasoning_effort="…"` in the right positions.
  - `--resume-last` produces `exec [flags] resume --last <prompt>` with flags
    before `resume`.
  - Default sandbox is `read-only`; `--skip-git-repo-check` is always present.
  - `--verbose` toggles streaming; default run does not flood stdout.
  - Bad `--reasoning-effort` exits 2.
- **Extend `spec-builder.test.mjs`** if F2 adds model/effort metadata to the
  spec header.
- **Extend `result-handler.test.mjs`** for the F1 optional follow-up log
  appended to the original spec.

## 6. Suggested sequencing

1. **Phase 1 — engine.** All `codex-invoke.mjs` changes (F1 resume, F2 model/
   effort, F3 sandbox default, F4 skip-git-check + `--verbose`). Add
   `codex-invoke.test.mjs`. Self-contained, fully testable without touching
   skills.
2. **Phase 2 — skills.** Wire per-skill model/effort/sandbox defaults into
   `reason`, `image`, `browser`, `exec`. Add the F5 reference doc and link it.
3. **Phase 3 — new surfaces.** F1 `/codex:resume` skill; F6 `/codex:review`
   skill + its output-format starter in `setup.mjs`.
4. **Phase 4 — docs & release.** README, version bumps, final test pass.

Phases 1–2 already close every Tier 1 gap and the §2 defect.

## 7. Risks & open questions

- **Model names drift.** Re-verify the model list against `codex` at
  implementation time; do not hardcode a list that will rot. Consider keeping
  model names only in `SKILL.md` guidance, not in script defaults.
- **Resume scoping.** `resume --last` is scoped to the current working
  directory; with concurrent or interleaved sessions "last" is ambiguous.
  Investigate whether `codex exec` exposes a session ID we can capture and
  resume explicitly; if so, prefer ID-based resume and keep `--last` as
  convenience.
- **Resume + flags.** Confirm by testing exactly which flags Codex accepts
  between `exec` and `resume`. skill-codex's guidance: avoid config overrides
  on resume; the session inherits model/effort/sandbox.
- **`reason` sandbox.** Determine whether writing the artifact file requires
  `workspace-write`. If a `read-only` sandbox blocks the artifact write, the
  skill needs `workspace-write` — document the reason rather than silently
  widening it.
- **`imagegen` + model selection.** The `$imagegen` route picks `gpt-image-2`;
  ensure an unrelated `-m` override does not interfere. Default: no model
  override on image runs.
- **`--skip-git-repo-check` policy.** Treated here as safe-by-default since F3
  governs writes. If a consuming project disagrees, make it confirm-gated.
