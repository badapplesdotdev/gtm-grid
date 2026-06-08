---
"@gtmgrid/desktop": patch
"@gtmgrid/web": patch
"@gtmgrid/services": patch
---

Fix two cloud-state staleness bugs:

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
