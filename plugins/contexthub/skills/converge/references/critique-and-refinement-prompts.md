# Critique & Refinement Prompt Templates

Verbatim prompt strings for Phases 2 and 3 of the converge debate.
Substitute the bracketed variables before sending. Pass the same
exact text to both Codex and Antigravity in each phase so the agents
are reasoning over identical material.

## Phase 2 — Critique prompt

Send this to **both** Codex and Antigravity (parallel). Each agent
critiques the OTHER TWO answers (not its own).

```
Original question:
<Q>

Round 1 answers from all three agents:

[CLAUDE]
<CLAUDE_R1>

[CODEX]
<CODEX_R1>

[AGY]
<AGY_R1>

Task: Critique the OTHER TWO answers (not your own). For each, list:
- Points you agree with.
- Points you disagree with and why.
- Anything missing.
- Anything outright wrong — cite evidence.

Be specific. Do not flatter. If two answers say the same thing and you
think it is wrong, say so — do not appeal to consensus.
```

Invocation (parallel — single message, two Bash calls):

```bash
codex exec --skip-git-repo-check --sandbox read-only \
  -c model_reasoning_effort=high "$critique_prompt" 2>/dev/null

agy -p "$critique_prompt" 2>/dev/null
```

Capture stdout as `CODEX_CRIT` and `AGY_CRIT`.

If the prompt grows very long, write it to a temp file and pass a
short directive (`codex exec ... "Read /tmp/converge-r2.md and ..."`),
then have the agent read the file.

## Phase 3 — Refinement prompt

Each external agent receives **its own** Round 1 answer plus the
critiques against it, and updates its position. Send a tailored copy
to each — Codex sees Codex_R1, agy sees AGY_R1.

```
Original question:
<Q>

Your round 1 answer:
<CODEX_R1 or AGY_R1 — the agent's own>

Critiques you received:
- From Claude:
  <CLAUDE_CRIT>
- From the other agent:
  <CODEX_CRIT or AGY_CRIT — whichever is not the agent's own>

Task: Update your answer. Explicitly state which critique points you
accepted and which you rejected, with reasoning. If you still believe
your original answer is right, defend it — do not capitulate to consensus.
```

Invocation: same shape as Phase 2 (parallel codex + agy).
Capture `CODEX_R2` and `AGY_R2`.
