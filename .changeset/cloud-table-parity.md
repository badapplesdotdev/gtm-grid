---
"@gtmgrid/desktop": minor
"@gtmgrid/web": minor
---

Cloud tables now support rename and pin-to-favourites in the sidebar, matching local tables. Renames persist via a new `grid.renameTable` mutation and broadcast `table.rename` so every member's sidebar and the open grid relabel live. Favourites are workspace-shared (a `favorite` column on the table row): any member's pin is visible to the whole workspace, sorts favourites to the top, and broadcasts `table.favorite` so sidebars restyle and reorder in real time.
