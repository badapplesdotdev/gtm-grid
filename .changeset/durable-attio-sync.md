---
"@gtmgrid/db": patch
"@gtmgrid/services": patch
"@gtmgrid/web": patch
"@gtmgrid/desktop": patch
---

Fix large CRM imports timing out or remaining stuck in a syncing state.

CRM pulls now checkpoint each provider page into a fresh durable Inngest run,
heartbeat active syncs so healthy long-running imports are not reaped, and stop
finalized or paused continuations before they can write duplicate rows. The
checkpoint carries the run schema, row budget, and actor cache so large Attio
and HubSpot sources avoid repeated metadata calls and unbounded Inngest state.
