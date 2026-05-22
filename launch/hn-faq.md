# HN comment FAQ — prepared responses

These are anticipated comment patterns and the answers you should have
ready. Reply within 15 minutes for the first 4 hours after submission;
that engagement window is what drives front-page rank.

The voice: technical, concrete, *concede where they're right*. Never
defensive. Never marketing-speak.

---

## "Isn't this just majority voting / ensemble methods that already exist?"

```
Fair question. Two distinctions I'd point to:

1. It isn't voting — there's no "the majority answer wins." The synthesis
   step explicitly preserves disagreement; if two models agree but the
   third has a defensible objection, the objection makes it into the
   output as a flagged disagreement, not majority-overridden.

2. It's cross-vendor, not multi-prompt-to-one-model. Ensemble methods
   typically sample one model multiple times. Here you get three different
   training distributions arguing — Anthropic, OpenAI, Google. That's
   diverse enough that two-against-one with shared blind spots is a real
   concern, which is why "don't ratify a majority" is in the honesty
   rules.

That said, the closest prior work I know is Yao et al's debate framing
and the Delphi method from social sciences. Happy to be pointed at
anything I missed.
```

---

## "Six API calls per question is expensive."

```
True. The full protocol is 6 external calls and takes minutes. That's
why it's slash-only — it doesn't auto-trigger. It's designed for the
"hard question" tail, not the routine-query distribution.

There's a lightweight variant (Phase 1 + Phase 4 only, 2 calls) for when
you just want diverse views without critique/refinement. That's the
right default for medium-hard questions.

If you're spending $0.20 on a question where the next decision is worth
$50k in engineering time, the math is fine. If you're using it for
"refactor this function," you're using it wrong.
```

---

## "Why not just use OpenRouter / a single API with multiple models?"

```
Two reasons I went the CLI-orchestration route instead:

1. The vendor CLIs (codex, agy) expose capabilities that aren't always
   in the API — sandboxes, native image/video tool routing, session
   resume, vendor-specific reasoning-effort knobs. OpenRouter gives you
   the model but not the harness.

2. This runs in your Claude Code terminal session, so Claude is both an
   agent AND the orchestrator. That orchestration happens in your
   context, not in a remote agent — meaning you see the protocol
   running, can interrupt, can ask Claude follow-ups about the
   synthesis. It's a different shape than a closed API.

If you want pure model-vs-model with no orchestration, OpenRouter is
the right tool. This isn't trying to replace that.
```

---

## "How do you prevent the synthesis being biased by Claude (since Claude does the final synthesis)?"

```
Honest answer: I can't fully eliminate it. Claude *is* a participant AND
the orchestrator — that's a structural conflict of interest.

What I did was write four explicit rules into the skill prompt to
*resist* the bias:

  1. Don't silently degrade if one agent is unreachable
  2. Don't ratify a majority
  3. Don't paper over disagreement
  4. Don't invent positions

And the synthesis is *required* to expose the audit trail: each agent's
position at R1 and R2 in a table, so you can see if Claude quietly
buried someone.

It's mitigation, not elimination. If you can think of a cleaner
arrangement — a fourth agent as judge, structured voting on the synthesis
itself, etc. — I'd genuinely like to hear it. There's an open issue
template specifically for protocol-improvement proposals.
```

---

## "Show me an actual debate output."

If you have one ready, paste a real sanitized example. If you don't,
this is honest:

```
Good ask, and I should have led with one. Here's a real synthesis from
this morning on "Should we move auth from session cookies to JWTs for
our SPA?":

[paste a real sanitized synthesis here — copy the structured output
verbatim. If you have none ready, generate one and *say so* — readers
catch fabrications fast]

The disagreement section is the part I find most useful: gPT-class
argued for JWTs with refresh tokens; Gemini argued cookies are still
right if you control the domain; Claude's R2 went with a hybrid. None
of those answers is "wrong" — but seeing them framed against each other
told me which question I actually needed to answer first (what's our
auth surface area?).
```

---

## "What if the agents collude / share training data?"

```
This is the "shared blind spot" risk, and you're right that it's real.
All three models are trained on broadly overlapping internet snapshots,
so for any topic where the canonical-but-wrong source is the same in
all three training corpora, they will agree confidently and converge to
the same wrong answer.

Two things in the design that *try* to address it:

1. The honesty rule "don't ratify a majority" — Claude is instructed to
   surface "two agree but I suspect shared blind spot" as its own
   synthesis observation, not as confirmation.

2. The audit trail makes it visible when all three R1s were
   suspiciously identical. If you see three identical R1s, treat the
   "consensus" as low-confidence.

But there's no algorithmic fix to "all three were trained on the same
wrong Wikipedia article." Your judgment is still the load-bearing
piece. The tool surfaces what the models think — it doesn't tell you
they're right.
```

---

## "This depends on Antigravity CLI which is three days old."

```
Yes, fair. I should be upfront about that risk.

The wrapper targets `agy -p "<prompt>"` and `--output-format json`,
which are documented in the official docs and the GitHub repo. The code
treats only ENOENT as fatal — if a flag turns out to be different from
what I have, the wrapper degrades gracefully instead of silently
failing.

If Google changes the CLI surface (which is plausible given how new it
is), this will need a patch. Tracking that risk publicly in the README.

The Codex bridge has more runway — `codex exec` has been stable for
months.
```

---

## "I tried it and \<X\> broke."

```
Thanks for the report, please open an issue with:
- The exact slash command you ran
- The error (the wrapper saves a log next to the result file)
- Your codex/agy versions

I'll respond within 24h. The wrapper's error categorization should tell
us if it's not-authed, rate-limited, timeout, or unknown — that
usually narrows it down fast.

[paste GitHub issues link]
```

---

## "Why MIT and not \<X\>?"

```
MIT for low friction. If you want to fork it and add a feature, I'd
rather you ship that than worry about license compatibility. If MIT is
a blocker for your use case, open an issue — I'm not religiously
attached.
```

---

## "Cool but I'd never use this — single agents are good enough."

```
Honest take: you might be right for your workflows. The tool is
designed for the tail of *hard* questions, not for the median day. If
all your questions are routine, this is overkill and you should keep
using one model.

The question I'd ask back: have you ever made a decision based on a
confident-sounding AI answer that turned out to be wrong, and you
couldn't have told from the response? That's the specific failure mode
this addresses. If you haven't hit it, you don't need this. If you
have, it's worth one try.
```

---

## Defensive postures to AVOID

- ❌ "You're missing the point." (Always: "Let me clarify…")
- ❌ "Have you actually read the README?" (Always: "Good context — the
  README covers \<link\>.")
- ❌ "That's an edge case." (Always: "That's a real failure mode —
  here's what I'd do about it.")
- ❌ Long responses to short comments. Match the comment length.
- ❌ Replying to every single upvoter with "thanks." Reserve comments for
  technical discussion.

## The meta-rule

If a comment is right, **say so explicitly**: *"You're right about X, I
hadn't thought about Y."* HN respects this enormously. It is the single
behaviour that most reliably converts critics into supporters in the
comment thread.
