# @gtmgrid/desktop

## 0.3.4

### Patch Changes

- 63629aa: New-signup onboarding: auto-enrol every new workspace in a 7-day, no-card **Team
  free trial** so owners can invite teammates from day one (least-friction), and
  auto-enrol invited users instead of prompting them to create their own workspace.

  - `createWorkspace` now starts a Team trial in Autumn (`SeatsService.startTrial` →
    `attach` with `customize.freeTrial` (7 days, `cardRequired: false`) + a prepaid
    seat grant, since the Team plan's seats are prepaid). Best-effort: a billing
    hiccup never blocks workspace creation. When the trial lapses with no card, the
    workspace returns to Free and inviting then requires an upgrade.
  - The plan badge reflects the trial (trialing subscriptions count as active in
    `getActivePlanIds`).
  - Desktop: a fresh signup with a pending (email-matched) invite is auto-enrolled
    into that workspace instead of being shown the create-workspace wizard; accepting
    an invite now also refetches `me` so the joined workspace appears immediately.

  Verified end-to-end against the dev Autumn sandbox + local Postgres (trial attach,
  seat availability, plan sync, invite-during-trial, and invite→signup→auto-enrol).

  Also gates the cloud tier on entitlement: when the trial lapses (no card) the
  workspace falls back to Free and cloud tables/projects, realtime and shared
  credentials LOCK (server-enforced via `EntitlementService.requireCloudAccess` on
  the grid service + a `cloudWorkspaceProcedure`). The desktop shows cloud tables as
  locked with an "Upgrade to unlock cloud" prompt (reusing the Autumn checkout);
  listing stays available so names render, and local tables are unaffected.

- Updated dependencies [63629aa]
  - @gtmgrid/cloud@0.3.4
  - @gtmgrid/services@0.3.4

## 0.3.3

### Patch Changes

- d8affce: Fix two cloud-state staleness bugs:

  - **Sign-up via the sidebar left the app "signed out".** The `me` query (user +
    workspaces + plan) was cached as `null` while signed out and never refetched
    when a bearer token appeared, so the UI stayed unauthenticated after an in-app
    sign-up/sign-in. React-query is now invalidated whenever the Better Auth session
    identity changes, so `me` refetches and the app reflects the new session.

  - **Plan upgrades weren't reflected.** `me` read the plan from a cached
    `currentPlanId` column that was NEVER written — so the plan was stuck at "Free"
    even after an in-app checkout or a manual upgrade in Autumn. Added
    `BillingService.syncPlan` / `billing.syncPlan` which reconciles the cached plan
    with the live Autumn subscription (writing `currentPlanId` back), and the desktop
    calls it on app load, on window focus, and when the billing panel opens. `me`
    also now refetches on window focus so external changes surface without a restart.

- c5a0d49: Fix blank screen on local-only builds with no cloud env vars. `App` always calls
  react-query hooks (`useMe`, etc.), but `CloudProvider` only mounted the
  `QueryClientProvider` when `VITE_API_URL` was set — so a no-env build threw
  "No QueryClient set" during render and white-screened the whole app (the exact
  state OSS users hit). The provider is now mounted unconditionally (it makes zero
  network calls in local mode), and a top-level error boundary keeps the window
  non-blank if any future render error occurs.
- Updated dependencies [d8affce]
  - @gtmgrid/services@0.3.3
  - @gtmgrid/cloud@0.3.3

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
