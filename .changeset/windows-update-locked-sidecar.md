---
"@gtmgrid/desktop": patch
---

Fix the Windows updater failing with "Error opening file for writing" for
`sidecar\node.exe` and `better_sqlite3.node`. The bundled engine was still running
(holding those files open) when the NSIS installer tried to overwrite them. The
app now stops the engine and waits for it to fully exit before downloading and
installing an update, releasing the locks.
