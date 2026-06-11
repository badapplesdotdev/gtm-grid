---
"@gtmgrid/desktop": minor
"@gtmgrid/services": patch
"@gtmgrid/db": patch
---

Two cloud-parity improvements:

- **Live sidebar** — when a teammate creates, syncs, or deletes a table in your
  workspace, your sidebar table list now updates in real time (no app restart).
  Table create/delete events are broadcast on a per-workspace realtime room that
  the sidebar subscribes to.
- **Deduplication on cloud tables** — the Dedupe control (previously local-only)
  now works on cloud tables: pick a column and keep-oldest/newest, and the server
  removes duplicate rows and broadcasts the deletions live to everyone viewing the
  table. Adds a nullable `dedupe_column` / `dedupe_keep` to the cloud `tables`
  schema (migration included).
