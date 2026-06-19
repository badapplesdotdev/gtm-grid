---
"@gtmgrid/desktop": patch
---

perf(grid): eliminate the paint-in flicker when scrolling a large grid and the laggy hover highlight. Raised the virtualization overscan buffer so ~one viewport of rows and columns is pre-rendered on each side — WebKit's momentum scroll no longer reaches the blank spacer before React commits the next rows, so rows/columns no longer visibly paint in as they scroll into view. The scroll container now matches the cell background so any momentary gap blends instead of flashing. Removed the cell background transition so the row-hover highlight tracks the cursor instantly instead of fading in over 80ms.
