---
"@gtmgrid/desktop": patch
---

Performance & scale hardening for thousands of rows + enrichments (perf epic, Tier 0 + Tier 1). Server: cap the Supavisor pool, add a global Inngest concurrency cap, chunk bulk cell/row inserts (fixes the 65535-param crash on wide CSV), collapse the per-cell cloud write to <=2 queries + batch worker writes with backpressure, make CSV import a single atomic transaction, replace the webhook upsert full-table scan with an indexed lookup, add a metadata-only table fast path, and paginate getTable cell reads. Device: virtualize the local + cloud grids, coalesce realtime events with an O(1) keyed reducer + incremental view, memoize cells and stop the full-table refetch on every edit, stream local-run progress per cell, and bound client memory to loaded pages.
