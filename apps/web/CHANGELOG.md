# @gtmgrid/web

## 1.5.2

### Patch Changes

- @gtmgrid/analytics@1.5.2
- @gtmgrid/auth@1.5.2
- @gtmgrid/cloud@1.5.2
- @gtmgrid/db@1.5.2
- @gtmgrid/email@1.5.2
- @gtmgrid/engine@1.5.2
- @gtmgrid/services@1.5.2

## 1.5.1

### Patch Changes

- @gtmgrid/analytics@1.5.1
- @gtmgrid/auth@1.5.1
- @gtmgrid/cloud@1.5.1
- @gtmgrid/db@1.5.1
- @gtmgrid/email@1.5.1
- @gtmgrid/engine@1.5.1
- @gtmgrid/services@1.5.1

## 1.5.0

### Patch Changes

- @gtmgrid/analytics@1.5.0
- @gtmgrid/auth@1.5.0
- @gtmgrid/cloud@1.5.0
- @gtmgrid/db@1.5.0
- @gtmgrid/email@1.5.0
- @gtmgrid/engine@1.5.0
- @gtmgrid/services@1.5.0

## 1.4.0

### Patch Changes

- @gtmgrid/analytics@1.4.0
- @gtmgrid/auth@1.4.0
- @gtmgrid/cloud@1.4.0
- @gtmgrid/db@1.4.0
- @gtmgrid/email@1.4.0
- @gtmgrid/engine@1.4.0
- @gtmgrid/services@1.4.0

## 1.3.0

### Patch Changes

- @gtmgrid/analytics@1.3.0
- @gtmgrid/auth@1.3.0
- @gtmgrid/cloud@1.3.0
- @gtmgrid/db@1.3.0
- @gtmgrid/email@1.3.0
- @gtmgrid/engine@1.3.0
- @gtmgrid/services@1.3.0

## 1.2.1

### Patch Changes

- Updated dependencies [5c11bbe]
  - @gtmgrid/engine@1.2.1
  - @gtmgrid/analytics@1.2.1
  - @gtmgrid/auth@1.2.1
  - @gtmgrid/cloud@1.2.1
  - @gtmgrid/db@1.2.1
  - @gtmgrid/email@1.2.1
  - @gtmgrid/services@1.2.1

## 1.2.0

### Patch Changes

- @gtmgrid/analytics@1.2.0
- @gtmgrid/auth@1.2.0
- @gtmgrid/cloud@1.2.0
- @gtmgrid/db@1.2.0
- @gtmgrid/email@1.2.0
- @gtmgrid/engine@1.2.0
- @gtmgrid/services@1.2.0

## 1.1.1

### Patch Changes

- @gtmgrid/analytics@1.1.1
- @gtmgrid/auth@1.1.1
- @gtmgrid/cloud@1.1.1
- @gtmgrid/db@1.1.1
- @gtmgrid/email@1.1.1
- @gtmgrid/engine@1.1.1
- @gtmgrid/services@1.1.1

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

### Patch Changes

- Updated dependencies [3e33da9]
  - @gtmgrid/services@1.1.0
  - @gtmgrid/email@1.1.0
  - @gtmgrid/auth@1.1.0
  - @gtmgrid/analytics@1.1.0
  - @gtmgrid/cloud@1.1.0
  - @gtmgrid/db@1.1.0
  - @gtmgrid/engine@1.1.0

## 1.0.6

### Patch Changes

- @gtmgrid/analytics@1.0.6
- @gtmgrid/auth@1.0.6
- @gtmgrid/cloud@1.0.6
- @gtmgrid/db@1.0.6
- @gtmgrid/email@1.0.6
- @gtmgrid/engine@1.0.6
- @gtmgrid/services@1.0.6

## 1.0.5

### Patch Changes

- @gtmgrid/analytics@1.0.5
- @gtmgrid/auth@1.0.5
- @gtmgrid/cloud@1.0.5
- @gtmgrid/db@1.0.5
- @gtmgrid/email@1.0.5
- @gtmgrid/engine@1.0.5
- @gtmgrid/services@1.0.5

## 1.0.4

### Patch Changes

- @gtmgrid/analytics@1.0.4
- @gtmgrid/auth@1.0.4
- @gtmgrid/cloud@1.0.4
- @gtmgrid/db@1.0.4
- @gtmgrid/email@1.0.4
- @gtmgrid/engine@1.0.4
- @gtmgrid/services@1.0.4

## 1.0.3

### Patch Changes

- @gtmgrid/analytics@1.0.3
- @gtmgrid/auth@1.0.3
- @gtmgrid/cloud@1.0.3
- @gtmgrid/db@1.0.3
- @gtmgrid/email@1.0.3
- @gtmgrid/engine@1.0.3
- @gtmgrid/services@1.0.3

## 1.0.2

### Patch Changes

- @gtmgrid/analytics@1.0.2
- @gtmgrid/auth@1.0.2
- @gtmgrid/cloud@1.0.2
- @gtmgrid/db@1.0.2
- @gtmgrid/email@1.0.2
- @gtmgrid/engine@1.0.2
- @gtmgrid/services@1.0.2

## 1.0.1

### Patch Changes

- @gtmgrid/analytics@1.0.1
- @gtmgrid/auth@1.0.1
- @gtmgrid/cloud@1.0.1
- @gtmgrid/db@1.0.1
- @gtmgrid/email@1.0.1
- @gtmgrid/engine@1.0.1
- @gtmgrid/services@1.0.1

## 1.0.0

### Patch Changes

- @gtmgrid/analytics@1.0.0
- @gtmgrid/auth@1.0.0
- @gtmgrid/cloud@1.0.0
- @gtmgrid/db@1.0.0
- @gtmgrid/email@1.0.0
- @gtmgrid/engine@1.0.0
- @gtmgrid/services@1.0.0

## 0.22.12

### Patch Changes

- @gtmgrid/analytics@0.22.12
- @gtmgrid/auth@0.22.12
- @gtmgrid/cloud@0.22.12
- @gtmgrid/db@0.22.12
- @gtmgrid/email@0.22.12
- @gtmgrid/engine@0.22.12
- @gtmgrid/services@0.22.12

## 0.22.11

### Patch Changes

- @gtmgrid/analytics@0.22.11
- @gtmgrid/auth@0.22.11
- @gtmgrid/cloud@0.22.11
- @gtmgrid/db@0.22.11
- @gtmgrid/email@0.22.11
- @gtmgrid/engine@0.22.11
- @gtmgrid/services@0.22.11

## 0.22.10

### Patch Changes

- @gtmgrid/analytics@0.22.10
- @gtmgrid/auth@0.22.10
- @gtmgrid/cloud@0.22.10
- @gtmgrid/db@0.22.10
- @gtmgrid/email@0.22.10
- @gtmgrid/engine@0.22.10
- @gtmgrid/services@0.22.10

## 0.22.9

### Patch Changes

- @gtmgrid/analytics@0.22.9
- @gtmgrid/auth@0.22.9
- @gtmgrid/cloud@0.22.9
- @gtmgrid/db@0.22.9
- @gtmgrid/email@0.22.9
- @gtmgrid/engine@0.22.9
- @gtmgrid/services@0.22.9

## 0.22.8

### Patch Changes

- @gtmgrid/analytics@0.22.8
- @gtmgrid/auth@0.22.8
- @gtmgrid/cloud@0.22.8
- @gtmgrid/db@0.22.8
- @gtmgrid/email@0.22.8
- @gtmgrid/engine@0.22.8
- @gtmgrid/services@0.22.8

## 0.22.7

### Patch Changes

- @gtmgrid/analytics@0.22.7
- @gtmgrid/auth@0.22.7
- @gtmgrid/cloud@0.22.7
- @gtmgrid/db@0.22.7
- @gtmgrid/email@0.22.7
- @gtmgrid/engine@0.22.7
- @gtmgrid/services@0.22.7

## 0.22.6

### Patch Changes

- @gtmgrid/analytics@0.22.6
- @gtmgrid/auth@0.22.6
- @gtmgrid/cloud@0.22.6
- @gtmgrid/db@0.22.6
- @gtmgrid/email@0.22.6
- @gtmgrid/engine@0.22.6
- @gtmgrid/services@0.22.6

## 0.22.5

### Patch Changes

- @gtmgrid/analytics@0.22.5
- @gtmgrid/auth@0.22.5
- @gtmgrid/cloud@0.22.5
- @gtmgrid/db@0.22.5
- @gtmgrid/email@0.22.5
- @gtmgrid/engine@0.22.5
- @gtmgrid/services@0.22.5

## 0.22.4

### Patch Changes

- @gtmgrid/analytics@0.22.4
- @gtmgrid/auth@0.22.4
- @gtmgrid/cloud@0.22.4
- @gtmgrid/db@0.22.4
- @gtmgrid/email@0.22.4
- @gtmgrid/engine@0.22.4
- @gtmgrid/services@0.22.4

## 0.22.3

### Patch Changes

- Updated dependencies [fbcb535]
  - @gtmgrid/analytics@0.22.3
  - @gtmgrid/auth@0.22.3
  - @gtmgrid/cloud@0.22.3
  - @gtmgrid/db@0.22.3
  - @gtmgrid/email@0.22.3
  - @gtmgrid/engine@0.22.3
  - @gtmgrid/services@0.22.3

## 0.22.2

### Patch Changes

- Updated dependencies [325e90b]
  - @gtmgrid/analytics@0.22.2
  - @gtmgrid/auth@0.22.2
  - @gtmgrid/cloud@0.22.2
  - @gtmgrid/db@0.22.2
  - @gtmgrid/email@0.22.2
  - @gtmgrid/engine@0.22.2
  - @gtmgrid/services@0.22.2

## 0.22.1

### Patch Changes

- @gtmgrid/analytics@0.22.1
- @gtmgrid/auth@0.22.1
- @gtmgrid/cloud@0.22.1
- @gtmgrid/db@0.22.1
- @gtmgrid/email@0.22.1
- @gtmgrid/engine@0.22.1
- @gtmgrid/services@0.22.1

## 0.22.0

### Minor Changes

- 8951841: Redesigned the marketing homepage as "Grid — the headless GTM engine": a new headless-engine hero with a live Founders grid beside a Claude Code agent panel, a Surfaces section, a connector wall over the real catalog, quick-start tabs, monthly/annual cloud pricing, and refreshed FAQ/CTA/footer. Server-rendered (prerendered, hourly revalidate) with real release and connector data.

### Patch Changes

- @gtmgrid/analytics@0.22.0
- @gtmgrid/auth@0.22.0
- @gtmgrid/cloud@0.22.0
- @gtmgrid/db@0.22.0
- @gtmgrid/email@0.22.0
- @gtmgrid/engine@0.22.0
- @gtmgrid/services@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [ea53611]
  - @gtmgrid/engine@0.21.0
  - @gtmgrid/analytics@0.21.0
  - @gtmgrid/auth@0.21.0
  - @gtmgrid/cloud@0.21.0
  - @gtmgrid/db@0.21.0
  - @gtmgrid/email@0.21.0
  - @gtmgrid/services@0.21.0

## 0.20.1

### Patch Changes

- @gtmgrid/analytics@0.20.1
- @gtmgrid/auth@0.20.1
- @gtmgrid/cloud@0.20.1
- @gtmgrid/db@0.20.1
- @gtmgrid/email@0.20.1
- @gtmgrid/engine@0.20.1
- @gtmgrid/services@0.20.1

## 0.20.0

### Patch Changes

- @gtmgrid/analytics@0.20.0
- @gtmgrid/auth@0.20.0
- @gtmgrid/cloud@0.20.0
- @gtmgrid/db@0.20.0
- @gtmgrid/email@0.20.0
- @gtmgrid/engine@0.20.0
- @gtmgrid/services@0.20.0

## 0.19.1

### Patch Changes

- @gtmgrid/analytics@0.19.1
- @gtmgrid/auth@0.19.1
- @gtmgrid/cloud@0.19.1
- @gtmgrid/db@0.19.1
- @gtmgrid/email@0.19.1
- @gtmgrid/engine@0.19.1
- @gtmgrid/services@0.19.1

## 0.19.0

### Patch Changes

- @gtmgrid/analytics@0.19.0
- @gtmgrid/auth@0.19.0
- @gtmgrid/cloud@0.19.0
- @gtmgrid/db@0.19.0
- @gtmgrid/email@0.19.0
- @gtmgrid/engine@0.19.0
- @gtmgrid/services@0.19.0

## 0.18.0

### Patch Changes

- @gtmgrid/analytics@0.18.0
- @gtmgrid/auth@0.18.0
- @gtmgrid/cloud@0.18.0
- @gtmgrid/db@0.18.0
- @gtmgrid/email@0.18.0
- @gtmgrid/engine@0.18.0
- @gtmgrid/services@0.18.0

## 0.17.4

### Patch Changes

- @gtmgrid/analytics@0.17.4
- @gtmgrid/auth@0.17.4
- @gtmgrid/cloud@0.17.4
- @gtmgrid/db@0.17.4
- @gtmgrid/email@0.17.4
- @gtmgrid/engine@0.17.4
- @gtmgrid/services@0.17.4

## 0.17.3

### Patch Changes

- @gtmgrid/analytics@0.17.3
- @gtmgrid/auth@0.17.3
- @gtmgrid/cloud@0.17.3
- @gtmgrid/db@0.17.3
- @gtmgrid/email@0.17.3
- @gtmgrid/engine@0.17.3
- @gtmgrid/services@0.17.3

## 0.17.2

### Patch Changes

- @gtmgrid/analytics@0.17.2
- @gtmgrid/auth@0.17.2
- @gtmgrid/cloud@0.17.2
- @gtmgrid/db@0.17.2
- @gtmgrid/email@0.17.2
- @gtmgrid/engine@0.17.2
- @gtmgrid/services@0.17.2

## 0.17.1

### Patch Changes

- @gtmgrid/analytics@0.17.1
- @gtmgrid/auth@0.17.1
- @gtmgrid/cloud@0.17.1
- @gtmgrid/db@0.17.1
- @gtmgrid/email@0.17.1
- @gtmgrid/engine@0.17.1
- @gtmgrid/services@0.17.1

## 0.17.0

### Minor Changes

- b2fbbee: Remove the "local" paradigm — Postgres is now the only source of truth.

  GTM Grid was built local-first: each project was a `better-sqlite3` `.db` file served by the desktop sidecar, with cloud (Postgres) as an optional team tier. That produced two parallel data worlds and pervasive local-vs-cloud branching. This change removes the local paradigm entirely:
  - **Single data path.** The execution engine is always cloud-store-backed (`new Engine(config, registry, { store, creds })`); the SQLite `GridStore` layers, the engine's grid tables, the desktop's local `DataGrid`/`inCloud` fork, and the sidecar's local grid CRUD routes are gone. Every grid table operation goes through Postgres via tRPC. The one-way local→cloud push/sync apparatus and the `@gtmgrid/cli` package are deleted.
  - **The sidecar stays as the execution host.** It still runs connector/AI/formula columns locally and keeps a small **secrets-only** local vault (encrypted connector/AI keys, extension manifests) — but it no longer owns grid data; it proxies grid I/O to the `apps/web` worker endpoints. A new `/api/cloud/preview-function` route powers "Try on N rows" against cloud data.
  - **Login required.** `VITE_API_URL` is now mandatory (the build fails fast without it); the cloud/auth layer is always on; the "Continue locally — no account" escape hatches are removed; signed-out users hit a hard auth gate. Self-hosting = run your own Postgres + `apps/web`.
  - **Optimistic UI on every mutation.** To keep the local-first _feel_, every cloud grid mutation now patches the React Query cache instantly and reconciles with the server. Inserts carry a client-supplied UUID so the optimistic id is the persisted id and the realtime self-echo converges idempotently instead of duplicating; failures roll back.

  Note: the sidecar's local Trigify "signals" routes were local-grid-backed and have been removed pending a cloud-backed replacement (recurring signal refresh already runs as an Inngest cloud job).

### Patch Changes

- Updated dependencies [b2fbbee]
  - @gtmgrid/services@0.17.0
  - @gtmgrid/engine@0.17.0
  - @gtmgrid/analytics@0.17.0
  - @gtmgrid/auth@0.17.0
  - @gtmgrid/cloud@0.17.0
  - @gtmgrid/db@0.17.0
  - @gtmgrid/email@0.17.0

## 0.16.2

### Patch Changes

- Updated dependencies [c297b2a]
  - @gtmgrid/services@0.16.2
  - @gtmgrid/analytics@0.16.2
  - @gtmgrid/auth@0.16.2
  - @gtmgrid/cloud@0.16.2
  - @gtmgrid/db@0.16.2
  - @gtmgrid/email@0.16.2
  - @gtmgrid/engine@0.16.2

## 0.16.1

### Patch Changes

- Updated dependencies [a9ba3ac]
  - @gtmgrid/services@0.16.1
  - @gtmgrid/analytics@0.16.1
  - @gtmgrid/auth@0.16.1
  - @gtmgrid/cloud@0.16.1
  - @gtmgrid/db@0.16.1
  - @gtmgrid/email@0.16.1
  - @gtmgrid/engine@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [735d94c]
  - @gtmgrid/engine@0.16.0
  - @gtmgrid/services@0.16.0
  - @gtmgrid/analytics@0.16.0
  - @gtmgrid/auth@0.16.0
  - @gtmgrid/cloud@0.16.0
  - @gtmgrid/db@0.16.0
  - @gtmgrid/email@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f414614]
  - @gtmgrid/engine@0.15.0
  - @gtmgrid/services@0.15.0
  - @gtmgrid/analytics@0.15.0
  - @gtmgrid/auth@0.15.0
  - @gtmgrid/cloud@0.15.0
  - @gtmgrid/db@0.15.0
  - @gtmgrid/email@0.15.0

## 0.14.0

### Minor Changes

- 651e34b: Cloud tables now support rename and pin-to-favourites in the sidebar, matching local tables. Renames persist via a new `grid.renameTable` mutation and broadcast `table.rename` so every member's sidebar and the open grid relabel live. Favourites are workspace-shared (a `favorite` column on the table row): any member's pin is visible to the whole workspace, sorts favourites to the top, and broadcasts `table.favorite` so sidebars restyle and reorder in real time.

### Patch Changes

- @gtmgrid/analytics@0.14.0
- @gtmgrid/auth@0.14.0
- @gtmgrid/cloud@0.14.0
- @gtmgrid/db@0.14.0
- @gtmgrid/email@0.14.0
- @gtmgrid/engine@0.14.0
- @gtmgrid/services@0.14.0

## 0.13.0

### Patch Changes

- @gtmgrid/analytics@0.13.0
- @gtmgrid/auth@0.13.0
- @gtmgrid/cloud@0.13.0
- @gtmgrid/db@0.13.0
- @gtmgrid/email@0.13.0
- @gtmgrid/engine@0.13.0
- @gtmgrid/services@0.13.0

## 0.12.0

### Patch Changes

- @gtmgrid/analytics@0.12.0
- @gtmgrid/auth@0.12.0
- @gtmgrid/cloud@0.12.0
- @gtmgrid/db@0.12.0
- @gtmgrid/email@0.12.0
- @gtmgrid/engine@0.12.0
- @gtmgrid/services@0.12.0

## 0.11.1

### Patch Changes

- @gtmgrid/analytics@0.11.1
- @gtmgrid/auth@0.11.1
- @gtmgrid/cloud@0.11.1
- @gtmgrid/db@0.11.1
- @gtmgrid/email@0.11.1
- @gtmgrid/engine@0.11.1
- @gtmgrid/services@0.11.1

## 0.11.0

### Patch Changes

- @gtmgrid/analytics@0.11.0
- @gtmgrid/auth@0.11.0
- @gtmgrid/cloud@0.11.0
- @gtmgrid/db@0.11.0
- @gtmgrid/email@0.11.0
- @gtmgrid/engine@0.11.0
- @gtmgrid/services@0.11.0

## 0.10.0

### Patch Changes

- @gtmgrid/analytics@0.10.0
- @gtmgrid/auth@0.10.0
- @gtmgrid/cloud@0.10.0
- @gtmgrid/db@0.10.0
- @gtmgrid/email@0.10.0
- @gtmgrid/engine@0.10.0
- @gtmgrid/services@0.10.0

## 0.9.24

### Patch Changes

- @gtmgrid/auth@0.9.24
- @gtmgrid/cloud@0.9.24
- @gtmgrid/db@0.9.24
- @gtmgrid/email@0.9.24
- @gtmgrid/engine@0.9.24
- @gtmgrid/services@0.9.24

## 0.9.23

### Patch Changes

- Updated dependencies [7c050a2]
  - @gtmgrid/engine@0.9.23
  - @gtmgrid/auth@0.9.23
  - @gtmgrid/cloud@0.9.23
  - @gtmgrid/db@0.9.23
  - @gtmgrid/email@0.9.23
  - @gtmgrid/services@0.9.23

## 0.9.22

### Patch Changes

- Updated dependencies [d2a41c5]
  - @gtmgrid/services@0.9.22
  - @gtmgrid/auth@0.9.22
  - @gtmgrid/cloud@0.9.22
  - @gtmgrid/db@0.9.22
  - @gtmgrid/email@0.9.22
  - @gtmgrid/engine@0.9.22

## 0.9.21

### Patch Changes

- @gtmgrid/auth@0.9.21
- @gtmgrid/cloud@0.9.21
- @gtmgrid/db@0.9.21
- @gtmgrid/email@0.9.21
- @gtmgrid/engine@0.9.21
- @gtmgrid/services@0.9.21

## 0.9.20

### Patch Changes

- @gtmgrid/auth@0.9.20
- @gtmgrid/cloud@0.9.20
- @gtmgrid/db@0.9.20
- @gtmgrid/email@0.9.20
- @gtmgrid/engine@0.9.20
- @gtmgrid/services@0.9.20

## 0.9.19

### Patch Changes

- @gtmgrid/auth@0.9.19
- @gtmgrid/cloud@0.9.19
- @gtmgrid/db@0.9.19
- @gtmgrid/email@0.9.19
- @gtmgrid/engine@0.9.19
- @gtmgrid/services@0.9.19

## 0.9.18

### Patch Changes

- @gtmgrid/auth@0.9.18
- @gtmgrid/cloud@0.9.18
- @gtmgrid/db@0.9.18
- @gtmgrid/email@0.9.18
- @gtmgrid/engine@0.9.18
- @gtmgrid/services@0.9.18

## 0.9.17

### Patch Changes

- @gtmgrid/auth@0.9.17
- @gtmgrid/cloud@0.9.17
- @gtmgrid/db@0.9.17
- @gtmgrid/email@0.9.17
- @gtmgrid/engine@0.9.17
- @gtmgrid/services@0.9.17

## 0.9.16

### Patch Changes

- Updated dependencies [9f01681]
  - @gtmgrid/services@0.9.16
  - @gtmgrid/auth@0.9.16
  - @gtmgrid/cloud@0.9.16
  - @gtmgrid/db@0.9.16
  - @gtmgrid/email@0.9.16
  - @gtmgrid/engine@0.9.16

## 0.9.15

### Patch Changes

- Updated dependencies [be203b9]
  - @gtmgrid/services@0.9.15
  - @gtmgrid/auth@0.9.15
  - @gtmgrid/cloud@0.9.15
  - @gtmgrid/db@0.9.15
  - @gtmgrid/email@0.9.15
  - @gtmgrid/engine@0.9.15

## 0.9.14

### Patch Changes

- Updated dependencies [7eda629]
- Updated dependencies [c7bd3fc]
- Updated dependencies [17ea929]
  - @gtmgrid/services@0.9.14
  - @gtmgrid/engine@0.9.14
  - @gtmgrid/db@0.9.14
  - @gtmgrid/auth@0.9.14
  - @gtmgrid/cloud@0.9.14
  - @gtmgrid/email@0.9.14

## 0.9.13

### Patch Changes

- Updated dependencies [891e3b8]
  - @gtmgrid/services@0.9.13
  - @gtmgrid/auth@0.9.13
  - @gtmgrid/cloud@0.9.13
  - @gtmgrid/db@0.9.13
  - @gtmgrid/email@0.9.13
  - @gtmgrid/engine@0.9.13

## 0.9.12

### Patch Changes

- Updated dependencies [9bf183f]
  - @gtmgrid/services@0.9.12
  - @gtmgrid/auth@0.9.12
  - @gtmgrid/cloud@0.9.12
  - @gtmgrid/db@0.9.12
  - @gtmgrid/email@0.9.12
  - @gtmgrid/engine@0.9.12

## 0.9.11

### Patch Changes

- Updated dependencies [2ddf117]
  - @gtmgrid/services@0.9.11
  - @gtmgrid/auth@0.9.11
  - @gtmgrid/cloud@0.9.11
  - @gtmgrid/db@0.9.11
  - @gtmgrid/email@0.9.11
  - @gtmgrid/engine@0.9.11

## 0.9.10

### Patch Changes

- e63ab22: Fix `process-webhook-record` (and any worker self-call) failing with
  "SITE_URL is not configured" on deployments without the manual env var: the
  worker base URL now falls back to the Vercel-injected deployment host
  (`VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`) when `SITE_URL` is
  unset. An explicit `SITE_URL` still wins; off-Vercel with nothing set still
  fails closed.
  - @gtmgrid/auth@0.9.10
  - @gtmgrid/cloud@0.9.10
  - @gtmgrid/db@0.9.10
  - @gtmgrid/email@0.9.10
  - @gtmgrid/engine@0.9.10
  - @gtmgrid/services@0.9.10

## 0.9.9

### Patch Changes

- Updated dependencies [67f3d44]
  - @gtmgrid/services@0.9.9
  - @gtmgrid/auth@0.9.9
  - @gtmgrid/cloud@0.9.9
  - @gtmgrid/db@0.9.9
  - @gtmgrid/email@0.9.9
  - @gtmgrid/engine@0.9.9

## 0.9.8

### Patch Changes

- Updated dependencies [3cbb8b2]
  - @gtmgrid/services@0.9.8
  - @gtmgrid/auth@0.9.8
  - @gtmgrid/cloud@0.9.8
  - @gtmgrid/db@0.9.8
  - @gtmgrid/email@0.9.8
  - @gtmgrid/engine@0.9.8

## 0.9.7

### Patch Changes

- @gtmgrid/auth@0.9.7
- @gtmgrid/cloud@0.9.7
- @gtmgrid/db@0.9.7
- @gtmgrid/email@0.9.7
- @gtmgrid/engine@0.9.7
- @gtmgrid/services@0.9.7

## 0.9.6

### Patch Changes

- @gtmgrid/auth@0.9.6
- @gtmgrid/cloud@0.9.6
- @gtmgrid/db@0.9.6
- @gtmgrid/email@0.9.6
- @gtmgrid/engine@0.9.6
- @gtmgrid/services@0.9.6

## 0.9.5

### Patch Changes

- @gtmgrid/auth@0.9.5
- @gtmgrid/cloud@0.9.5
- @gtmgrid/db@0.9.5
- @gtmgrid/email@0.9.5
- @gtmgrid/engine@0.9.5
- @gtmgrid/services@0.9.5

## 0.9.4

### Patch Changes

- @gtmgrid/auth@0.9.4
- @gtmgrid/cloud@0.9.4
- @gtmgrid/db@0.9.4
- @gtmgrid/email@0.9.4
- @gtmgrid/engine@0.9.4
- @gtmgrid/services@0.9.4

## 0.9.3

### Patch Changes

- @gtmgrid/auth@0.9.3
- @gtmgrid/cloud@0.9.3
- @gtmgrid/db@0.9.3
- @gtmgrid/email@0.9.3
- @gtmgrid/engine@0.9.3
- @gtmgrid/services@0.9.3

## 0.9.2

### Patch Changes

- @gtmgrid/auth@0.9.2
- @gtmgrid/cloud@0.9.2
- @gtmgrid/db@0.9.2
- @gtmgrid/email@0.9.2
- @gtmgrid/engine@0.9.2
- @gtmgrid/services@0.9.2

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
