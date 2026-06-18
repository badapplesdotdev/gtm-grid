---
"@gtmgrid/desktop": patch
---

Track the active cloud table in the agent co-pilot's system-prompt context. Previously the "Active table" hint was derived only from local SQLite `tableData`, so in cloud mode the agent stayed stuck reasoning about a stale table while its MCP tools (keyed off `GTMGRID_CLOUD_TABLE`) operated on the correct one. `activeTable` now sources from the active cloud table via `useCloudTablePaged` when in cloud mode (sharing CloudGrid's paged query key, so no extra fetch), falling back to `tableData` locally.
