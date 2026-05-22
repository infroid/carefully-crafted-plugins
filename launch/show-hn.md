# Show HN submission

## Title (copy verbatim — do not "improve" before submitting)

```
Show HN: Converge – Make Claude, Codex, and Gemini debate before answering hard questions
```

Notes:
- 70-char limit. The line above is 79 chars — trim "before answering hard
  questions" to "before answering" (62 chars) if HN rejects, or use:
  `Show HN: Converge – three frontier AI agents debate before answering`
  (62 chars).
- Lead with "Show HN: Converge" — readers' eyes lock on the name.
- The em-dash version reads better than colon; HN allows both.

## URL field

```
https://github.com/raiaman15/carefully-crafted-plugins
```

(The repo, not the Dev.to article. Show HN convention: link the project.)

## Text field (the body)

```
Hi HN. I built a Claude Code plugin that orchestrates a structured four-phase
debate between Claude (Anthropic), OpenAI Codex CLI (GPT-class), and Google's
Antigravity CLI (Gemini 3 Pro) — all inside one terminal session — and then
converges on a single synthesized answer.

Motivation: single-agent answers sound confident even when wrong. Asking the
same question to three frontier models in three browser tabs is tedious and
gives you raw outputs with no synthesis. You still don't know which to trust.
For hard architectural calls, security audits, and contentious technical
decisions, that's a real problem.

So I implemented a Delphi-style protocol:

  Phase 1  Independent first answers (parallel, no anchoring)
  Phase 2  Mutual critique (each agent sees all three round-1 answers)
  Phase 3  Refinement (each agent updates, must justify accepts/rejects)
  Phase 4  Synthesis (Claude orchestrator — consensus, disagreements,
                       recommendation, decision points for the user,
                       audit trail of how each agent moved)

Six external CLI calls in three parallel batches. A lightweight variant
(Phase 1 + Phase 4 only) does it in two calls when you want diverse views
without the full ceremony.

The harder design problem was not the orchestration — it was preventing the
protocol from regressing into agreement theatre. Four honesty rules are
written into the skill prompt: don't silently degrade if one agent is
unreachable; don't ratify a majority (2-against-1 is evidence, not proof);
don't paper over disagreement; don't invent positions for incoherent
responses. These exist because the failure mode of multi-agent systems is
convergence on confident wrong answers, not divergence into confusion.

Repo includes the converge plugin plus two underlying bridges:
- codex — seven-skill structured bridge to Codex CLI (image gen, hard
  reasoning, code review, browser, exec, resume, setup; 5-section handoff
  contract with on-disk specs, constraint and output-format files).
- agy — four-skill bridge to Google's Antigravity CLI for capabilities
  Claude Code lacks: 1M-token long-context (Gemini 3 Pro), Nano Banana Pro
  image generation, Veo video generation, raw passthrough.

MIT licensed. All Node.js standard library, zero external deps.

Failure modes I'm aware of, since I'd rather you hear them from me:

  - The synthesis is done by Claude, which is also a participant. The
    honesty rules mitigate but don't eliminate the structural bias. If
    you can think of a cleaner arrangement, I'd like to hear it.
  - Antigravity CLI is three days old (Google launched it at I/O 2026,
    replacing Gemini CLI). The wrapper targets its documented `-p` surface
    and degrades gracefully if a flag differs, but expect rough edges.
  - Six calls is expensive on cost and latency. This is for hard questions,
    not routine queries.

Repo: https://github.com/raiaman15/carefully-crafted-plugins

Happy to discuss the protocol design and the failure modes I haven't found yet.
```

## Tips when you submit

1. **Be at the keyboard for the first 2 hours.** Reply to every comment
   within 15 minutes. This is *the* lever for front-page rank.
2. **Don't argue from authority.** "I think you're right, here's the
   nuance" beats "actually, you're missing X" every time on HN.
3. **Don't ask people to upvote.** Auto-flag.
4. **Don't reply to upvoters with thanks.** Saves comment space for actual
   discussion.
5. **If a thread gets contentious**, concede the point if they're right,
   or post evidence if you're right. Never escalate tone.
6. **Watch for comments that ask "show me a real output."** Have a real
   synthesis example ready to paste — ideally one where the agents
   disagreed and the disagreement was useful.
