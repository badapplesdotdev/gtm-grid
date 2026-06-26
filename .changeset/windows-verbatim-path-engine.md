---
"@gtmgrid/desktop": patch
---

Fix the Windows engine crash-on-launch (`EISDIR: lstat 'C:'`). The bundled Node
engine exited immediately on every affected Windows machine, so the app read as
`engine: unreachable` and never loaded.

Root cause (surfaced by the new boot diagnostics): Tauri's `resource_dir()`
returns a Windows **verbatim / extended-length path** (`\\?\C:\…`). We passed that
straight to `node.exe` as the script argument, and Node's main-module resolver
can't parse the `\\?\` prefix — it mis-splits the path and calls `lstat('C:')`,
which is a directory, so it dies with `EISDIR` before ever loading `server.mjs`.

Fix: simplify the resolved sidecar dir with `dunce::simplified` to a plain
`C:\…` path before spawning, so the script arg, cwd, MCP launcher and extension
dir are all non-verbatim. No-op on macOS/Linux.
