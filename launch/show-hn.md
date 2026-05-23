# Show HN submission

## Title (copy verbatim — do not "improve" before submitting)

```
Show HN: Get a converged answer from three frontier AIs in one terminal
```

[68 chars — within HN's 80-char title limit with margin.]

## URL field

```
https://github.com/infroid/carefully-crafted-plugins
```

HN convention: Show HN links the project, not the article. Mention the
Dev.to article in the body for readers who want the long form.

## Text field (the body)

```
Hi HN. I built a Claude Code plugin (contexthub) that lets you ask one
question to three frontier models — Claude (Anthropic), OpenAI Codex
(GPT-class), and Google's Antigravity (Gemini 3 Pro, 1M-token context) —
and get back one synthesized answer that surfaces what they agree on and
where they don't.

  /contexthub:converge "Should we move auth from session cookies to JWTs?"

What you get back is structured for decisions, not for reading: a
consensus block (use as ground), a disagreements block with each side's
argument (this is the actually useful part), a recommendation with
weak-evidence calls flagged for override, the specific decision points
left to you, and an audit trail of how each agent's position moved.

The motivation: single-AI answers sound confident even when wrong, and
for hard technical calls (architecture, security, contentious tradeoffs)
you can't tell from the response which. Pasting the same question into
three browser tabs and reconciling in your head is slow and gives you
raw outputs with no synthesis.

Under the hood: a Delphi-style protocol — independent answers, mutual
critique, refinement, synthesis — with the prompts tuned so the agents
actually disagree where they should, rather than converging on confident
agreement. Six external calls in three parallel batches for the full
protocol; a lightweight variant does Phase 1 + Phase 4 only in two calls
when you want diverse views without the full back-and-forth. The value
is in the structured output, not the mechanism.

The same marketplace also ships two bridges that contexthub builds on:

  - codex — 7-skill bridge to OpenAI Codex CLI: image generation
    (gpt-image-2), high-effort reasoning, code review, Playwright
    browser, structured 5-section handoff spec written to disk, session
    resume, raw exec.

  - agy — 4-skill bridge to Google's brand-new Antigravity CLI for what
    Claude Code lacks: 1M-token codebase analysis, Nano Banana Pro
    image gen, Veo video generation, raw passthrough.

MIT, Node stdlib only, 31 unit tests, no external deps.

Repo: https://github.com/infroid/carefully-crafted-plugins
Article: [paste your Dev.to article URL here once published]

Happy to discuss design — particularly the prompts I'm using to make
three frontier models actually critique each other on contentious
questions rather than converge into polite agreement.
```

## Tips when you submit

1. **Be at the keyboard for the first 2 hours.** Reply within 15 minutes
   to every comment. The first-60-minutes engagement window is *the*
   lever for front-page rank.

2. **Concede where commenters are right.** "You're right about X — let me
   clarify Y" beats "actually, you're missing Z" every time on HN. The
   single behaviour that most reliably converts critics into supporters.

3. **Don't ask for upvotes.** Auto-flag, kills the post.

4. **Don't reply to upvoters with thanks.** Saves comment space for real
   discussion.

5. **Have a real synthesis output ready to paste.** First commenter to
   ask "show me a real example" — and one will — gets a concrete answer
   in 60 seconds. If you don't have one, generate one in advance and have
   it open in a tab.

6. **If a comment is genuinely critical, treat it as a gift.** Open an
   issue from it in front of the commenter ("good point, tracking at
   \<issue link\>"). Visible accountability multiplies trust.

7. **Anticipated questions** and prepared responses are in
   [hn-faq.md](./hn-faq.md). Skim it before submitting.
