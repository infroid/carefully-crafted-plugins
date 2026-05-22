# Launch playbook

Everything needed to ship `converge` (and the underlying `codex` + `agy`
bridges) onto Hacker News, Dev.to, Twitter/X, and Reddit. ROI-ranked.

## The hook, restated

The marketplace is **bridges + a converger**. For virality the lead is
`converge` — three frontier models (Claude, GPT-class via Codex, Gemini 3 Pro
via Antigravity) running a structured 4-phase debate in one terminal. The
bridges are supporting infrastructure for that story, not the story.

Do not lead with "another Claude Code plugin." Lead with multi-agent debate.

## Pre-launch checklist (do these first)

- [ ] **Record a 15–30 s demo** — see [demo-script.md](./demo-script.md).
  - asciinema (preferred — text-searchable, lightweight) → svg-term-cli for a
    crisp SVG/GIF; or Loom/QuickTime → ezgif.com for an MP4→GIF.
  - This single artifact is cross-leveraged across HN, Dev.to, Twitter,
    Reddit. Do not skip.
- [ ] **Verify install actually works** on a clean machine — fresh shell, no
  caches. The first thing readers will do is try the install command. Any
  rot kills credibility.
- [ ] **Star the repo from your own account** (one is better than zero on
  first impression).
- [ ] **Pick the launch day**: Tuesday, Wednesday, or Thursday. Avoid Mondays
  (catch-up day), Fridays (everyone leaves early), and US holidays.
- [ ] **Pick the launch hour**: 8–10 a.m. US Pacific = 11 a.m.–1 p.m. US
  Eastern = 4–6 p.m. UK = morning India end-of-day. Optimizes for the global
  developer waking window.

## Launch-day timeline (T-hour = first publish time)

| Time | Action | Channel |
|---|---|---|
| T+0 min | Publish [article-main.md](./article-main.md) | Dev.to |
| T+15 min | Confirm Dev.to article is live and the demo embed renders | — |
| T+30 min | Submit [show-hn.md](./show-hn.md) | Hacker News |
| T+60 min | Post [twitter-thread.md](./twitter-thread.md) | X / Twitter |
| T+2 h | Sit at the keyboard. Reply to every substantive HN comment within 15 min for the first 4 hours. This is *the* lever for front-page rank. |
| T+next day | Post [reddit-claudeai.md](./reddit-claudeai.md) | r/ClaudeAI |
| T+2 days | Submit article to a Medium publication (Dev Genius, Towards Data Science). Slight reframe: lead with the personal "I built this because…" narrative arc Medium readers prefer. |
| T+1 week | If HN was a hit, write a follow-up: "What I learned from \<N\> people using converge" with real samples. Re-launch energy. |

## Channel-by-channel playbook

### Hacker News — the lottery ticket

Per your framework: front-page hit = 10k+ visitors in hours. Realistically,
most Show HNs do not hit the front page. Don't bank on it; do everything
right and accept variance.

What actually drives front-page rank:
- **First 60 minutes of upvotes and substantive comments matter most.** That
  is the algorithmic crit window.
- **Author engagement.** Reply quickly, technically, and *honestly*. HN
  smells defensiveness and hype instantly. Concede where the commenter is
  right; push back where you have evidence.
- **Title** matters more than body. Use [show-hn.md](./show-hn.md) verbatim
  — do not "improve" it on the fly.

Anticipated comments and prepared responses are in
[hn-faq.md](./hn-faq.md).

### Dev.to — the canonical link

This is what HN, Twitter, and Reddit will all point at. Make sure:
- The 15-second demo is at the very top, *above the fold*.
- Code snippets are copy-pasteable. Test that.
- Links to the GitHub repo are unmissable (top, middle, bottom).
- Tags: `#ai`, `#claudecode`, `#openai`, `#opensource`, `#tutorial`.

Cross-post a slight reframe to a Medium publication 2 days later. Don't
publish on personal Medium — it dies in an empty stream.

### Twitter / X — amplification

The AI-engineering community lives here. The thread does the heavy lifting;
the demo GIF is the first hook. See [twitter-thread.md](./twitter-thread.md).

Tag handles in the *reply* tweets, not the lead — don't bury the hook.
Useful accounts to consider tagging: @AnthropicAI, @OpenAIDevs, @GoogleAI
(only if accurate to your post — do not spam-tag for reach).

### Reddit — niche, high-intent

- **r/ClaudeAI** — primary. Use [reddit-claudeai.md](./reddit-claudeai.md).
- **r/LocalLLaMA** — skip. Different crowd (self-hosted models).
- **r/programming** — skip. Too noisy for tools.
- **r/OpenAI**, **r/singularity** — optional, lower fit.

Reddit downweights overt self-promotion. Lead with the technical content,
not "I built this!" Use first person sparingly.

### Medium — long tail

- Submit to Dev Genius, Better Programming, or Towards Data Science as a
  guest post. Do not publish straight to your personal profile.
- The reframe: more narrative arc ("Why I distrust single-AI answers, and
  what I built about it"), less terse-engineering.

## Realistic expectations

- A Show HN that *almost* hits front page is the most common outcome. 200–
  1,500 views, 5–30 stars on the repo, a handful of substantive comments. That
  is still a success.
- Dev.to + Twitter typically add another 500–2,000 views over the first week
  whether HN pops or not. That is the resilient floor.
- A Show HN that *does* hit front page can do 10k–50k views in 24 hours, but
  it's variance, not a planned outcome.
- Either way: the artifacts are reusable. If launch day underperforms,
  re-publish in a month with one new feature and a fresh angle.

## Post-launch sustain

- [ ] Track new GitHub stars, issues, and PRs daily for the first week.
- [ ] Respond to every issue within 24 h, even just "thanks, looking at it."
- [ ] Take one piece of credible feedback and ship it within 7 days. Then
  reply to the original commenter that it's done. This converts a critic
  into an advocate, every time.
- [ ] Two weeks after launch: write the follow-up article about what real
  users surfaced. Cross-post the same way.

## Honesty as a strategy

Your edge in this market is not hype — the AI-tools space is *saturated* with
hype and the audience has been burned. Be the rare honest voice:

- The article should explicitly name what `converge` does **not** do well —
  cost (6 calls), latency (minutes), and that Antigravity CLI is brand new
  (3 days old at time of writing) so its integration is best-effort. Own it.
- HN crowd values self-criticism. "Here are the failure modes I'm aware of"
  earns trust where "amazing new tool!!!" loses it.
- The `converge` honesty rules (no silent degradation, no majority ratifying)
  are themselves marketable. Lead with them.
