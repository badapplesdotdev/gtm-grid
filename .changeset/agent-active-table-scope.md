---
"@gtmgrid/desktop": patch
---

Fix: a goal could spin up a brand-new table instead of using the one in view.

When the app auto-selects a table on open, the agent's "active table" hint was
sourced only from a paged fetch that lags the synchronously-set selection. A goal
sent in that window reached the agent with the MCP's table default but no table
NAME, so the preamble dropped its "Active table" section and the agent, not knowing
which table it was on, created a new one. The hint now falls back to the table name
from the already-loaded tables list, so it's populated the instant a table is
selected (auto-default on open or manual click). Covered by a unit suite on the
resolver and an end-to-end test that boots the app, lets it auto-default, and
asserts the goal request carries the active table.
