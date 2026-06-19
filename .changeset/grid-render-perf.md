---
"@gtmgrid/desktop": patch
---

perf(grid): memoize the data-grid row/cell tree so the existing row + column virtualization actually pays off. Extracted `React.memo` `GridRow`/`GridCell` from the inline render-prop and decoupled the rows from the controller via stable action/interaction bundles. Fast scrolling and single-cell edits no longer re-render the whole viewport, and the row-hover highlight tracks the cursor. Measured on a 2,000×40 table: an unrelated re-render goes from 25,000 cell renders to 0, a single cell edit from 25,000 to 1, and a scroll step from 250 to ~10 — 4.5–13× less render scripting per frame.
