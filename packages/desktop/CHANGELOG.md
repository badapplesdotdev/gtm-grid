# @gtmgrid/desktop

## 0.3.2

### Patch Changes

- 7e1df59: Ship Linux as `.deb` only (the AppImage bundler's upstream `linuxdeploy` download
  returns persistent 504s and failed the release), and ad-hoc sign the macOS app
  (`bundle.macOS.signingIdentity: "-"`) so first launch shows the recoverable
  "unidentified developer" prompt instead of the "app is damaged" block. The
  `/download` page now lists the `.deb` for Linux and shows a macOS first-launch note.
  - @gtmgrid/cloud@0.3.2
  - @gtmgrid/services@0.3.2

## 0.3.1

### Patch Changes

- 7c4631b: Fix desktop cloud sign-in and make local use free + unauthed.

  - **Local-first gate:** the cloud build no longer hard-blocks the app behind sign-in. The welcome screen now offers **"Continue locally — no account"** → use the app fully offline (local SQLite engine, your tables/runs) with no cloud features. Signing in (via the account bar) unlocks cloud workspaces, sync & realtime at any time.
  - **Cloud auth fix:** the packaged Tauri app calls the apps/web API cross-origin (`tauri://localhost`), which was blocked by missing CORS and broken third-party cookies ("Couldn't create your account"). Add CORS for the desktop origins, switch the desktop session to Better Auth **Bearer tokens** (persisted + replayed on auth/tRPC/sidecar calls), and trust the desktop origins.
  - @gtmgrid/cloud@0.3.1
  - @gtmgrid/services@0.3.1

## 0.3.0

### Minor Changes

- b4b82c3: Migrate the cloud tier off Convex to Supabase Postgres + Drizzle + Better Auth + tRPC, with server-gated PartyKit realtime (multiplayer). The desktop app now talks to the tRPC API + Better Auth instead of Convex; the local-first SQLite engine is unchanged. Also adds a platform-aware download experience to the marketing site.

### Patch Changes

- @gtmgrid/cloud@0.3.0
- @gtmgrid/services@0.3.0

## 0.2.0

### Minor Changes

- 6158796: Build Windows and macOS Intel installers on release. Windows builds natively
  (the Rust sidecar spawn + bundler are now node.exe-aware and skip unix-only PATH
  probing); macOS Intel is cross-compiled on the Apple-silicon runner with an
  arch-aware sidecar (x64 node + x64 better-sqlite3). Releases now cover macOS
  arm64, macOS Intel, Linux, and Windows.

### Patch Changes

- @gtmgrid/cloud@0.2.0

## 0.1.0

### Minor Changes

- ec7ff47: Add CI (typecheck, lint via oxlint, and tests) and a semantic-versioning release
  pipeline (changesets) that builds downloadable cross-platform desktop binaries
  (macOS arm64 + Intel, Linux) on each release.

### Patch Changes

- @gtmgrid/cloud@0.1.0
