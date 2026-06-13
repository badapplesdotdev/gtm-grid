---
"@gtmgrid/mcp": patch
"@gtmgrid/server": patch
---

Cloud agents can now reliably read, write, and POPULATE the table they name.
Previously the cloud MCP ignored the `table` argument and pinned every tool to
the single active table, so naming another table silently operated on the wrong
one — and `add_rows` would throw, making agents stage data to `/tmp` instead of
filling the grid.

- Full multi-table addressing: the cloud source resolves a table name/id to the
  right cloud table (project-wide list, cached; defaults to the active table on
  the hot path) and threads it through every tool — `get_table`, `add_rows`,
  `run_column` (incl. its workspace/credential resolution), deletes, reorders, etc.
- Cloud `get_table` reaches parity with local: paging (`limit`/`offset`), capped
  cell values (a huge enrichment blob no longer blows the response), `totalRows`/
  `truncated`, and per-column logic for diagnosis.
- Cloud-aware agent preamble: tells the agent it's on a shared cloud project, that
  it can address any table by name, to populate via `add_rows` (no scratch files),
  to batch large inserts, and to stop on a quota error.
- Worker errors surface the route's own message (e.g. the quota text, prefixed
  `[quota]`) instead of a raw `Worker route … failed: 402`; unknown-column errors
  now list the table's valid column names.
