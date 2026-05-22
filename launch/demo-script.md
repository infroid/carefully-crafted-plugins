# Demo recording script

The single highest-leverage artifact in the launch. Cross-used by HN,
Dev.to, Twitter, and Reddit. ~15–30 seconds.

## Setup

- **Tool**: `asciinema` (preferred — text-searchable, lightweight, embeds
  cleanly in Dev.to). Fallback: any screen recorder → ezgif.com → GIF.
- **Terminal**: clean colour scheme, large font (16–18pt). Hide your prompt
  if it's verbose. Set `PS1="$ "` for the recording session.
- **Window size**: 100 × 30 cols at most. Anything wider gets cut off on
  mobile.
- **Pre-warm everything**: log into `codex` and `agy`, install both plugins,
  test that `/converge:debate` returns *something* before recording. Don't
  let the demo fail on first-time auth.

## Pick the demo question carefully

The question must be:

1. **Genuinely hard** (otherwise the synthesis looks like a generic answer).
2. **Short to type and read** (this is a 15s demo, not a workshop).
3. **Likely to produce real disagreement** between vendors.

Suggested options (pick one — Option A is the safest bet):

- **Option A** (architecture, broadly contentious):
  `Should our microservice migrate from REST to gRPC?`
- **Option B** (security, useful disagreement):
  `Should we move user auth from session cookies to JWTs for our SPA?`
- **Option C** (language/runtime, the "let them disagree" classic):
  `Is Rust the right choice for our new high-throughput data pipeline?`

## Recording sequence (target 15s, can stretch to 30s)

```
0s   Cursor in a clean terminal. Claude Code prompt visible.
1s   Type: /converge:debate "Should our microservice migrate from REST to gRPC?"
3s   Hit enter. Claude's response begins: "Running converge in full mode.
     Phase 1 (independent answers) — invoking Codex and Antigravity in
     parallel..."
4s   Either: let it run real, OR cut here and resume at Phase 4.
9s   [CUT] Resume on the synthesis output. Phase 4 header visible:
     "### Consensus" ... "### Disagreements" ... "### Recommendation"
13s  Scroll/highlight the Disagreements section briefly — that's the
     interesting part.
15s  Stop recording.
```

For the version that fits 15s tightly: skip the live Phase 1, jump straight
from `enter` → Phase 4 output. State this is a fast cut in the Dev.to
caption.

## What to *show*, what to *hide*

**Show:**
- The exact slash command (`/converge:debate "..."`).
- One line confirming three agents started (so viewers see this isn't
  single-model).
- The structured synthesis output: section headers visible, the
  Disagreements section getting a brief highlight.

**Hide / blur:**
- Auth tokens, project paths, internal repo names if any leaked into
  prompts.
- Anything with your real client / employer name.

## Export

### Option 1 — asciinema (recommended for Dev.to and HN)

```bash
asciinema rec converge-demo.cast
# (do the demo)
# Ctrl-D to stop

# View locally:
asciinema play converge-demo.cast

# Convert to SVG for embedding (crisp, scalable):
npx svg-term-cli --in converge-demo.cast --out converge-demo.svg --window

# Or upload to asciinema.org for the canonical embeddable link:
asciinema upload converge-demo.cast
```

The asciinema.org embed renders inline on Dev.to and as an oEmbed on most
platforms. Use that link in the article and the Twitter thread.

### Option 2 — screen recording → GIF

For Twitter (which embeds video natively from MP4 better than GIF, and
allows 2 min):

```bash
# Record with QuickTime / OBS / Loom → save as .mp4
# Upload .mp4 directly to Twitter — DO NOT convert to GIF for Twitter
# (their compression destroys GIFs).
```

For HN / Reddit (which need an image link, not video):

```bash
# Convert MP4 → GIF via ezgif.com (Crop → Speed up → Effects: optimize)
# Target: < 5 MB, < 600px wide. Larger GIFs are slow to load and lose
# upvotes.
```

## Quality checklist before publishing

- [ ] The demo runs end-to-end at least once exactly as recorded — no
  hidden tabs, no cuts that hide a failure.
- [ ] The terminal font is readable on mobile.
- [ ] The total runtime is ≤ 30 seconds. Re-record if it crept longer.
- [ ] The first 3 seconds show enough that someone can stop scrolling and
  know what this is.
- [ ] No leaked tokens, paths, or proprietary terms.
- [ ] The same demo link works on Dev.to, in the GitHub README, and as an
  embed on Twitter. Test all three before launch day.

## Embed it everywhere

Once you have the asciinema URL or GIF:

1. Top of [article-main.md](./article-main.md) (replace the placeholder).
2. Top of the GitHub repo's main README.
3. Tweet 1 of [twitter-thread.md](./twitter-thread.md).
4. The Show HN body — HN doesn't render embeds, but link the asciinema URL
   in the first sentence so it's the first click.
5. The r/ClaudeAI post — Reddit renders asciinema embeds in some clients;
   even where it doesn't, the link is the first click.
