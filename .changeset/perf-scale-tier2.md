---
"@gtmgrid/desktop": patch
---

Performance & scale hardening, Tier 2. Server: retry/backoff + timeout on connector and worker HTTP (429/Retry-After aware, 402 fatal); pre-run credit/quota gate so an over-quota column run is rejected up front instead of over-metering; signals cron now filters due bindings in SQL with keyset pagination + chunked fan-out, bulk-inserts results, and dedupes via a durable signal_seen_keys table (no more >1000 re-insert); per-column Inngest step keys so a retry never re-charges completed columns; honor connector batchSize (one call per batch); cached worker Effect runtime + a process-wide sidecar concurrency semaphore with a clamped run concurrency. Device: run-all now runs independent columns concurrently (dependency-ordered).
