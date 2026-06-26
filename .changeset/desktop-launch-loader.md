---
"@gtmgrid/desktop": patch
---

Hold the branded app loader until the local engine is reachable on launch, and
show a full-screen error if it fails to start — instead of briefly flashing the
"Server not reachable" topbar during the sidecar's normal cold start.

The render gates previously held the loader only on auth + cloud-project
resolution, not on engine health, so on a warm machine the shell (and its offline
banner) rendered for the ~1-2s gap before the sidecar answered `/api/health`. The
loader now also waits on the engine; if it stays unreachable past the cold-start
grace, a dedicated full-screen error screen (`AppError`) offers Retry + Copy
diagnostics and auto-recovers when the engine comes up. The lightweight topbar
banner is retained only for a mid-session engine drop (gated on having connected
at least once), so a working session is never thrown back to a splash.
