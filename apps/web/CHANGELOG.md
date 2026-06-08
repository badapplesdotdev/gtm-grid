# @gtmgrid/web

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
