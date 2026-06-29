# Nano Banana MCP backend — setup & troubleshooting

This is the deep reference behind the `/agy:setup` skill. It explains the moving
parts, the secret-handling design, and how to recover when something is off.
Everything here is **explicit** — nothing in this marketplace installs or wires
the backend on its own.

## Why a backend at all

`/agy:nanobanana` can reach Nano Banana two ways:

| | MCP backend | agy-direct fallback |
|---|---|---|
| How | gemini-cli `nanobanana` extension's MCP server, wired into Claude Code | `agy -p "generate an image…"` |
| Tools | 7 structured tools (story/edit/restore/icon/pattern/diagram/generate) | one-shot text→image only |
| Output | `nanobanana-output/` relative to the server's launch dir (see Troubleshooting) | agy's sandbox → retrieved via `agy-invoke --collect` |
| Setup | one-time, explicit (this doc) | none (works today if `agy` is logged in) |

The fallback always works for simple images. The MCP backend is what unlocks the
richer capabilities, so the rest of this doc is about wiring it.

## The pieces

1. **Gemini CLI** — used only to install/build the extension. `gemini --version`.
2. **The extension** — `gemini-cli-extensions/nanobanana`, installed into
   `~/.gemini/extensions/nanobanana/`. It is an MCP server (`mcp-server/`,
   Node + `@google/genai`), not a thin wrapper.
3. **The built server** — `~/.gemini/extensions/nanobanana/mcp-server/dist/index.js`.
4. **`NANOBANANA_API_KEY`** — a Gemini API key from https://aistudio.google.com/apikey.
   (The extension documents no Vertex AI / ADC path; AI Studio key only.)
5. **The wiring** — a Claude Code MCP-server entry that runs the built server
   with the key in its environment.

## The engine

`scripts/nanobanana-setup.mjs` does the deterministic parts. It is read-only by
default; each mutation needs its own flag:

```bash
node nanobanana-setup.mjs --status [--json]      # report (default)
node nanobanana-setup.mjs --install-extension     # gemini extensions install … --consent
node nanobanana-setup.mjs --build                 # npm install in mcp-server/ (builds dist/)
node nanobanana-setup.mjs --wire --scope project  # merge <cwd>/.mcp.json
node nanobanana-setup.mjs --wire --scope user     # print the `claude mcp add` command
```

Add `--dry-run` to `--install-extension`, `--build`, or `--wire` to preview the
exact action without performing it.

## Secret handling (important)

The API key is **never** written into any config file and **never** passed to
the assistant. The wired MCP entry references it by environment expansion:

```json
{
  "mcpServers": {
    "nanobanana": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/you/.gemini/extensions/nanobanana/mcp-server/dist/index.js"],
      "env": {
        "NANOBANANA_API_KEY": "${NANOBANANA_API_KEY}",
        "NANOBANANA_MODEL": "${NANOBANANA_MODEL:-gemini-3.1-flash-image-preview}"
      }
    }
  }
}
```

Claude Code expands `${NANOBANANA_API_KEY}` from the environment when it launches
the server, so the secret lives only in your shell. Export it (and persist it in
your shell rc if you like):

```bash
export NANOBANANA_API_KEY="…"
```

If the variable is unset at launch, Claude Code fails to start the server with a
parse error — that's the signal to export the key, not a bug.

## Scopes

- **project** (`<cwd>/.mcp.json`): shared with the repo. Safe to commit — it holds
  only the `${…}` reference, no secret. Best when the whole team uses Nano Banana.
- **user** (`~/.claude.json`): private to your machine, available in every
  project. `--wire --scope user` prints the `claude mcp add … --scope user`
  command rather than hand-editing `~/.claude.json` (which is fragile).
- **local**: per-project but private to you (also via `claude mcp add --scope local`).

## Choosing the model

`NANOBANANA_MODEL` selects which image model the server calls:

- `gemini-3.1-flash-image-preview` — Nano Banana 2, the default (fast).
- `gemini-3-pro-image-preview` — Nano Banana Pro (studio quality, best text).
- `gemini-2.5-flash-image` — Nano Banana v1 (legacy).

Export an override before launching Claude Code to use the Pro model:
`export NANOBANANA_MODEL=gemini-3-pro-image-preview`. (These `-preview` IDs are
the extension's; the standalone GA API id `gemini-3-pro-image` is a different,
non-interchangeable string.)

## Verify

After wiring, run `/mcp` in Claude Code — `nanobanana` should appear, connected,
with its tools. If you enabled it mid-session, run `/reload-plugins` or restart.
Then exercise it: `/agy:nanobanana a four-panel story of a paper plane's flight`
routes to `generate_story`.

## Troubleshooting

- **`/mcp` doesn't list nanobanana** → run `nanobanana-setup.mjs --status`. If
  `wired (.mcp.json): no`, re-run `--wire`. If wired but absent, `/reload-plugins`
  or restart.
- **Server connects but every call errors with auth** → `NANOBANANA_API_KEY` is
  unset or invalid in the environment Claude Code was launched from. Export a
  valid key and restart.
- **`--build` fails** → ensure Node ≥ 20 and network access for `npm install`;
  re-run. You can build manually: `cd ~/.gemini/extensions/nanobanana/mcp-server && npm install`.
- **Wrong/unexpected save location** → MCP tools write to `nanobanana-output/`
  relative to the **server's launch working directory**, which Claude Code does
  not guarantee equals your active project root (most noticeable for user-scope
  wiring, which loads in every project). Don't assume `./nanobanana-output/` —
  read the absolute paths the tool returns in `generatedFiles`. The agy fallback
  writes to its sandbox and is retrieved via `--collect`.

## Alternative: plugin-managed key (keychain)

Claude Code plugins can also collect secrets via `userConfig` with
`sensitive: true`, storing the key in the OS keychain and exposing it to a
plugin-declared MCP server as `${user_config.…}`. We deliberately do **not**
ship the server auto-declared in the plugin manifest, because a manifest-declared
MCP server starts on plugin enable — which would be implicit setup. The explicit
`/agy:setup` flow above is the supported path; the keychain route is a manual
option for users who prefer it.

## agy-direct fallback (no setup)

If you never set up the MCP backend, simple generation still works through agy:

```bash
AGY_TIMEOUT_SEC=300 node scripts/agy-invoke.mjs \
  --prompt "Generate an image: a flat-design red apple. Save it as a PNG." \
  --collect ./images
```

`--collect` copies the artifact out of Antigravity's sandbox into `./images`.
This path has no story/edit/icon/etc. — for those, set up the MCP backend.
