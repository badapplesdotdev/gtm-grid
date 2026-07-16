---
"@gtmgrid/desktop": minor
---

Grid 1.8.0

- **Reusable pipeline automations** — build, deploy, and reuse versioned multi-step automations across tables, with branching, mapped inputs and outputs, local or durable cloud execution, action estimates, and run history. Pipelines can also be created and edited with the built-in agent. (#199)
- **Share tables by URL** — publish a revocable, read-only snapshot link for a cloud table, or import a shared table into a local project through the agent. (#199)
- **Cross-table actions** — function columns can push or upsert rows into sibling tables and look up matching data without duplicating tables. Incoming pushes support field mapping, backfills, and optional target-column auto-runs. (#200)
