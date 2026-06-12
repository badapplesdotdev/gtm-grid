---
"@gtmgrid/desktop": patch
"@gtmgrid/services": patch
"@gtmgrid/db": patch
---

Sidebar folders for tables, on both local and cloud projects: create, rename,
and delete folders, file tables into them ("New table here" included), and
drag to reorder. Deleting a folder unfiles its tables (never deletes them).
Folder changes broadcast on the workspace room so teammates' sidebars update
live. Cloud adds a `folders` table + `tables.folder_id` (migration 0009);
local SQLite upgrades in place.
