---
"@gtmgrid/desktop": minor
---

Grid from CRM sync (Attio v1).

- New-table chooser gains "From your CRM": a 3-step wizard connects Attio
  via OAuth (read-only scopes — GTM Grid never writes back), picks an
  object or list, maps fields to columns with recommended defaults and
  live sample values, adds filters, and chooses how duplicates are
  handled (update on a match key / skip / always create).
- Synced tables pull daily at 09:00 UTC with a manual "Sync now", show a
  sync status strip + human-readable sync log (partial runs, retries,
  reconnect prompts), and cap at 10k rows (Team) / 50k (higher plans).
- Records deleted in Attio never delete grid rows — rows are marked
  "no longer in Attio" and all user enrichment survives. Synced columns
  are read-only; your own columns (including AI/function columns over
  synced rows) work as usual and are preserved across syncs.
