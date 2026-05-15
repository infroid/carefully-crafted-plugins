---
name: delegate
description: Delegate a task to Google Gemini CLI. (Coming soon — placeholder; not yet implemented.)
disable-model-invocation: true
---

# Gemini Bridge — Coming Soon

The Gemini bridge is reserved for a future release of `carefully-crafted-plugins`.

When implemented, it will follow the same 5-section handoff contract as the Codex bridge:

1. What to do
2. How to do
3. Standard constraints (referenced from `docs/carefully-crafted-plugins/constraints/`)
4. Expected output and format (referenced from `docs/carefully-crafted-plugins/output-formats/`)
5. Pre-flight clarifications

Likely v1.1 capabilities: long-context document analysis (2M+ token window), multimodal input (PDFs, images as input), and Google-ecosystem tool access.

For now, print this message to the user and stop:

> The `/gemini:delegate` command is a placeholder. The Gemini bridge is coming
> in a future release of `carefully-crafted-plugins`. In the meantime, use
> `/codex:image`, `/codex:reason`, `/codex:browser`, or `/codex:exec`.
