---
"@gtmgrid/desktop": patch
---

Run selected rows + export to CSV: row checkboxes with shift-click range
select, a "Run N selected" action (dependency-aware, non-force — done cells
aren't re-billed), context-menu actions on the selection, and a CSV export
of mapped scalar values (RFC-4180, UTF-8 BOM for Excel, and spreadsheet
formula-injection neutralized with the OWASP apostrophe guard).
