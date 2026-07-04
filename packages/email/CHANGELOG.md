# @gtmgrid/email

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.1

## 1.1.0

### Minor Changes

- 3e33da9: Hard-block credited actions when a trial expires, plus trial-status notifications.

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

## 1.0.6

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

## 0.22.12

## 0.22.11

## 0.22.10

## 0.22.9

## 0.22.8

## 0.22.7

## 0.22.6

## 0.22.5

## 0.22.4

## 0.22.3

## 0.22.2

## 0.22.1

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.1

## 0.19.0

## 0.18.0

## 0.17.4

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.2

## 0.16.1

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.24

## 0.9.23

## 0.9.22

## 0.9.21

## 0.9.20

## 0.9.19

## 0.9.18

## 0.9.17

## 0.9.16

## 0.9.15

## 0.9.14

## 0.9.13

## 0.9.12

## 0.9.11

## 0.9.10

## 0.9.9

## 0.9.8

## 0.9.7

## 0.9.6

## 0.9.5

## 0.9.4

## 0.9.3

## 0.9.2

## 0.9.1

## 0.9.0

## 0.8.0

## 0.7.8

## 0.7.7

## 0.7.6

## 0.7.5

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.1

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

## 0.3.14

## 0.3.13

## 0.3.12

## 0.3.11

## 0.3.10

## 0.3.9

## 0.3.8

## 0.3.7

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0
