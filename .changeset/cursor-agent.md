---
"@gtmgrid/desktop": minor
---

feat(agent): replace the Hermes coding agent with Cursor (`cursor-agent`) as the third side-panel AI agent, alongside Claude and Codex. It drives the grid over MCP using your Cursor subscription (`cursor-agent login` once). Hermes is retained as an AI model provider for AI columns. The cloud member token cursor-agent needs is written to an owner-only (0600) MCP config that is deleted after each turn.
