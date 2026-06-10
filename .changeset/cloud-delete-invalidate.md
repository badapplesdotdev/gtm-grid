---
"@gtmgrid/desktop": patch
---

Fix cloud grid not reflecting column/row deletes and column edits.

The live grid renders the PAGED query (`grid.getTablePage`), but the cloud
mutations either didn't refetch or invalidated only the unpaged `grid.getTable`
cache — so deleting a column/row or editing a column left the change invisible
(and a re-delete surfaced a scary "Column … not found") whenever the realtime
broadcast was unconfigured or dropped.

- `deleteColumn` / `deleteRow` now optimistically drop the column/row from the
  cache for instant feedback, then invalidate both the paged and unpaged grid
  queries to reconcile with the server.
- `updateColumn` (edit column) now invalidates the table's grid queries so the
  edit reflects without relying on the realtime `column.update` event.
- A "… not found" delete is treated as already-done (no error banner) — the
  refetch drops the stale row/column.
