---
"@gtmgrid/desktop": patch
---

perf(grid): revert the overscan escalation that was making large-grid scrolling worse. Benchmarking the real render cost (full DataGrid + CellContent) proved the paint-in blank is the cost of the cell COUNT per scroll step, not the cell content — so a bigger overscan buffer makes it worse, not better. The velocity-adaptive 8→100 expansion rendered ~3,100 cells in a single commit (~197ms) — the catastrophic blank in the bug report. Reverting to a small constant overscan renders only the ~680 cells entering view per fast-scroll step (~45ms, a 4.3× reduction) and eliminates the expansion spike entirely; normal/slow scrolling is now ~2.4ms.
