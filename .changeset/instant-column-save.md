---
"@gtmgrid/desktop": patch
---

perf(grid): make cloud column save/map feel instant. Saving or mapping a column no longer blocks on a full multi-page refetch (the optimistic patch + realtime echo already reflect it; reconcile happens in the background without an immediate refetch that could clobber a just-started run's cells), the Autumn usage flush is bounded to 2s so a slow billing call can't stall a grid write, and the edit rail / cell-details drawer close immediately. A column run now renders its unresolved cells as loading right away (done/error cells keep their result, so a re-run never flickers finished cells). A background save failure now surfaces in the grid's error banner instead of failing silently.
