---
"@gtmgrid/services": patch
"@gtmgrid/desktop": patch
---

Fix "undefined is not an object (evaluating 'snapshot.columns')" when
deleting a column (or row) on a cloud table: the optimistic cache patch fed
react-query's `undefined` (no cached unpaged snapshot — the normal state
while the grid loads paged) into the grid reducer, which only guarded
`null`. The reducer now tolerates both, and the optimistic path skips absent
cache entries entirely.
