---
"@gtmgrid/services": patch
"@gtmgrid/desktop": patch
---

Fix the Tables page showing duplicate tables and no row counts for cloud tables.

- **Row counts**: `grid.listTables` now attaches each table's row count from a
  single grouped `countByTableIds` query (the efficient primitive existed but was
  never wired in; the in-memory repo was also missing it — a latent type error).
  The Tables page and sidebar now show real cloud row counts ("124 rows") instead
  of "Cloud table"/"—"; a table whose count an older server doesn't report falls
  back gracefully.
- **Duplicates**: removed the sidebar "Recent" group, which repeated the 5 most-
  recent tables already shown in the full list below it. The Tables page already
  de-dupes by name.
- The sidebar table rows now show a row count (hidden on hover, like folders).
