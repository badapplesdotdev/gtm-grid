---
"@gtmgrid/desktop": patch
---

Empty CRM lists now configure and sync correctly: a list's parent object is resolved from list metadata instead of its first member, so HubSpot's default lists (and any empty Attio list) describe their fields instead of erroring — and syncing an empty list no longer risks dropping mapped columns.
