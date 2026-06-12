---
"@gtmgrid/services": patch
"@gtmgrid/desktop": patch
---

Clay-style webhook tables: every webhook now lands records in a dedicated
"Webhook" column, so received data is always visible — even on a table with
no other columns and no field mappings. Cells render as "Received <date>";
clicking opens the payload in the cell-details panel, where each field has
an "Add to column" action that promotes it to a real column applied to all
existing and future rows. Re-enabling an existing webhook heals it with the
new column. Mapping replaces never drop the raw-payload entry.
