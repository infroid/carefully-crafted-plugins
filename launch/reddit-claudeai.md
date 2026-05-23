# r/ClaudeAI post

Reddit downweights overt self-promotion. Lead with the practical value;
mechanism only briefly.

## Title

```
A Claude Code plugin for getting a converged answer from three frontier AIs (Claude, Codex, Antigravity) on hard questions
```

[~119 chars — renders well on Reddit feed.]

## Body

```
For routine coding, asking Claude Code directly works fine. For hard
calls — architecture choices, security audits, contentious technical
decisions where multiple defensible answers exist — single-AI confidence
isn't enough, and you can't tell from the response which.

I built a Claude Code plugin (contexthub) that lets you fire one
question at three frontier AIs — Claude, OpenAI Codex (GPT-class), and
Google's Antigravity (Gemini 3 Pro) — and get back one synthesized
answer.

Slash command:

    /contexthub:converge "Should we move auth from session cookies to JWTs?"

What you get back, structured for decision-making (not just reading):

- Consensus — the points all three agents agreed on. Use as high-
  confidence ground.
- Disagreements — where they split, with each side's strongest argument.
  This is the genuinely useful part.
- Recommendation — synthesized best answer, with any weak-evidence
  resolutions flagged so you can override.
- What you should decide — specific decision points the synthesis leaves
  to your judgment (with the evidence on each side compiled).
- Audit trail — how each agent's position moved through the conversation.

The output is structured to make the disagreements *visible*, not papered
over. On hard questions, that's the actually useful artifact.

Under the hood it's a four-phase protocol (independent answers → mutual
critique → refinement → synthesis), but the value is in the structured
output, not the mechanism. Six external calls in three parallel batches
for the full protocol; a lightweight variant (Phase 1 + Phase 4 only)
does it in two calls when you just want diverse views without the full
back-and-forth.

The same marketplace also ships two bridges contexthub builds on:

- codex — 7 skills covering image generation (gpt-image-2), high-effort
  reasoning, code review/refactoring, Playwright browser, session resume,
  and a structured 5-section handoff spec written to disk for audit.

- agy — 4 skills for capabilities Claude Code doesn't have natively:
  1M-token long-context codebase analysis on Gemini 3 Pro (~5× Claude
  Code's context), Nano Banana Pro image generation, Veo video generation,
  and a raw passthrough.

MIT licensed, Node.js stdlib only, no external deps.

Install (inside Claude Code):

    /plugin marketplace add https://github.com/infroid/carefully-crafted-plugins
    /plugin install contexthub@carefully-crafted-plugins

Repo: https://github.com/infroid/carefully-crafted-plugins

Try it on a hard question you've actually been debating with yourself
this week — architecture call, framework choice, something you weren't
sure about. If the converged synthesis helps you decide, great. If it
doesn't, drop the question + the output into an issue — I'm building
the failure-mode corpus.
```

## Posting tips

- Post Tuesday–Thursday morning US time.
- Reply to every substantive comment within 4 hours.
- If a commenter finds a bug, acknowledge it in the same comment AND link
  to the issue you've opened from it ("good catch — tracking at \<link\>").
  Visible accountability.
- Don't crosspost the same body to r/programming or r/MachineLearning —
  different audiences, different framings. Rewrite if you want to hit
  those.
