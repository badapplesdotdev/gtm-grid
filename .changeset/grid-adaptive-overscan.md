---
"@gtmgrid/desktop": patch
---

perf(grid): make the virtualization buffer velocity-adaptive so scrolling a large grid no longer paints rows/columns in. A flat overscan made scrolling worse because WebKit composites every windowed row on each scroll frame; instead the buffer now stays small at rest and during slow scrolling (cheap frames) and balloons to a large window only during a fast fling, where blank paint-in actually happens and the extra rows are imperceptible — then collapses back when scrolling settles. Rows window 8→100, columns 3→24 under fling.
