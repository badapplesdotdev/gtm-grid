---
"@gtmgrid/desktop": patch
---

Sync UX feedback fixes (TRI-3313 + TRI-3314).

- **One unified table list** — the separate "Tables (cloud)" and "Tables" sidebar sections are merged into a single list with per-table cloud-sync status icons and a single selection (no more one-local-plus-one-cloud dual selection leaving the grid bound to the wrong table).
- **Local tables viewable from cloud env** — selecting a local table while in a cloud project now renders it (and its sync options) instead of a dead panel.
- **Push works from the local env** — pushing a local table to your cloud workspace no longer fails with "not found" when triggered outside the cloud project context.
- **Environment switcher in the account menu** — the bottom account bar now shows the current environment (cloud project / local) with one-click "Switch to cloud/local" and "Switch project".
- **Popover fixes** — the notification popover and the sync popover are no longer clipped by the sidebar; the push button is always fully visible.
