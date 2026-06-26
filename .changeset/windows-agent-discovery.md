---
"@gtmgrid/server": patch
---

Discover the `claude` / `codex` / `cursor` CLIs on Windows. Agent detection was
macOS/Linux-only: it located binaries via `$SHELL -lic "command -v"` (which threw
on Windows, where there is no POSIX login shell), scanned only POSIX install dirs,
and used bare binary names — so on Windows the agents always read as not installed.

`packages/server/src/agent.ts` is now cross-platform:

- **Install locations.** On Windows it scans the documented targets —
  `%USERPROFILE%\.local\bin` (native installers), `%APPDATA%\npm` (npm cmd-shims)
  and `%LOCALAPPDATA%\Microsoft\WinGet\Links` (winget) — and resolves on `PATH`
  via `where.exe`. The native-installer dir is frequently not on `PATH`, which is
  exactly why the previous lookup missed it.
- **Executable names.** It tries `.exe → .cmd → .bat`, preferring the native
  `.exe` so the resolved binary is directly spawnable.
- **`.cmd`/`.bat` shims.** Those cannot be launched by `spawn`/`execFile` without
  a shell (`EINVAL` since the CVE-2024-27980 Node patch); detection, version
  probing and every turn-run now route a shim through a shell, while a native
  `.exe` still spawns directly.
- **Packaged-app polish.** `windowsHide` is set on every child process so no
  console window flashes, and the spawn `PATH` is built with the platform
  delimiter and the existing (case-insensitive) `Path` key.

macOS/Linux discovery is byte-for-byte unchanged.
