---
"@gtmgrid/desktop": minor
---

Clay-style column UX

- Reworked column authoring/editing into a dedicated `ColumnEditPanel` (identity, edit rail, run menus) replacing the old column-settings modal.
- Mouse range cell-selection in the grid (click-drag to select a rectangle, shift-click to extend) with selection-aware right-click menu and copy.
- Per-cell run metadata (ran-at / run duration) surfaced in the cell-details drawer, plus a "waiting for inputs" cell state for columns with unmet input mappings.
- Connector manifest + extensions refresh (per-method categories) and engine run-metadata plumbing.
