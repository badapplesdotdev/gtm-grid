---
"@gtmgrid/engine": patch
"@gtmgrid/mcp": patch
"@gtmgrid/server": patch
---

Make AI columns work without a separate AI key, and explain missing-key errors so
the user can fix them.

- **AI columns fall back to the agent's own model.** When no AI provider key is
  connected, `ai.generate` now routes the prompt through the user's already-
  authenticated coding agent (Claude Code / Codex) via a new `EngineConfig.aiFallback`
  (one agent call per row — slower than a batched key, but works with no key). Wired
  into every run path: the sidecar (in-process `generateWithAgent`), the MCP local +
  cloud engines (HTTP to the sidecar's new `POST /api/ai/generate`), and the cloud-run
  lane. This also fixes the cloud MCP path, which previously had **no** AI config at
  all (so `ai.generate` failed even when a key was connected).
- **Run errors are surfaced to the agent.** `engine.runColumn` now returns the first
  cell error, and `run_column`/`run_table`/`run_function` attach an actionable
  `errorHint` — so a missing AI key, a 401, or a quota cap explains itself (and which
  panel fixes it) instead of the agent having to dig through `get_table`. The agent
  preamble is updated to relay these hints.
