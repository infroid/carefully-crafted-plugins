# X / Twitter thread

Copy-paste each tweet. Numbers in brackets are character counts (max 280).

---

## Tweet 1 — the hook (attach 15s demo GIF/video)

```
Stop asking one AI.

I made Claude, GPT-class (Codex), and Gemini 3 Pro (Antigravity) debate each other inside one terminal — independent answers → mutual critique → refinement → synthesis.

The output shows what they agree on AND where they don't.

15s ↓
```

[263 chars]

**Attach:** the demo asciinema/GIF — see `launch/demo-script.md`.

---

## Tweet 2 — the problem

```
Single-agent answers sound confident even when wrong.

For routine code, fine.

For hard architecture calls, security audits, contentious technical decisions — dangerous. Three browser tabs and you're still stuck reconciling in your head.
```

[256 chars]

---

## Tweet 3 — the protocol

```
converge runs a 4-phase Delphi protocol across 3 frontier agents:

1. Independent first answers (no anchoring)
2. Mutual critique (each sees all three round-1 answers)
3. Refinement (each updates, must justify accepts/rejects)
4. Synthesis

6 external calls. 3 parallel batches.
```

[277 chars]

---

## Tweet 4 — what you get

```
The synthesis is the deliverable. It surfaces:

→ Points all three agree on
→ Genuine disagreements with each side's reasoning
→ A recommendation with weak-evidence calls flagged
→ Decision points left to YOU
→ Audit trail of how each agent's position moved across rounds
```

[273 chars]

---

## Tweet 5 — why this is not "just polling"

```
The hard problem wasn't the orchestration.

It was preventing the protocol from regressing into agreement theatre. Four honesty rules are baked in:

→ No silent degradation
→ No majority ratifying (2-vs-1 is evidence, not proof)
→ No papering over disagreement
→ No inventing positions
```

[279 chars]

---

## Tweet 6 — credit to vendors (optional but earns goodwill)

```
Bridges all three flagship CLIs:

@AnthropicAI Claude Code as the orchestrator
OpenAI's `codex` for GPT-class reasoning
Google's brand-new Antigravity (`agy`) for Gemini 3 Pro + 1M-token context

Three vendors. One terminal. Honest debate.
```

[245 chars]

> Tag @-handles only if they're accurate to your post. Don't spam-tag for reach.

---

## Tweet 7 — the install (the magnet)

```
Plugin marketplace pattern. Install once, use forever:

/plugin marketplace add raiaman15/carefully-crafted-plugins
/plugin install converge@carefully-crafted-plugins

Then:
/converge:debate "your hard question here"

Code: github.com/raiaman15/carefully-crafted-plugins

MIT.
```

[277 chars]

---

## Tweet 8 — the CTA + ask

```
Built this because I got tired of trusting confident single-AI answers.

If you try it on a hard question and the synthesis is useful — or if it falls flat — open an issue. I want to build the failure-mode corpus.

⭐ if the idea is worth your attention.
```

[260 chars]

---

## Posting checklist

- [ ] Tweet 1: confirm the GIF/video uploaded and previews correctly.
- [ ] Post 1-8 as a single thread (reply chain), not separate tweets.
- [ ] Pin the thread to your profile for 7 days.
- [ ] Reply to anyone who quotes within the first 24h.
- [ ] If a tweet in the thread underperforms badly, do *not* edit (kills the
  chain) — just keep going.

## A note on tags

Tag responsibly:
- `@AnthropicAI`, `@OpenAIDevs`, `@GoogleAI` only if you actually credit
  their tool in that tweet (Tweet 6 above). Don't tag for reach in tweets
  that aren't about them.
- The AI-engineering hashtags `#AIengineering`, `#LLMOps`, `#ClaudeCode`,
  `#AItools` work but use ≤2 per tweet — more reads spammy.
