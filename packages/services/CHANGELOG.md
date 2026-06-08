# @gtmgrid/services

## 0.3.7

### Patch Changes

- @gtmgrid/cloud@0.3.7
- @gtmgrid/db@0.3.7
- @gtmgrid/email@0.3.7

## 0.3.6

### Patch Changes

- @gtmgrid/cloud@0.3.6
- @gtmgrid/db@0.3.6
- @gtmgrid/email@0.3.6

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

- 17c88ae: Gate the webhook INBOUND receiver on cloud entitlement (follow-up to the cloud
  lock). `WebhookService.resolveToken` now returns `null` for a workspace whose
  trial lapsed / is on Free (treated as not-found → the inbound route 404s), so no
  external webhook data flows into a locked workspace; `createWebhook` is likewise
  gated. Closes the one cloud-write path that bypassed the grid gate (webhook writes
  go through `WebhookService`, not `GridService`).
  - @gtmgrid/cloud@0.3.5
  - @gtmgrid/db@0.3.5
  - @gtmgrid/email@0.3.5

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
  - @gtmgrid/db@0.3.4
  - @gtmgrid/email@0.3.4

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
  - @gtmgrid/cloud@0.3.3
  - @gtmgrid/db@0.3.3
  - @gtmgrid/email@0.3.3

## 0.3.2

### Patch Changes

- @gtmgrid/cloud@0.3.2
- @gtmgrid/db@0.3.2
- @gtmgrid/email@0.3.2

## 0.3.1

### Patch Changes

- @gtmgrid/cloud@0.3.1
- @gtmgrid/db@0.3.1
- @gtmgrid/email@0.3.1

## 0.3.0

### Patch Changes

- @gtmgrid/cloud@0.3.0
- @gtmgrid/db@0.3.0
- @gtmgrid/email@0.3.0
