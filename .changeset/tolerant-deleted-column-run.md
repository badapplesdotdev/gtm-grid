---
"@gtmgrid/engine": patch
"@gtmgrid/server": patch
---

Treat a column deleted mid-run as a benign no-op on the cloud run path.

A cloud run is fanned out per column from the desktop's column snapshot, so a
queued run can reach a column the user has since deleted. The engine now raises a
typed, value-free `ColumnNotFoundError` (the id rides a structured field, not the
message), and the sidecar resolves that run as a no-op instead of reporting a raw
exception with the column id in its title.
