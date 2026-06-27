---
"@gtmgrid/server": patch
"@gtmgrid/desktop": patch
---

Fix the GTM Grid table tools (`get_table`, `add_rows`, `run_function`,
`list_providers`, …) never loading inside the agent panel on Windows.

Root cause: the spawned coding-agent CLI (claude / codex / cursor) was told to
launch gtmgrid's MCP server via an extensionless `#!/bin/bash` launcher script
(`gtmgrid-mcp`). That script was only ever written on macOS/Linux, and even when
present Windows cannot execute it — so the agent connected with **no** grid tools
while the app otherwise looked healthy.

Fix: spawn the bundled `node` binary directly with `mcp.mjs` as a script
argument — the one launch shape every MCP client starts identically on macOS,
Linux and Windows. The Rust shell now exports `GTMGRID_MCP_NODE` +
`GTMGRID_MCP_SCRIPT` (both already de-verbatim'd), `mcpConfig` emits
`command` + `args`, and the Codex `-c mcp_servers=…` TOML now escapes the
backslashes in Windows paths (the old inline form produced invalid TOML on
Windows). The unused bash launcher is no longer bundled.
