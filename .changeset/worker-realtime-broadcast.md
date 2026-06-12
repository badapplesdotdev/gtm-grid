---
"@gtmgrid/services": patch
---

Webhook rows and column-run results now appear in the grid in real time.
Worker-path writes (webhook insertRow/upsertRow and the engine's cell
writes during cloud column runs) previously hit Postgres without
broadcasting, so open grids stayed stale until a refetch. They now publish
the same realtime events member edits do — `row.insert` with the mapped
cells when a record lands, `cell.upsert` with the post-merge state on
every worker cell write.
