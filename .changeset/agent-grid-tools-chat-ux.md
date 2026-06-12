---
"@gtmgrid/desktop": patch
"@gtmgrid/server": patch
"@gtmgrid/mcp": patch
"@gtmgrid/services": patch
---

Agent grid mutation tools + chat UX: the agent can now rename tables,
reorder columns/rows, run a whole table, and use the full mutation surface
on CLOUD tables (member-gated worker routes, metered, with confirm-protocol
dry-runs for destructive ops). Chat gains slash commands, /goal, permission
modes (bypass/auto/accept-edits/plan), a plan drawer, per-agent threads, and
table rename/reorder realtime events.
