# HN comment FAQ — prepared responses

Anticipated comment patterns and the answers you should have ready. Reply
within 15 minutes for the first 4 hours after submission; that engagement
window is what drives front-page rank.

Voice: technical, concrete, *concede where they're right*. Never
defensive, never marketing-speak. Match comment length.

---

## "Isn't this just majority voting / ensemble methods that already exist?"

```
Fair question. Two distinctions:

1. It isn't voting — there's no "majority answer wins." The synthesis
   explicitly preserves disagreement; if two models agree but the third
   has a defensible objection, the objection makes it into the
   "Disagreements" block as a flagged dissent, not majority-overridden.

2. It's cross-vendor, not multi-prompt-to-one-model. Ensemble methods
   typically sample one model multiple times. Here you get three
   genuinely different training distributions arguing — Anthropic,
   OpenAI, Google. Two-against-one with shared blind spots is a real
   concern, which is why the synthesis is required to flag suspected
   shared-blind-spot consensus rather than ratify it.

Closest prior work I know is Yao et al's debate framing and the Delphi
method from social sciences. Open to pointers if you've seen anything
closer.
```

---

## "Six API calls per question is expensive."

```
True. The full protocol is 6 external calls and takes minutes. It's
slash-only and doesn't auto-trigger — designed for the "hard question"
tail, not routine queries.

There's a lightweight variant (Phase 1 + Phase 4 only, 2 calls) for
diverse views without the full back-and-forth — that's the right default
for medium-hard questions.

If you're spending $0.20 on a question where the next decision is worth
$50k in eng time, the math is fine. If you're using it for "refactor
this function," you're using it wrong.
```

---

## "Why not just use OpenRouter / a single API with multiple models?"

```
Two reasons I went the CLI-orchestration route:

1. The vendor CLIs (codex, agy) expose capabilities that aren't always
   in the API — Codex's image-gen routing, Antigravity's 1M-context +
   Veo + Nano Banana, sandbox modes, vendor-specific reasoning-effort
   knobs. OpenRouter gives you the model but not the harness.

2. It runs in your Claude Code session, so Claude is both an agent AND
   the orchestrator. That happens in your context — you see the
   protocol run, can interrupt, can ask Claude follow-ups about the
   synthesis. Different shape from a closed API call.

For pure model-vs-model with no orchestration, OpenRouter is the right
tool. This isn't trying to replace that.
```

---

## "How do you prevent the synthesis being biased by Claude (since Claude does the final synthesis)?"

```
Honest answer: I can't fully eliminate it. Claude IS both a participant
and the orchestrator — a structural conflict of interest.

What mitigates it:

1. Four rules baked into the synthesis prompt: don't silently degrade,
   don't ratify a majority, don't paper over disagreement, don't invent
   positions. These exist specifically because the failure mode of
   multi-agent systems is convergence on confident wrong answers.

2. The synthesis is required to include the audit trail — each agent's
   R1 and R2 positions in a table — so you can see if Claude quietly
   buried someone. Visible accountability.

It's mitigation, not elimination. If you can think of a cleaner design
— a fourth agent as judge, structured voting on the synthesis, etc. —
I'd genuinely like to hear it. Open an issue.
```

---

## "Show me an actual debate output."

If you have a real one ready, paste it. If not:

```
Good ask, I should have led with one. Here's a sanitized example from
"Should we move auth from session cookies to JWTs for our SPA?":

[paste a real sanitized synthesis output verbatim — Consensus,
Disagreements, Recommendation, What you should decide, Audit trail]

The Disagreements block is the part I find most useful: Codex argued
for JWTs with refresh tokens; Antigravity argued cookies are still
right if you control the domain; Claude's R2 went with a hybrid. None
"wrong" — but seeing them framed against each other told me which
question I actually needed to answer first (auth surface area).
```

> Critical: if you don't have a real synthesis ready, **say so** —
> "haven't sanitized one yet, will post by EOD." Fabricated examples
> get caught on HN and tank the thread.

---

## "What if the agents collude / share training data?"

```
Real concern. All three models are trained on broadly overlapping
internet snapshots, so for any topic where the canonical-but-wrong
source is the same in all three corpora, they'll agree confidently and
converge to the same wrong answer.

Two mitigations in the design:

1. The synthesis is required to surface "two agree but I suspect shared
   blind spot" as its own observation, not as confirmation.

2. The audit trail makes it visible when all three R1s were
   suspiciously identical. If you see three identical R1s, treat the
   "consensus" as low-confidence.

But there's no algorithmic fix to "all three were trained on the same
wrong source." Your judgment is still load-bearing.
```

---

## "This depends on Antigravity CLI which is brand new."

```
Yes — Google launched Antigravity 2.0 at I/O 2026 (just before this).
The wrapper targets the documented `agy -p` surface and treats only
ENOENT as fatal, so it degrades gracefully if a flag turns out to be
different. If Google rotates the surface, this needs a patch.

The Codex bridge has more runway — `codex exec` has been stable for
months.
```

---

## "I tried it and \<X\> broke."

```
Thanks — please open an issue with:
  - The exact slash command you ran
  - The error (the wrapper saves a trace next to the result file)
  - Your codex / agy versions

I'll respond within 24h. The wrappers categorize errors (not-authed,
rate-limited, timeout, bad-model, unknown) which usually narrows it
down fast.

[paste GitHub issues link]
```

---

## "Why MIT and not \<X\>?"

```
MIT for low friction — if you want to fork it and add a feature, I'd
rather you ship that than worry about license compatibility. If MIT is
a blocker for your use case, open an issue. Not religiously attached.
```

---

## "Cool but I'd never use this — single agents are good enough."

```
You might be right for your workflows. The tool is for the tail of
*hard* questions, not the median day. If your questions are routine,
this is overkill and you should keep using one model.

The question I'd ask back: have you ever shipped a decision based on a
confident-sounding AI answer that turned out to be wrong, and you
couldn't have told from the response? That's the specific failure mode
this addresses. If you haven't hit it, you don't need this. If you
have, it's worth one try.
```

---

## Defensive postures to AVOID

- ❌ "You're missing the point." → ✅ "Let me clarify…"
- ❌ "Have you actually read the README?" → ✅ "Good context — the README
  covers \<link\>."
- ❌ "That's an edge case." → ✅ "That's a real failure mode — here's
  what I'd do about it."
- ❌ Long responses to short comments. Match the length.
- ❌ Replying to every upvoter with "thanks." Reserve comments for real
  discussion.

## The meta-rule

If a comment is right, **say so explicitly**: *"You're right about X, I
hadn't thought about Y."* This is the single behaviour that most
reliably converts critics into supporters on HN.
