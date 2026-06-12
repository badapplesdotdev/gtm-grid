---
"@gtmgrid/desktop": patch
---

Cascade auto-run: when a column runs (or a cell is edited), dependent mapped
columns now auto-populate — free columns (formulas and no-provider code)
always cascade; billed enrichment columns cascade only when Auto-run is on.
Cycles are guarded (each column runs at most once per cascade).
