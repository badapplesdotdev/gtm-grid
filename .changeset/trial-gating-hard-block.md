---
"@gtmgrid/services": minor
"@gtmgrid/desktop": minor
"@gtmgrid/email": minor
"@gtmgrid/web": minor
"@gtmgrid/server": patch
---

Hard-block credited actions when a trial expires, plus trial-status notifications.

Previously `EntitlementService.requireCloudAccess` only checked the cached
`currentPlanId`, so a trial that lapsed by date kept running credited actions until
Autumn's webhook/desktop sync flipped the plan to null. And the credit-heavy column
enrichment run path was gated by quota only, never by cloud access.

- **Time-based backstop:** `requireCloudAccess` now also fails the instant
  `trialEndsAt` is in the past, regardless of the cached plan id — the server-side
  guarantee that an expired trial cannot run any credited action.
- **Enrichment path gated:** `assertColumnRunQuota` and the `setCell` / `setCellStatus`
  / `insertRow` / `upsertRow` worker writes now call `requireCloudAccess`, so a lapsed
  workspace cannot complete runs server-side even with quota headroom. The worker
  boundary maps `PlanRequiredError` → 403 (distinct from the 402 quota error) and the
  sidecar re-raises it as a typed error so the run aborts cleanly with an upgrade prompt.
- **Expired stays distinguishable:** the plan sync preserves a lapsed trial's past
  `trialEndsAt` so "trial expired" reads apart from a cancelled paid plan / Free.
- **Desktop locks by date too:** the cloud UI now locks the instant the trial expires
  (not only after sync), closing the window where buttons looked enabled but the server
  rejected the action.
- **Notifications along the way:** new bell items for trial started (welcome), trial
  expired, and low cloud-actions — alongside the existing countdown — all routing to the
  upgrade flow. New on-brand `trialWelcomeEmail` (on workspace creation) and
  `trialExpiredEmail` (daily "just-ended" reminder window) reuse the existing email shell.
