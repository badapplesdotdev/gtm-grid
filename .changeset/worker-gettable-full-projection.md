---
"@gtmgrid/services": patch
---

Fix every cloud column run failing silently: the worker `getTable` payload
shipped columns as `{id}` only, but the engine's cloud store finds the run
column by `_id`, the agent's cloud tools resolve columns by `name`, and the
webhook enricher filters by `kind` — so GUI column runs, agent cloud
get_table/run_column, and webhook auto-run enrichment were all dead on the
Postgres tier (promoted mapping columns stayed "—" forever). The payload now
carries full Convex-doc-shaped columns/rows (`_id` + name/kind/code/params/
condition/position, with `id` kept for legacy readers).
