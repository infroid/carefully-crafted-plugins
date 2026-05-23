# Launch playbook

ROI-ranked plan for shipping the marketplace — with `contexthub` (the
multi-agent converger) as the lead.

## The strategy in one sentence

Lead with **what users get** (a converged answer from three frontier AIs in
one terminal), not how it works. The mechanism is the dog under the leash;
the show is the dog.

## What to sell

In order of headline weight:

1. **One converged answer from three frontier AIs.** Anthropic + OpenAI +
   Google, in one terminal command. No tab-juggling.
2. **Structured output you can actually use** — consensus, disagreements,
   recommendation, decision points, audit trail. An answer *and* the dissent.
3. **Other capabilities in the same install** — image/video generation,
   1M-token codebase analysis, frontier-reasoning offload. List them; the
   marketplace pays off either way.
4. **(Quietly) The mechanism**, only when asked. One paragraph max in any
   public artifact. The FAQ has full technical depth for skeptics in
   comments.

## What NOT to lead with

- The 4-phase protocol diagram (keep it; just don't headline it).
- The honesty rules (still load-bearing, but don't open with them —
  reads as defensive).
- Per-call costs / latency math (relevant in FAQ, not lead).
- "Caveats I owe you up front" preambles (move to FAQ; don't sell on
  reservation).
- The build-log narrative ("I got tired of trusting confident AI answers
  so I built this"). Lead with the destination, not the journey.

## ROI-ranked launch sequence

| Rank | Asset / Action | Why this rank |
|---|---|---|
| 1 | **15-second demo (asciinema or MP4)** | Cross-leveraged across every channel. The single highest-leverage artifact. Only you can record it. See [demo-script.md](./demo-script.md). |
| 2 | **Show HN submission** | Per your framework, the front-page lottery ticket. Cheap to try; see [show-hn.md](./show-hn.md). |
| 3 | **Dev.to article** | The canonical link HN, Twitter, Reddit all point at. Sustained traffic. See [article-main.md](./article-main.md). |
| 4 | **Twitter/X thread** | Posts ~1h after HN. Amplifies and brings the AI-eng community in. See [twitter-thread.md](./twitter-thread.md). |
| 5 | **r/ClaudeAI post** | Targeted audience already using Claude Code. See [reddit-claudeai.md](./reddit-claudeai.md). |
| 6 | **Medium publication submission** | Dev Genius / Towards Data Science. Longer tail; lower urgency. |
| 7 | LinkedIn / other subs | Skip unless 1–6 underperform. Low ROI for dev tools. |

## Pre-launch checklist

- [ ] **Record the demo** — see [demo-script.md](./demo-script.md). Use a
  hard question with a real disagreement in the synthesis, otherwise the
  demo looks like a generic answer.
- [ ] **Capture one real synthesis output** to paste into the article and
  the FAQ. Readers and HN commenters WILL ask "show me a real example";
  not having one ready loses trust fast.
- [ ] **Verify install on a clean machine.** First-impression killer if
  it breaks.
- [ ] **Star your own repo from your account.** Trivial; one > zero.
- [ ] **Pick the launch day**: Tue / Wed / Thu. Avoid Mondays, Fridays,
  US holidays.
- [ ] **Pick the launch hour**: 8–10 a.m. US Pacific = 11 a.m.–1 p.m.
  US Eastern. Optimizes the global developer waking window.

## Launch-day timeline

T = first publish time.

| T+ | Action | Channel |
|---|---|---|
| 0 min | Publish [article-main.md](./article-main.md) | Dev.to |
| +30 min | Submit [show-hn.md](./show-hn.md), link the GitHub repo (HN convention) | Hacker News |
| +60 min | Post [twitter-thread.md](./twitter-thread.md) with the demo attached | X / Twitter |
| +2h onward | **Sit at the keyboard.** Reply to every HN comment within 15 min for the first 4 hours. Single biggest lever on front-page rank. See [hn-faq.md](./hn-faq.md) for prepared answers. |
| +1 day | Post [reddit-claudeai.md](./reddit-claudeai.md) | r/ClaudeAI |
| +2 days | Submit to Dev Genius or Towards Data Science | Medium (publication, not personal) |
| +1 week | If HN was a hit, write the follow-up: "What \<N\> people use /contexthub:converge for, and the failure modes I've found." Re-launch energy. |

## Engagement rules during the launch window

- **Reply within 15 minutes** to every substantive HN comment for the first
  4 hours. This is *the* lever for the front-page algorithm.
- **Concede where commenters are right.** "You're right about X, I hadn't
  thought about Y" is the single behaviour that most reliably converts
  critics into supporters. HN respects this enormously.
- **Don't argue from authority.** "Let me clarify…" beats "Actually you're
  missing X" every time.
- **Match comment length.** Short comments get short replies. Long
  technical questions get the FAQ-grade answer.
- **Never ask for upvotes** — auto-flag, kills the post.

## Channel-by-channel notes

### Hacker News

The lottery ticket. Hit rate is low; payoff if you hit is large (10k+
visitors per the framework). Title and first 60 minutes of upvotes
dominate. Title in [show-hn.md](./show-hn.md) is tuned — don't "improve"
it before submitting.

### Dev.to

The canonical link. Make sure:
- Demo at the top, above the fold.
- Code snippets copy-pasteable. Test that.
- GitHub link unmissable (top, middle, bottom).
- Tags: `#ai`, `#claudecode`, `#openai`, `#opensource`, `#tutorial`.

### Twitter / X

The amplification surface. AI-engineering community lives here. Thread
does the heavy lifting; the demo is the first hook. Pin the thread for
7 days.

### Reddit

Heavy downweight on overt self-promotion. Lead with the technical
content, use first person sparingly, treat it as a tip share more than
a product launch.

### Medium

Submit to an established publication (Dev Genius, Towards Data Science,
Better Programming). Don't publish on a personal profile — it dies in
an empty stream.

## Realistic expectations

- A Show HN that *almost* hits front page is the most common outcome:
  200–1,500 views, 5–30 stars, a handful of substantive comments. Still
  a success.
- Dev.to + Twitter combined add another 500–2,000 views over the first
  week regardless of HN. The resilient floor.
- A Show HN that *does* hit front page: 10k–50k views in 24 hours. But
  it's variance, not a plan.
- Either way the artifacts are reusable. If launch day is quiet,
  re-publish in 4–6 weeks with a new feature and a fresh angle.

## Post-launch sustain

- [ ] Track new GitHub stars, issues, PRs daily for the first week.
- [ ] Respond to every issue within 24h, even just "thanks, looking
  at it."
- [ ] Take one credible piece of feedback and ship it within 7 days.
  Reply to the original commenter that it's done. Converts critics
  into advocates every time.
- [ ] Two weeks in: write the follow-up about what real users surfaced.
  Cross-post the same way. The second swing usually does better
  because you've internalized the feedback.

## Why this framing works

The current AI-tools landscape is saturated. Users have been burned by
hype and are deeply skeptical of new tools claiming superiority. The
winning move is not louder marketing — it's surfacing a *concrete
outcome* they can verify themselves in one command.

"Converged answer from three frontier AIs in one terminal" is a sentence
the reader can either get value from in 2 minutes (run the command,
judge the output) or dismiss in 30 seconds. Both outcomes are fine. What
loses is preamble — explaining the mechanism before the value lands.
