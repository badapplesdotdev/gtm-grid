---
"@gtmgrid/desktop": patch
---

Fix deleted cloud tables lingering in the sidebar. `deleteTable` fired the
mutation but never invalidated the tables-list query, so the removed table stayed
visible until a manual refresh. It now invalidates the loaded tables lists and
drops the deleted table's own cached query.
