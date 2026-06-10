---
"@gtmgrid/desktop": minor
"@gtmgrid/services": minor
"@gtmgrid/web": minor
---

One shared grid for local & cloud, with clear local/cloud separation.

- **One grid, no divergence** — the local grid and the cloud grid now render the
  same `DataGrid` component, driven by an injected controller. Cloud no longer
  silently deletes a column on header right-click and no longer has a
  stripped-down add-column; it gets the identical header context menu
  (Edit / Delete), the full add-column popover (manual types + AI / function /
  formula), add-row, and run.
- **Clear local/cloud separation** — the sidebar shows ONE environment's tables:
  only cloud tables in a cloud project, only local tables in local mode. This
  removes the dual-selection bug where a cloud and a local table were both
  highlighted at once. The sync affordances (sync-all, per-row dots, auto-sync
  toggle/nudge, auto-push) now appear only in local mode while signed into cloud.
- **Cloud column editing (parity)** — new `grid.updateColumn` tRPC procedure
  (`GridService.updateColumn` → `ColumnRepo.update`) broadcasts a `column.update`
  realtime event so a rename / type / function-config change reflects live across
  clients with no refetch. The shared edit-column modal now persists in cloud.
- **Cloud AI/formula authoring** — the cloud add-column flow reuses the local
  sidecar's AI providers + formula generation (which is what runs cloud columns),
  so function / AI / formula columns can be authored in cloud too.
