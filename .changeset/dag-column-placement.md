---
"@gtmgrid/desktop": minor
---

feat(grid): place dependent columns in dependency (DAG) order

Columns reference other columns by `{{Column Name}}` in their params or run
condition. New and edited columns are now positioned to the RIGHT of every
column they reference, so a table reads left-to-right in dependency order
instead of always appending to the end.

- **Create**: a new column with references takes a fractional slot immediately
  after its rightmost dependency; independent columns still append to the tail.
- **Edit**: when a column's references change, it (and any dependents now out of
  order) reposition via a minimal-movement topological sort — unrelated columns
  and manual arrangements are left untouched.
- **Circular references are blocked**: an edit that would make columns depend on
  each other (A↔B) is rejected before it is saved, with a clear error.

Placement is computed server-side in `GridService`, so it applies uniformly
across the desktop app, the agent, and MCP, and reuses the existing realtime
reorder path so every viewer converges on the same order.
