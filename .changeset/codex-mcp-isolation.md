---
"@gtmgrid/server": patch
---

The Codex side-panel agent no longer crashes mid-turn when the user has other MCP servers registered. Codex deep-merges `-c` config overrides, so passing `-c mcp_servers={ gtmgrid = … }` did not actually replace the user's servers — their `~/.codex/config.toml` entries (Trigify/exa/…) and bundled plugin servers (linear/computer-use) stayed live, and Codex connecting to any OAuth-walled one made its rmcp transport quit fatally ("Transport channel closed, when AuthRequired"), taking the turn down. The Codex bridge now passes `--ignore-user-config` (the only switch that drops both config and plugin servers, since Codex has no `--strict-mcp-config` equivalent) and re-injects the user's default model + reasoning effort so the panel's "Default" model option keeps working.
