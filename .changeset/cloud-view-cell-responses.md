---
"@gtmgrid/desktop": patch
---

You can now click a cell in a **cloud** table to view its full response (the
status-code / JSON fields), just like local tables. The cloud grid was never
wiring the cell-details drawer or the expanded editor, so synced responses
(e.g. "Status Code: 200") weren't inspectable even though the data was present.
The drawer is view-only in the cloud for now (no promote-field-to-column yet).
