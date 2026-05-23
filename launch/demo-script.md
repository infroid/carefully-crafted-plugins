# Demo recording script

The single highest-leverage launch artifact. Reused across HN, Dev.to,
Twitter, and Reddit. ~15–30 seconds.

## Setup

- **Tool**: `asciinema` is preferred — text-searchable, lightweight,
  embeds cleanly on Dev.to. Fallback: any screen recorder → ezgif.com →
  GIF, or upload an MP4 to Twitter directly (better compression than
  GIF).
- **Terminal**: clean colour scheme, large font (16–18 pt). Set
  `PS1="$ "` for the recording session so the prompt is minimal.
- **Window size**: at most 100 × 30 cols. Anything wider gets cut off
  on mobile.
- **Pre-warm everything**: log into both `codex` and `agy`, install all
  three plugins, and run `/contexthub:converge` once on a throwaway
  question before recording. Don't let first-time auth show up on the
  take.

## Pick the demo question carefully

The question must be:

1. **Genuinely hard** — otherwise the converged answer looks generic.
2. **Short to type and read** — this is a 15-second demo.
3. **Likely to produce real disagreement** between vendors — that's the
   moneymaker shot.

Suggested options (Option A is the safest bet):

- **Option A** (architecture, broadly contentious):
  `Should our microservice migrate from REST to gRPC?`
- **Option B** (security, real disagreement potential):
  `Should we move user auth from session cookies to JWTs for our SPA?`
- **Option C** (runtime/language classic):
  `Is Rust the right choice for our new high-throughput data pipeline?`

## Recording sequence (target 15s, can stretch to 30s)

```
0s    Cursor on clean terminal. Claude Code prompt visible.
1s    Type: /contexthub:converge "Should our microservice migrate from REST to gRPC?"
3s    Hit enter. Claude responds: "Running converge in full mode. Phase 1
      (independent answers) — invoking Codex and Antigravity in parallel…"
4s    Either: let it run real, OR cut here and resume at Phase 4 synthesis.
9s    [CUT] Resume on the synthesis output. Section headers visible:
      "### Consensus" … "### Disagreements" … "### Recommendation"
13s   Scroll/highlight the Disagreements section briefly — that's the
      moneymaker shot.
15s   Stop recording.
```

For the tight 15s version: skip the live Phase 1, jump straight from
`enter` → Phase 4 output. Note in the article caption that this is a
fast cut.

## What to *show*, what to *hide*

**Show:**

- The exact slash command (`/contexthub:converge "..."`).
- One line confirming three agents started — so viewers see this is
  multi-agent, not single-model.
- The structured synthesis output: section headers visible, the
  Disagreements section getting a brief highlight.

**Hide / blur:**

- Auth tokens, project paths, internal repo names if any leak into
  prompts.
- Real client / employer names.

## Export

### Option 1 — asciinema (recommended for Dev.to and HN)

```bash
asciinema rec contexthub-demo.cast
# (do the demo)
# Ctrl-D to stop

# Convert to SVG for inline embedding (crisp, scalable):
npx svg-term-cli --in contexthub-demo.cast --out contexthub-demo.svg --window

# Or upload to asciinema.org for a canonical embeddable link:
asciinema upload contexthub-demo.cast
```

### Option 2 — screen recording → MP4 / GIF

For Twitter (uploads MP4 natively; better compression than GIF):

```
QuickTime / OBS / Loom → save as .mp4 → upload directly to Twitter.
```

For HN / Reddit (need an image link, not a video):

```
MP4 → ezgif.com → "Crop", "Speed up", "Effects: optimize" → GIF
Target: < 5 MB, < 600 px wide. Larger GIFs are slow and lose upvotes.
```

## Quality checklist before publishing

- [ ] The demo runs end-to-end at least once exactly as recorded — no
  hidden cuts that paper over a failure.
- [ ] Terminal font readable on mobile.
- [ ] Total runtime ≤ 30 seconds.
- [ ] The first 3 seconds make the product obvious — someone scrolling
  past should be able to stop and know what this is.
- [ ] No leaked tokens, paths, or proprietary terms.
- [ ] The same demo link works on Dev.to, in the GitHub README, and as
  an embed on Twitter. Test all three before launch day.

## Embed everywhere

Once you have the asciinema URL or MP4 / GIF:

1. Top of [article-main.md](./article-main.md) (replace the placeholder).
2. Top of the GitHub repo's main README.
3. Tweet 1 of [twitter-thread.md](./twitter-thread.md).
4. The Show HN body — HN doesn't render embeds, but link the asciinema
   URL in the first sentence so it's the first click.
5. The r/ClaudeAI post — Reddit renders asciinema embeds in some
   clients; where it doesn't, the link is still the first click.
