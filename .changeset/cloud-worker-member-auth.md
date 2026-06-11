---
"@gtmgrid/desktop": patch
---

Fix: the agent (and the UI cloud column run) failed on cloud tables in a packaged
prod build with `WEBHOOK_WORKER_SECRET is not configured`. The desktop sidecar and
the MCP it spawns authenticated to the cloud `/api/worker/*` endpoints with the
shared worker secret, which a prod build does not ship (it is a server-only
secret) — so it only ever worked in dev. The worker routes the desktop calls
(getTable / getTableMeta / setCell / setCellStatus / setCells / getCredential /
assertColumnRunQuota, plus the create/list tools) now authenticate as the
signed-in MEMBER via the session token and enforce workspace membership
server-side (a non-member is rejected). The shared secret remains the boundary for
the headless inngest webhook worker only. This makes the agent run/create columns
and the UI run columns on cloud tables in prod, and the agent-derived column logic
persists and is re-runnable.
