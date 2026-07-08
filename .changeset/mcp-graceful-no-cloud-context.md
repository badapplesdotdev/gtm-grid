---
"@gtmgrid/mcp": patch
"@gtmgrid/desktop": patch
---

Stop the packaged MCP sidecar from hard-crashing at startup when it's launched
without a complete cloud context.

`selectGridEnv` was a hard throw, and the top-level call in the MCP entrypoint ran
it at module load — so any spawn whose env was missing
`GTMGRID_MODE=cloud`/apiUrl/token/workspace/project/table killed the process before
it connected, surfacing as a "tools not connected" turn plus an uncaught
`$exception` that broke the agent feature for that launch. The MCP now resolves the
context with a non-throwing `optionalGridEnv` and, when it's absent, still connects
the server (local-registry discovery tools keep working) while every grid tool
returns one actionable "open a project / select a table" error instead of crashing.
A `cloud_context` flag on the `mcp_started` beacon flags a degraded start. Covered by
tests for the non-throwing resolver and the context-less source.

Also routes the account-menu password sign-in error through `friendlyAuthError`
(matching onboarding) so an auth failure shows human copy instead of the raw fetch
message.
