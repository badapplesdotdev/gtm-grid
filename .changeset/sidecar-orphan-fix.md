---
"@gtmgrid/desktop": patch
---

Fix "Server not reachable" after an in-app update. The auto-update relaunch left
the previous local engine sidecar running (orphaned, holding the port), so the
updated app's UI talked to a stale older sidecar missing newer routes and
reported the server as offline. The sidecar now self-terminates when its parent
app exits, retries binding the port during the relaunch handoff, and the app
gates its connection state on the health check alone.
