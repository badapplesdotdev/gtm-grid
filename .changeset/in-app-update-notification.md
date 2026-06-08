---
"@gtmgrid/desktop": patch
---

In-app update notifications: the desktop app checks the latest GitHub release on
launch + window focus and, when a newer version is available, shows an "update
available" banner linking to the download page. Tauri-only; version comparison is
a pure, unit-tested helper. (First increment of the update system — the
download-and-install-in-app step via the Tauri updater plugin is a follow-up that
needs an updater signing keypair.)
