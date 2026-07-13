---
"@gtmgrid/desktop": patch
"@gtmgrid/server": patch
---

Automatically discover the models available to the authenticated Codex CLI. The agent picker now refreshes from Codex's own model cache when it opens, shows the configured default model, excludes hidden models, and safely falls back when the cache has not been created yet.
