---
"@gtmgrid/services": minor
"@gtmgrid/desktop": minor
"@gtmgrid/web": minor
"@gtmgrid/mcp": minor
"@gtmgrid/db": minor
---

Bring back the Auto-run toggle, and let agents drive it.

The toolbar's Auto-run switch disappeared in "remove the local paradigm" (#126).
That change deleted the local grid, which was the only thing that ever passed
`autoRun` into `DataGrid` — the switch itself, and its CSS, survived untouched,
so the control was rendered conditionally on a prop nobody supplied any more. The
gate it enforced went with it: since then every cloud cascade has run every
dependent column, billed connectors included, with no way to say no.

Auto-run is now a persisted, workspace-shared property of the table
(`tables.auto_run`, `NOT NULL DEFAULT true`) rather than a per-browser
`localStorage` flag, because it governs shared credit spend — it has to mean the
same thing for every member, for the server-side webhook worker, and for an agent
driving the grid.

- **The switch is back** in the grid toolbar, reading and writing the persisted
  flag. Toggling is optimistic through the same reducer the realtime
  `table.autoRun` event uses, so it flips instantly and every other member's grid
  follows live.
- **Auto-run off stops billed cascades**, not the grid. Formula, mapped and code
  columns still cascade for free; only columns that dispatch a billable connector
  call wait for an explicit run. Running a billed column by hand still fills the
  free columns downstream of it.
- **Inbound webhooks respect it too.** A table's auto-run ANDs with the
  connection's own flag — an HTTP-delivered row is the one path that spends
  credits with nobody watching, so "nothing in this table enriches itself" now
  holds there as well. The row still lands; only the enrichment is withheld.
- **Agents can read and set it** via a new `set_auto_run` MCP tool (and `autoRun`
  on `get_table`), so an agent can turn it off before rewriting column configs or
  bulk-loading rows and turn it back on when the table is ready. It is the same
  switch the user sees, so the two can never disagree.

Existing tables migrate to auto-run ON, which is exactly what they have been
doing, so nothing changes until someone turns it off.
