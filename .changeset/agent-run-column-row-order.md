---
"@gtmgrid/mcp": patch
"@gtmgrid/server": patch
---

Agent column runs now enrich rows in grid order. The `run_column` MCP tool gains
optional `limit`/`offset` params that scope a run to the next N **unfilled** rows
in the order the grid displays them (threaded into the engine's existing ordered
`rowIds` scope). Previously the tool could only run *all* pending rows, so when a
user asked an agent to "run this column for 10 rows" the agent improvised and
enriched a scattered, seemingly-random subset. The agent operating manual now
directs the model to use `limit` for "run N rows" / "do the next N" requests.
