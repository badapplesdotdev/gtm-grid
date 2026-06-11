# @gtmgrid/web

## 0.9.1

### Patch Changes

- @gtmgrid/auth@0.9.1
- @gtmgrid/cloud@0.9.1
- @gtmgrid/db@0.9.1
- @gtmgrid/email@0.9.1
- @gtmgrid/engine@0.9.1
- @gtmgrid/services@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [a6d488d]
  - @gtmgrid/services@0.9.0
  - @gtmgrid/db@0.9.0
  - @gtmgrid/auth@0.9.0
  - @gtmgrid/cloud@0.9.0
  - @gtmgrid/email@0.9.0
  - @gtmgrid/engine@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [c3eb12d]
  - @gtmgrid/services@0.8.0
  - @gtmgrid/auth@0.8.0
  - @gtmgrid/cloud@0.8.0
  - @gtmgrid/db@0.8.0
  - @gtmgrid/email@0.8.0
  - @gtmgrid/engine@0.8.0

## 0.7.8

### Patch Changes

- Updated dependencies [6ab6cf9]
  - @gtmgrid/engine@0.7.8
  - @gtmgrid/auth@0.7.8
  - @gtmgrid/cloud@0.7.8
  - @gtmgrid/db@0.7.8
  - @gtmgrid/email@0.7.8
  - @gtmgrid/services@0.7.8

## 0.7.7

### Patch Changes

- c64cbf5: Fix two desktop bugs:

  - **In-app updater / notification popover was unclickable.** The transparent
    full-viewport `.popover-scrim` (z-index 100) sat _above_ the bell notification
    popover (z-index 61), so clicking "Update & restart" (or any action) hit the
    scrim and just closed the popover instead of firing the button. Raised the
    notification popover — and the dedupe popover, which had the same z-index 50 <
    scrim bug — above the scrim.

  - **Pushing a local table to the cloud dropped function-column config.** The
    local→cloud push only sent each column's name/type (and the sidecar hardcoded
    `kind: "manual"`), so a function/formula/code column landed in the cloud as a
    plain manual column and its cells could no longer be run/enriched. The push now
    carries the full config (kind/provider/method/code/params/condition); the
    `grid.addColumn` tRPC mutation also accepts `condition` so the "only run if"
    rule survives the push.

- Updated dependencies [c64cbf5]
  - @gtmgrid/engine@0.7.7
  - @gtmgrid/auth@0.7.7
  - @gtmgrid/cloud@0.7.7
  - @gtmgrid/db@0.7.7
  - @gtmgrid/email@0.7.7
  - @gtmgrid/services@0.7.7

## 0.7.6

### Patch Changes

- @gtmgrid/auth@0.7.6
- @gtmgrid/cloud@0.7.6
- @gtmgrid/db@0.7.6
- @gtmgrid/email@0.7.6
- @gtmgrid/engine@0.7.6
- @gtmgrid/services@0.7.6

## 0.7.5

### Patch Changes

- @gtmgrid/auth@0.7.5
- @gtmgrid/cloud@0.7.5
- @gtmgrid/db@0.7.5
- @gtmgrid/email@0.7.5
- @gtmgrid/engine@0.7.5
- @gtmgrid/services@0.7.5

## 0.7.4

### Patch Changes

- @gtmgrid/auth@0.7.4
- @gtmgrid/cloud@0.7.4
- @gtmgrid/db@0.7.4
- @gtmgrid/email@0.7.4
- @gtmgrid/engine@0.7.4
- @gtmgrid/services@0.7.4

## 0.7.3

### Patch Changes

- @gtmgrid/auth@0.7.3
- @gtmgrid/cloud@0.7.3
- @gtmgrid/db@0.7.3
- @gtmgrid/email@0.7.3
- @gtmgrid/engine@0.7.3
- @gtmgrid/services@0.7.3

## 0.7.2

### Patch Changes

- @gtmgrid/auth@0.7.2
- @gtmgrid/cloud@0.7.2
- @gtmgrid/db@0.7.2
- @gtmgrid/email@0.7.2
- @gtmgrid/engine@0.7.2
- @gtmgrid/services@0.7.2

## 0.7.1

### Patch Changes

- @gtmgrid/auth@0.7.1
- @gtmgrid/cloud@0.7.1
- @gtmgrid/db@0.7.1
- @gtmgrid/email@0.7.1
- @gtmgrid/engine@0.7.1
- @gtmgrid/services@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [accf1a9]
  - @gtmgrid/engine@0.7.0
  - @gtmgrid/auth@0.7.0
  - @gtmgrid/cloud@0.7.0
  - @gtmgrid/db@0.7.0
  - @gtmgrid/email@0.7.0
  - @gtmgrid/services@0.7.0

## 0.6.1

### Patch Changes

- @gtmgrid/auth@0.6.1
- @gtmgrid/cloud@0.6.1
- @gtmgrid/db@0.6.1
- @gtmgrid/email@0.6.1
- @gtmgrid/engine@0.6.1
- @gtmgrid/services@0.6.1

## 0.6.0

### Minor Changes

- ee40d02: One shared grid for local & cloud, with clear local/cloud separation.

  - **One grid, no divergence** — the local grid and the cloud grid now render the
    same `DataGrid` component, driven by an injected controller. Cloud no longer
    silently deletes a column on header right-click and no longer has a
    stripped-down add-column; it gets the identical header context menu
    (Edit / Delete), the full add-column popover (manual types + AI / function /
    formula), add-row, and run.
  - **Clear local/cloud separation** — the sidebar shows ONE environment's tables:
    only cloud tables in a cloud project, only local tables in local mode. This
    removes the dual-selection bug where a cloud and a local table were both
    highlighted at once. The sync affordances (sync-all, per-row dots, auto-sync
    toggle/nudge, auto-push) now appear only in local mode while signed into cloud.
  - **Cloud column editing (parity)** — new `grid.updateColumn` tRPC procedure
    (`GridService.updateColumn` → `ColumnRepo.update`) broadcasts a `column.update`
    realtime event so a rename / type / function-config change reflects live across
    clients with no refetch. The shared edit-column modal now persists in cloud.
  - **Cloud AI/formula authoring** — the cloud add-column flow reuses the local
    sidecar's AI providers + formula generation (which is what runs cloud columns),
    so function / AI / formula columns can be authored in cloud too.

### Patch Changes

- Updated dependencies [ee40d02]
  - @gtmgrid/services@0.6.0
  - @gtmgrid/auth@0.6.0
  - @gtmgrid/cloud@0.6.0
  - @gtmgrid/db@0.6.0
  - @gtmgrid/email@0.6.0
  - @gtmgrid/engine@0.6.0

## 0.5.1

### Patch Changes

- @gtmgrid/auth@0.5.1
- @gtmgrid/cloud@0.5.1
- @gtmgrid/db@0.5.1
- @gtmgrid/email@0.5.1
- @gtmgrid/engine@0.5.1
- @gtmgrid/services@0.5.1

## 0.5.0

### Patch Changes

- @gtmgrid/auth@0.5.0
- @gtmgrid/cloud@0.5.0
- @gtmgrid/db@0.5.0
- @gtmgrid/email@0.5.0
- @gtmgrid/engine@0.5.0
- @gtmgrid/services@0.5.0

## 0.4.0

### Patch Changes

- @gtmgrid/auth@0.4.0
- @gtmgrid/cloud@0.4.0
- @gtmgrid/db@0.4.0
- @gtmgrid/email@0.4.0
- @gtmgrid/engine@0.4.0
- @gtmgrid/services@0.4.0

## 0.3.18

### Patch Changes

- @gtmgrid/auth@0.3.18
- @gtmgrid/cloud@0.3.18
- @gtmgrid/db@0.3.18
- @gtmgrid/email@0.3.18
- @gtmgrid/engine@0.3.18
- @gtmgrid/services@0.3.18

## 0.3.17

### Patch Changes

- @gtmgrid/auth@0.3.17
- @gtmgrid/cloud@0.3.17
- @gtmgrid/db@0.3.17
- @gtmgrid/email@0.3.17
- @gtmgrid/engine@0.3.17
- @gtmgrid/services@0.3.17

## 0.3.16

### Patch Changes

- @gtmgrid/auth@0.3.16
- @gtmgrid/cloud@0.3.16
- @gtmgrid/db@0.3.16
- @gtmgrid/email@0.3.16
- @gtmgrid/engine@0.3.16
- @gtmgrid/services@0.3.16

## 0.3.15

### Patch Changes

- @gtmgrid/auth@0.3.15
- @gtmgrid/cloud@0.3.15
- @gtmgrid/db@0.3.15
- @gtmgrid/email@0.3.15
- @gtmgrid/engine@0.3.15
- @gtmgrid/services@0.3.15

## 0.3.14

### Patch Changes

- @gtmgrid/auth@0.3.14
- @gtmgrid/cloud@0.3.14
- @gtmgrid/db@0.3.14
- @gtmgrid/email@0.3.14
- @gtmgrid/engine@0.3.14
- @gtmgrid/services@0.3.14

## 0.3.13

### Patch Changes

- @gtmgrid/auth@0.3.13
- @gtmgrid/cloud@0.3.13
- @gtmgrid/db@0.3.13
- @gtmgrid/email@0.3.13
- @gtmgrid/engine@0.3.13
- @gtmgrid/services@0.3.13

## 0.3.12

### Patch Changes

- @gtmgrid/auth@0.3.12
- @gtmgrid/cloud@0.3.12
- @gtmgrid/db@0.3.12
- @gtmgrid/email@0.3.12
- @gtmgrid/engine@0.3.12
- @gtmgrid/services@0.3.12

## 0.3.11

### Patch Changes

- @gtmgrid/auth@0.3.11
- @gtmgrid/cloud@0.3.11
- @gtmgrid/db@0.3.11
- @gtmgrid/email@0.3.11
- @gtmgrid/engine@0.3.11
- @gtmgrid/services@0.3.11

## 0.3.10

### Patch Changes

- @gtmgrid/auth@0.3.10
- @gtmgrid/cloud@0.3.10
- @gtmgrid/db@0.3.10
- @gtmgrid/email@0.3.10
- @gtmgrid/engine@0.3.10
- @gtmgrid/services@0.3.10

## 0.3.9

### Patch Changes

- @gtmgrid/auth@0.3.9
- @gtmgrid/cloud@0.3.9
- @gtmgrid/db@0.3.9
- @gtmgrid/email@0.3.9
- @gtmgrid/engine@0.3.9
- @gtmgrid/services@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies [7f41587]
  - @gtmgrid/cloud@0.3.8
  - @gtmgrid/services@0.3.8
  - @gtmgrid/auth@0.3.8
  - @gtmgrid/db@0.3.8
  - @gtmgrid/email@0.3.8
  - @gtmgrid/engine@0.3.8

## 0.3.7

### Patch Changes

- @gtmgrid/auth@0.3.7
- @gtmgrid/cloud@0.3.7
- @gtmgrid/db@0.3.7
- @gtmgrid/email@0.3.7
- @gtmgrid/engine@0.3.7
- @gtmgrid/services@0.3.7

## 0.3.6

### Patch Changes

- @gtmgrid/auth@0.3.6
- @gtmgrid/cloud@0.3.6
- @gtmgrid/db@0.3.6
- @gtmgrid/email@0.3.6
- @gtmgrid/engine@0.3.6
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
  - @gtmgrid/auth@0.3.5
  - @gtmgrid/cloud@0.3.5
  - @gtmgrid/db@0.3.5
  - @gtmgrid/email@0.3.5
  - @gtmgrid/engine@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [63629aa]
  - @gtmgrid/cloud@0.3.4
  - @gtmgrid/services@0.3.4
  - @gtmgrid/auth@0.3.4
  - @gtmgrid/db@0.3.4
  - @gtmgrid/engine@0.3.4

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

- Updated dependencies [d8affce]
  - @gtmgrid/services@0.3.3
  - @gtmgrid/auth@0.3.3
  - @gtmgrid/cloud@0.3.3
  - @gtmgrid/db@0.3.3
  - @gtmgrid/engine@0.3.3

## 0.3.2

### Patch Changes

- 7e1df59: Ship Linux as `.deb` only (the AppImage bundler's upstream `linuxdeploy` download
  returns persistent 504s and failed the release), and ad-hoc sign the macOS app
  (`bundle.macOS.signingIdentity: "-"`) so first launch shows the recoverable
  "unidentified developer" prompt instead of the "app is damaged" block. The
  `/download` page now lists the `.deb` for Linux and shows a macOS first-launch note.
  - @gtmgrid/auth@0.3.2
  - @gtmgrid/cloud@0.3.2
  - @gtmgrid/db@0.3.2
  - @gtmgrid/engine@0.3.2
  - @gtmgrid/services@0.3.2

## 0.3.1

### Patch Changes

- @gtmgrid/auth@0.3.1
- @gtmgrid/cloud@0.3.1
- @gtmgrid/db@0.3.1
- @gtmgrid/engine@0.3.1
- @gtmgrid/services@0.3.1

## 0.3.0

### Patch Changes

- @gtmgrid/auth@0.3.0
- @gtmgrid/cloud@0.3.0
- @gtmgrid/db@0.3.0
- @gtmgrid/engine@0.3.0
- @gtmgrid/services@0.3.0
