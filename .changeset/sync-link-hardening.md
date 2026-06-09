---
"@gtmgrid/desktop": patch
---

Harden cloud table sync state. Sync/link status now hydrates from the sidecar (new `GET /api/cloud/tables/links`, behind the loopback-Host/allowed-Origin gate) as the source of truth instead of a localStorage mirror, so a synced table can't show "Local only" from a stale/drifted cache. And an open cloud table whose id was deleted by a re-sync swap now self-heals — it falls back to the table's current linked cloud id instead of getting stuck on "This cloud table no longer exists".
