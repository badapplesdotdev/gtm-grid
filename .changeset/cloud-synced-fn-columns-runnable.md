---
"@gtmgrid/services": patch
---

Fix: after syncing a local table to the cloud, running a function (AI / formula /
code) column did nothing. The sync stamped **every** pushed cell `status: "done"`,
and a non-forced run skips `done` cells — so a synced function column had no cells
left to compute. Synced cells now take their status from the column kind: manual
(input) cells stay `done`, while function-column cells are stored `empty` so a
plain Run in the cloud recomputes them over the synced input data. The cell value
is still carried either way, so a column that reads a prior function column's
output has its input immediately.
