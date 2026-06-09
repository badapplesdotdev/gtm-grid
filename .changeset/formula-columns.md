---
"@gtmgrid/desktop": minor
---

Formula columns + conditional-run ("only run if"). **Formula columns** evaluate a JavaScript expression per row with Lodash (`_`), Moment (`moment`), and Excel/Sheets functions via FormulaJS (`VLOOKUP`, `IF`, `SUM`, …), referencing other columns with `{{Column}}`; helper libs are injected into the QuickJS sandbox on-demand so plain formulas stay fast, and `{{Column}}` compiles to typed input refs (not string interpolation). **Conditional-run** adds a per-column boolean expression that gates whether an enrichment runs for a row, so credits aren't spent when the condition is false. Both are generatable from natural language by the connected coding agent, with full parity across desktop, the MCP agents, and the cloud (Postgres) path.
