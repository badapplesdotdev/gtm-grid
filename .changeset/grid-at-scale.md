---
"@gtmgrid/desktop": minor
"@gtmgrid/engine": minor
"@gtmgrid/server": minor
"@gtmgrid/mcp": minor
---

Grid at scale: dedup + full agent control (bundles #53, #54, #55).

- **Global-db credentials & extensions** (#53) — resolve credentials *and*
  extensions from the global db in `openProject`, fixing Exa/Firecrawl keys and
  the agent missing connectors (firecrawl/notion/supabase).
- **HTTP request column** (#54) — generic HTTP request column (full request
  builder + try-on-N-rows) plus a LeadMagic 38-endpoint mapping.
- **Agent session continuity** (#55) — resume the CLI's native session so chat
  survives Stop/restart, with stdin/transient-id fixes.
- **Table deduplication** — Clay-style dedup: engine + `set_dedupe` agent tool +
  `add_rows` auto-dedup + a Deduplication panel in the table toolbar (toggle,
  column picker, keep oldest/newest, one-shot sweep).
- **Full agent CRUD + safety** — `find_rows`, `get_column`, paginated
  `get_table` with row ids, `update_cells`/`update_column`/`rename_table`,
  `delete_rows`/`delete_column`/`delete_table`; destructive/large ops return a
  `{confirmationRequired, willAffect, estimatedCredits}` preview and require
  `confirm:true` to execute. `get_table` truncates large cell values to bound the
  agent's token budget.
