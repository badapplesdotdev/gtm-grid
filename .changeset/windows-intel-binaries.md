---
"@gtmgrid/desktop": minor
---

Build Windows and macOS Intel installers on release. Windows builds natively
(the Rust sidecar spawn + bundler are now node.exe-aware and skip unix-only PATH
probing); macOS Intel is cross-compiled on the Apple-silicon runner with an
arch-aware sidecar (x64 node + x64 better-sqlite3). Releases now cover macOS
arm64, macOS Intel, Linux, and Windows.
