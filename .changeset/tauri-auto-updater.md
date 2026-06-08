---
"@gtmgrid/desktop": patch
---

Full in-app auto-updater (Tauri `plugin-updater`). The desktop app checks for a
newer SIGNED release on launch and offers "Update & restart" — it downloads,
installs, and relaunches in-app (no manual re-download). Updates are verified
against a public key baked into the app, signed in CI with `TAURI_SIGNING_PRIVATE_KEY`;
the release publishes `latest.json` + per-bundle signatures. macOS + Windows are
auto-updatable; Linux `.deb` updates via apt as before (no banner there).
