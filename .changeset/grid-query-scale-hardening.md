---
"@gtmgrid/desktop": patch
---

perf(grid): bound every server-side grid read so large tables (50k+ rows) stay fast

The desktop render path was already keyset-paginated, but the server-side compute
paths still loaded the whole grid per operation. This eliminates the unbounded
full-grid `getTable` from those paths and adds the index that keeps row loads
sort-free:

- **Index**: new `rows(table_id, position, created_at, id)` composite so the
  ordered + keyset row loads are index-ordered scans (no in-memory sort of 50k rows).
- **Engine column runs** now scope to the run's rows (`getTableForRows`) and stream
  full-column runs one keyset page at a time (`getTablePage`) — bounded memory.
- **Webhook enrichment** reads columns-only, and the per-run **quota pre-flight**
  reads just the run column's cells instead of the whole grid.
- **Dedupe** reads only the dedupe column's cells (rides `cells_by_table_column`).
- **MCP `get_table`** is now genuinely server-paged (walks keyset pages) instead of
  fetching the whole grid and slicing in memory.
- The legacy unbounded `getTable` remains only behind a guarded, telemetry-logged
  fallback.
