---
"@gtmgrid/services": patch
---

Fix the scheduled Social Signals poll cron failing on every run. `SignalService.listDuePage` built its due-filter as a parameterised `CASE` whose branches were all untyped bound params (or `NULL`), so Postgres couldn't resolve the CASE result type and the outer `last_synced_at <= CASE(...)` comparison failed at execution (`Error: Failed query`) on every hourly tick — meaning no enabled binding had been synced for any workspace. Anchor the CASE type by casting each threshold to `::bigint`. Adds a real-Postgres (in-process PGlite) test that executes `listDuePage` with mixed schedules, so this regression is caught instead of passing on the in-memory path.
