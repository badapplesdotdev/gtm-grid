---
"@gtmgrid/desktop": patch
---

Windows agents: forward the OS environment to the spawned GTM Grid MCP server so it
can start, and capture the exact reason when it can't.

Telemetry showed the MCP server process never starts on Windows (so the agent's tool
set has no `gtmgrid` tools and it falls back to shell/other skills), while macOS works
and the agent working directory is correct. The agent CLI hands the MCP child an
explicit env map; on Windows the Electron-as-Node child needs the OS vars
(`SystemRoot`, `PATH`, …) to even launch. We now forward those. Agent telemetry also
records the MCP server's raw status + stderr on any turn where it fails to connect, so
the precise failure is visible if more work is needed.
