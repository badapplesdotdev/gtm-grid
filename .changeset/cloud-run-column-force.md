---
"@gtmgrid/desktop": patch
---

Fix: running a function/code column on a cloud table that was synced from local did
nothing — it flicked to "running" and immediately exited without computing. A
local→cloud synced table arrives with every cell marked `done`, and a non-forced
run skips `done` cells, so there was nothing left to run. An explicit column Run in
the cloud now force-recomputes the column (per-cell run already forced), so Run
actually executes the logic over the synced data.
