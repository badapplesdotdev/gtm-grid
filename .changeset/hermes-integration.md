---
"@gtmgrid/desktop": minor
---

Hermes integration (Nous Research Hermes). Adds a **Hermes** coding-agent tab alongside Claude/Codex that drives the grid locally over ACP (Agent Client Protocol) with the gtmgrid MCP tools mounted in — so the grid and its tools never leave the machine. Also exposes Hermes as an OpenAI-compatible **AI provider**, so `ai.generate` columns can run against a Hermes gateway (each cell gets the agent's full memory/context). The Hermes agent process is spawned detached and torn down via the shared process-group cleanup (no orphaned subprocess leak), with a max-run timeout.
