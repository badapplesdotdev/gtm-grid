---
"@gtmgrid/desktop": patch
---

Add a Tables page for searching and managing tables, mirroring the connectors
gallery. Reachable via "Browse all" in the sidebar's Tables section, it shows
every table as a card (column/row counts for local tables, a cloud badge for
cloud ones), with search and inline actions — open, favorite, rename (local), and
delete (local + cloud) — reusing the existing table handlers and confirm dialogs.
The sidebar also gains a compact "Recent" group of the 5 most-recent tables (shown
once there are more than 5) for quick access.
