# @gtmgrid/desktop

## 0.3.8

### Patch Changes

- dbe3bc7: Fix extension and AI-provider config panels not opening when a cloud workspace
  is selected. They were gated behind `!inCloud`, so the cloud grid always owned
  the main area and clicking a connector did nothing — and the shared "Workspace"
  credential scope (cloud key-sharing) was unreachable. The panels now render in
  both local and cloud workspaces, and the view returns to the grid on any
  cloud-table select/create.
- Updated dependencies [7f41587]
  - @gtmgrid/cloud@0.3.8
  - @gtmgrid/services@0.3.8

## 0.3.7

### Patch Changes

- 3ec43e5: In-app update notifications: the desktop app checks the latest GitHub release on
  launch + window focus and, when a newer version is available, shows an "update
  available" banner linking to the download page. Tauri-only; version comparison is
  a pure, unit-tested helper. (First increment of the update system — the
  download-and-install-in-app step via the Tauri updater plugin is a follow-up that
  needs an updater signing keypair.)
- 2fe6521: Full in-app auto-updater (Tauri `plugin-updater`). The desktop app checks for a
  newer SIGNED release on launch and offers "Update & restart" — it downloads,
  installs, and relaunches in-app (no manual re-download). Updates are verified
  against a public key baked into the app, signed in CI with `TAURI_SIGNING_PRIVATE_KEY`;
  the release publishes `latest.json` + per-bundle signatures. macOS + Windows are
  auto-updatable; Linux `.deb` updates via apt as before (no banner there).
  - @gtmgrid/cloud@0.3.7
  - @gtmgrid/services@0.3.7

## 0.3.6

### Patch Changes

- 3ee732b: A signed-in cloud workspace now always operates in cloud mode — it never falls
  back to the local engine (which silently saved tables to disk instead of the
  cloud). When the active cloud workspace has no cloud project yet, the app
  auto-creates a default cloud project so `inCloud` is true: the local-tables
  section + local "New table" stay hidden and all tables go to the cloud. Skipped
  when the workspace's cloud access is locked (lapsed trial).
- 8513552: Fix + polish the team-invite acceptance flow:

  - **Not-authed invites now guide sign-up.** A `gtmgrid://invite/<token>` deep link
    (or `?invite=` URL) is captured into a pending-invite store; while signed out it
    FORCES the sign-in/sign-up flow even if the user previously chose "continue
    locally", so an invitee is always routed to create an account and is then
    auto-enrolled. Previously the app opened in local state and never prompted.
  - **Celebrate on join** — accepting an invite (banner or new-signup auto-enrol)
    fires confetti + a confirmation dialog and refreshes app state (plan, badge,
    cloud tables) so everything is immediately in sync.

- 7d93c78: Simplify onboarding to Workspace → Team. The Plan-selection and AI-key steps are
  removed from the flow (every new workspace is auto-enrolled in the Team trial on
  creation, and the AI key can be added later); both screens are kept in code but
  unreachable. After onboarding finishes, app state is refreshed (react-query
  invalidate + Autumn plan sync) so the plan/badge/cloud tables are immediately in
  sync. Also: the root `typecheck` script now runs `apps/web`'s typecheck (it was
  skipped, which let a web-only type error merge + break the Vercel build).
- 6480d95: Refactor: read the launch invite token via lazy `useState` init instead of a
  mount `useEffect` in PendingInvites — fewer effects, more declarative.
  - @gtmgrid/cloud@0.3.6
  - @gtmgrid/services@0.3.6

## 0.3.5

### Patch Changes

- b0d6cce: Confirm the new price before an invite that adds a billable seat. New
  `billing.previewSeatChange` (backed by `AutumnClient.previewSeatChange` →
  Autumn `previewUpdate`, reading the recurring next-cycle total) returns the
  projected `{ seats, total, currency }` for the workspace's current members + 1.
  The desktop's Workspace settings invite flow now shows an "Add a seat?"
  confirmation with the new monthly price; the invite only sends on confirm.

  Also fixes the apps/web build for the trial-reminders Inngest job (the
  `send-trial-reminders` function used the wrong `createFunction` arity and apps/web
  was missing the `@gtmgrid/email` dependency — neither is caught by the root
  `tsc -b`, only by `apps/web`'s own typecheck / the Vercel build).

- 1628165: Proactively prompt users to upgrade before the 7-day trial hard-locks the cloud:

  - **In-app countdown banner**: a new `workspaces.trialEndsAt` column is synced from
    Autumn (`getActiveSubscriptions`) by `syncPlan` and seeded on trial start; `me`
    surfaces it, and the desktop shows a "Your trial ends in N days — upgrade" banner
    (escalating in the last 2 days) with the Autumn checkout CTA.
  - **Email reminders**: a daily Inngest job (`send-trial-reminders`) scans trials via
    `WorkspaceRepo.findTrialsEndingBetween` using two disjoint one-day windows
    (~2 days left, last day) so each milestone emails the owner exactly once (no
    reminder-stage column), and sends the new `trialEndingEmail` via Resend. No-op
    when email is unconfigured.

  Verified end-to-end against local Postgres + dev Autumn: trialEndsAt seeded on
  create, reconciled by syncPlan from Autumn, surfaced in me, and found by the scan.

- Updated dependencies [b0d6cce]
- Updated dependencies [1628165]
- Updated dependencies [17c88ae]
  - @gtmgrid/services@0.3.5
  - @gtmgrid/cloud@0.3.5

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
