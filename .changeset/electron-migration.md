---
"@gtmgrid/desktop": major
---

Migrate the desktop app from Tauri (Rust shell + bundled Node sidecar) to Electron
(the engine runs as Electron's own Node via `utilityProcess.fork`).

This is a major release: it replaces the entire app shell and updater. The new
installers carry a new app identity (`app.gtmgrid.desktop`) and a new update feed
(electron-updater `latest*.yml` replacing the Tauri `latest.json`), so **existing
Tauri installs do not auto-update across to Electron — a fresh install is required.**

Highlights:
- The Rust↔Node sidecar boundary (the source of most Windows bugs — the `\\?\`
  path crash, console-less spawn failures, the NSIS "file in use" update lock) is
  gone; the engine is Electron's own Node.
- First-class PostHog observability: the key is baked at build time as plain JS (no
  more cargo-cache defeating `option_env!`), and `sidecar_listening`,
  `agent_turn_completed` (with `mcp_connected`/`gtmgrid_tools`/`cwd`), `mcp_started`
  and `$ai_generation` LLM traces all deliver server-side.
- The agent working directory is now a stable, user-writable `~/.gtmgrid/workspace`
  (passed as `GTMGRID_AGENT_CWD`), fixing the Windows "agent ran out of a random
  repo" + broken-Resume bug.
- Electron main-process logic is structured as composable Effect services
  (Engine / Updater / Observability).
- Branded NSIS installer, green brand tray icon, and an `app://gtmgrid` renderer
  origin (allow-listed for cloud auth/tRPC CORS, with legacy Tauri origins kept for
  the cut-over).
