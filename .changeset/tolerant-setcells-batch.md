---
"@gtmgrid/services": patch
---

Stop a deleted row or column from failing an entire cloud column run.

The batched worker cell write now skips a cell whose (row, column) no longer
resolves instead of failing the whole chunk. Deleting a row or column while a
run is in flight is normal, and one missing target used to drop every
already-computed write in the buffered chunk and abort the run. Each write in
the batch is now applied on its own; `setCells` returns the count written and
the count skipped so a partial write is distinct from a total one.
