---
"@gtmgrid/desktop": patch
---

Rebuild the Tables page as a full management hub matching the GTM Grid Tables
design: a header with title + table-count subtitle, a controls row with search,
status-filter chips (All / Favorites / Synced / Local only, each with a count), a
sort dropdown (recently added / name / row count), and a list/grid view toggle.
The list view shows each table with a checkbox, accent table icon, name + favorite
star + column/row meta, row count, and a sync pill; the card view mirrors it.
Multi-select reveals a bulk-action bar with an inline-confirm delete, and each row
has a favorite toggle and an actions menu (open / rename / delete). Styled with the
app's tokens (the design's green accent), reusing the existing open/rename/delete/
favorite handlers.
