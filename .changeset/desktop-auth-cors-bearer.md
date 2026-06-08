---
"@gtmgrid/desktop": patch
---

Fix desktop cloud sign-in and make local use free + unauthed.

- **Local-first gate:** the cloud build no longer hard-blocks the app behind sign-in. The welcome screen now offers **"Continue locally — no account"** → use the app fully offline (local SQLite engine, your tables/runs) with no cloud features. Signing in (via the account bar) unlocks cloud workspaces, sync & realtime at any time.
- **Cloud auth fix:** the packaged Tauri app calls the apps/web API cross-origin (`tauri://localhost`), which was blocked by missing CORS and broken third-party cookies ("Couldn't create your account"). Add CORS for the desktop origins, switch the desktop session to Better Auth **Bearer tokens** (persisted + replayed on auth/tRPC/sidecar calls), and trust the desktop origins.
