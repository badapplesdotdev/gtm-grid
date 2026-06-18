# @gtmgrid/services

## 0.16.2

### Patch Changes

- c297b2a: Make realtime grid/webhook broadcasts genuinely best-effort so a publish failure can't fail an already-committed write. The `process-webhook-record` worker was 500ing on every record: after `insertRow` committed and metered the row, the PartyKit publish returned 401 and the resulting `RealtimePublisherError` propagated out and mapped to a 500 — halting ingestion and risking duplicate rows on Inngest retries (the row commits before the publish). Despite doc comments claiming the publish swallowed transport errors, nothing did. Both GridService and the webhook service now wrap their `publish` / `publishWorkspaceTablesChanged` helpers in `catchTag("RealtimePublisherError", () => Effect.void)`, so a realtime outage can never fail a grid mutation. Regression tests prove a failing publisher leaves the write committed and successful. (Live broadcasts stay down until `PARTY_PUBLISH_SECRET` is realigned across web/worker and the party deployment — an env/infra change, not code.)
  - @gtmgrid/cloud@0.16.2
  - @gtmgrid/db@0.16.2
  - @gtmgrid/email@0.16.2

## 0.16.1

### Patch Changes

- a9ba3ac: Fix the scheduled Social Signals poll cron failing on every run. `SignalService.listDuePage` built its due-filter as a parameterised `CASE` whose branches were all untyped bound params (or `NULL`), so Postgres couldn't resolve the CASE result type and the outer `last_synced_at <= CASE(...)` comparison failed at execution (`Error: Failed query`) on every hourly tick — meaning no enabled binding had been synced for any workspace. Anchor the CASE type by casting each threshold to `::bigint`. Adds a real-Postgres (in-process PGlite) test that executes `listDuePage` with mixed schedules, so this regression is caught instead of passing on the in-memory path.
  - @gtmgrid/cloud@0.16.1
  - @gtmgrid/db@0.16.1
  - @gtmgrid/email@0.16.1

## 0.16.0

### Minor Changes

- 735d94c: Full PostHog Error Tracking observability so bugs surface as they occur. All telemetry now points at the GTM Grid **US** project (`us.i.posthog.com`). New `@gtmgrid/observability` package shares one error-tracking + structured-logging convention across the sidecar, MCP server, and CLI (process-level crash handlers + exception capture).

  Closed the remaining blind spots:

  - **Engine run failures** — connector/AI/enrichment errors now feed Error Tracking via an injected, dependency-free `reportError` hook on the engine, **deduped per run** (a large run with one failure mode raises one exception, not thousands), plus a `column_run_failed` analytics event for failure-rate dashboards.
  - **tRPC** — non-typed defects keep their original stack (attached as the `TRPCError` cause) instead of being flattened to a string.
  - **Services** — a new injectable `ErrorReporter` port surfaces deliberately-swallowed best-effort failures (e.g. a failed invite email) without coupling the package to a telemetry client.
  - **Signals** — per-binding sync/warm-up failures in the cron worker are now reported (previously `console.error` only).
  - **Desktop shell** — a Rust panic hook reports Tauri-side panics (sidecar spawn, updater, window setup) to Error Tracking.
  - **PartyKit** — realtime handlers capture unexpected exceptions.

  No behaviour change when PostHog is unconfigured — every surface no-ops without a key.

### Patch Changes

- @gtmgrid/cloud@0.16.0
- @gtmgrid/db@0.16.0
- @gtmgrid/email@0.16.0

## 0.15.0

### Minor Changes

- f414614: Respect third-party API rate limits across all connectors. Every outbound connector call is now paced by a per-connector throttle (requests/second + max in-flight) at the engine's dispatch choke point, with researched limits baked into all bundled extensions and a conservative safety default (2 req/s, 2 concurrent) for any connector that declares none — so a large run can no longer fire an unbounded burst at a provider. Pure-local connectors (formatting/formula) are exempt.

  Transient failures (429/503/5xx and network blips) now retry with capped exponential backoff + jitter, honouring `Retry-After`: the manifest connector routes through the shared `fetchWithRetry`, the AI connector uses the vendor SDKs' own retry (maxRetries + timeout), and the cloud Trigify signal sync retries transient failures via an Effect schedule.

### Patch Changes

- @gtmgrid/cloud@0.15.0
- @gtmgrid/db@0.15.0
- @gtmgrid/email@0.15.0

## 0.14.0

### Patch Changes

- @gtmgrid/cloud@0.14.0
- @gtmgrid/db@0.14.0
- @gtmgrid/email@0.14.0

## 0.13.0

### Patch Changes

- @gtmgrid/cloud@0.13.0
- @gtmgrid/db@0.13.0
- @gtmgrid/email@0.13.0

## 0.12.0

### Patch Changes

- @gtmgrid/cloud@0.12.0
- @gtmgrid/db@0.12.0
- @gtmgrid/email@0.12.0

## 0.11.1

### Patch Changes

- @gtmgrid/cloud@0.11.1
- @gtmgrid/db@0.11.1
- @gtmgrid/email@0.11.1

## 0.11.0

### Patch Changes

- @gtmgrid/cloud@0.11.0
- @gtmgrid/db@0.11.0
- @gtmgrid/email@0.11.0

## 0.10.0

### Patch Changes

- @gtmgrid/cloud@0.10.0
- @gtmgrid/db@0.10.0
- @gtmgrid/email@0.10.0

## 0.9.24

### Patch Changes

- @gtmgrid/cloud@0.9.24
- @gtmgrid/db@0.9.24
- @gtmgrid/email@0.9.24

## 0.9.23

### Patch Changes

- @gtmgrid/cloud@0.9.23
- @gtmgrid/db@0.9.23
- @gtmgrid/email@0.9.23

## 0.9.22

### Patch Changes

- d2a41c5: Fix the Tables page showing duplicate tables and no row counts for cloud tables.

  - **Row counts**: `grid.listTables` now attaches each table's row count from a
    single grouped `countByTableIds` query (the efficient primitive existed but was
    never wired in; the in-memory repo was also missing it — a latent type error).
    The Tables page and sidebar now show real cloud row counts ("124 rows") instead
    of "Cloud table"/"—"; a table whose count an older server doesn't report falls
    back gracefully.
  - **Duplicates**: removed the sidebar "Recent" group, which repeated the 5 most-
    recent tables already shown in the full list below it. The Tables page already
    de-dupes by name.
  - The sidebar table rows now show a row count (hidden on hover, like folders).
  - @gtmgrid/cloud@0.9.22
  - @gtmgrid/db@0.9.22
  - @gtmgrid/email@0.9.22

## 0.9.21

### Patch Changes

- @gtmgrid/cloud@0.9.21
- @gtmgrid/db@0.9.21
- @gtmgrid/email@0.9.21

## 0.9.20

### Patch Changes

- @gtmgrid/cloud@0.9.20
- @gtmgrid/db@0.9.20
- @gtmgrid/email@0.9.20

## 0.9.19

### Patch Changes

- @gtmgrid/cloud@0.9.19
- @gtmgrid/db@0.9.19
- @gtmgrid/email@0.9.19

## 0.9.18

### Patch Changes

- @gtmgrid/cloud@0.9.18
- @gtmgrid/db@0.9.18
- @gtmgrid/email@0.9.18

## 0.9.17

### Patch Changes

- @gtmgrid/cloud@0.9.17
- @gtmgrid/db@0.9.17
- @gtmgrid/email@0.9.17

## 0.9.16

### Patch Changes

- 9f01681: Fix "undefined is not an object (evaluating 'snapshot.columns')" when
  deleting a column (or row) on a cloud table: the optimistic cache patch fed
  react-query's `undefined` (no cached unpaged snapshot — the normal state
  while the grid loads paged) into the grid reducer, which only guarded
  `null`. The reducer now tolerates both, and the optimistic path skips absent
  cache entries entirely.
  - @gtmgrid/cloud@0.9.16
  - @gtmgrid/db@0.9.16
  - @gtmgrid/email@0.9.16

## 0.9.15

### Patch Changes

- be203b9: Fix every cloud column run failing silently: the worker `getTable` payload
  shipped columns as `{id}` only, but the engine's cloud store finds the run
  column by `_id`, the agent's cloud tools resolve columns by `name`, and the
  webhook enricher filters by `kind` — so GUI column runs, agent cloud
  get_table/run_column, and webhook auto-run enrichment were all dead on the
  Postgres tier (promoted mapping columns stayed "—" forever). The payload now
  carries full Convex-doc-shaped columns/rows (`_id` + name/kind/code/params/
  condition/position, with `id` kept for legacy readers).
  - @gtmgrid/cloud@0.9.15
  - @gtmgrid/db@0.9.15
  - @gtmgrid/email@0.9.15

## 0.9.14

### Patch Changes

- 7eda629: Agent grid mutation tools + chat UX: the agent can now rename tables,
  reorder columns/rows, run a whole table, and use the full mutation surface
  on CLOUD tables (member-gated worker routes, metered, with confirm-protocol
  dry-runs for destructive ops). Chat gains slash commands, /goal, permission
  modes (bypass/auto/accept-edits/plan), a plan drawer, per-agent threads, and
  table rename/reorder realtime events.
- 17ea929: Sidebar folders for tables, on both local and cloud projects: create, rename,
  and delete folders, file tables into them ("New table here" included), and
  drag to reorder. Deleting a folder unfiles its tables (never deletes them).
  Folder changes broadcast on the workspace room so teammates' sidebars update
  live. Cloud adds a `folders` table + `tables.folder_id` (migration 0009);
  local SQLite upgrades in place.
- Updated dependencies [17ea929]
  - @gtmgrid/db@0.9.14
  - @gtmgrid/cloud@0.9.14
  - @gtmgrid/email@0.9.14

## 0.9.13

### Patch Changes

- 891e3b8: Agent presence (Co-Pilot cursor): the in-app AI agent now appears in cloud
  tables like a teammate. As it reads or writes — get_table, run_column,
  update_cells, add_rows — the grid shows "<Your name>'s Agent" in the avatar
  stack (bot glyph, brand-accent ring), rings the cell or column it's working
  on, and labels the activity ("reading the table", "updating 2 cells",
  "running Email"). Visible to everyone in the table's room, clears when the
  turn ends. Works against the already-deployed realtime party.
  - @gtmgrid/cloud@0.9.13
  - @gtmgrid/db@0.9.13
  - @gtmgrid/email@0.9.13

## 0.9.12

### Patch Changes

- 9bf183f: Webhook rows and column-run results now appear in the grid in real time.
  Worker-path writes (webhook insertRow/upsertRow and the engine's cell
  writes during cloud column runs) previously hit Postgres without
  broadcasting, so open grids stayed stale until a refetch. They now publish
  the same realtime events member edits do — `row.insert` with the mapped
  cells when a record lands, `cell.upsert` with the post-merge state on
  every worker cell write.
  - @gtmgrid/cloud@0.9.12
  - @gtmgrid/db@0.9.12
  - @gtmgrid/email@0.9.12

## 0.9.11

### Patch Changes

- 2ddf117: Clay-style webhook tables: every webhook now lands records in a dedicated
  "Webhook" column, so received data is always visible — even on a table with
  no other columns and no field mappings. Cells render as "Received <date>";
  clicking opens the payload in the cell-details panel, where each field has
  an "Add to column" action that promotes it to a real column applied to all
  existing and future rows. Re-enabling an existing webhook heals it with the
  new column. Mapping replaces never drop the raw-payload entry.
  - @gtmgrid/cloud@0.9.11
  - @gtmgrid/db@0.9.11
  - @gtmgrid/email@0.9.11

## 0.9.10

### Patch Changes

- @gtmgrid/cloud@0.9.10
- @gtmgrid/db@0.9.10
- @gtmgrid/email@0.9.10

## 0.9.9

### Patch Changes

- 67f3d44: Agent sessions can now use your saved provider keys, and webhook signature
  auth is opt-in:

  - Provider CLIs and skills the agent runs (trigify-cli, gh, …) authenticate
    automatically: saved credentials are injected as conventional env vars
    (`TRIGIFY_API_KEY`, `GITHUB_TOKEN`, …) at agent spawn — cloud workspace
    credentials in cloud mode, the local credential store in local mode. An
    explicitly exported env var still wins, and values never appear in args
    or logs.
  - Inbound webhooks no longer force HMAC signing: new webhooks accept
    unsigned posts (the unguessable token URL is the credential), with a
    "Require signed requests" toggle to opt in to `X-GTMGrid-Signature`
    verification. Existing webhooks keep their secrets and behave as before.
  - @gtmgrid/cloud@0.9.9
  - @gtmgrid/db@0.9.9
  - @gtmgrid/email@0.9.9

## 0.9.8

### Patch Changes

- 3cbb8b2: Fix every poll-trigify-signals run failing at the due-bindings query. The
  SQL due-filter bound `-Infinity` as the CASE fallback threshold, but
  `last_synced_at` is a bigint column and Postgres rejects `-Infinity` for
  integer types — so the query errored on every execution and no scheduled
  signal binding was ever polled. The fallback is now `NULL` (never due),
  matching the intended semantics.
  - @gtmgrid/cloud@0.9.8
  - @gtmgrid/db@0.9.8
  - @gtmgrid/email@0.9.8

## 0.9.7

### Patch Changes

- @gtmgrid/cloud@0.9.7
- @gtmgrid/db@0.9.7
- @gtmgrid/email@0.9.7

## 0.9.6

### Patch Changes

- @gtmgrid/cloud@0.9.6
- @gtmgrid/db@0.9.6
- @gtmgrid/email@0.9.6

## 0.9.5

### Patch Changes

- @gtmgrid/cloud@0.9.5
- @gtmgrid/db@0.9.5
- @gtmgrid/email@0.9.5

## 0.9.4

### Patch Changes

- @gtmgrid/cloud@0.9.4
- @gtmgrid/db@0.9.4
- @gtmgrid/email@0.9.4

## 0.9.3

### Patch Changes

- @gtmgrid/cloud@0.9.3
- @gtmgrid/db@0.9.3
- @gtmgrid/email@0.9.3

## 0.9.2

### Patch Changes

- @gtmgrid/cloud@0.9.2
- @gtmgrid/db@0.9.2
- @gtmgrid/email@0.9.2

## 0.9.1

### Patch Changes

- @gtmgrid/cloud@0.9.1
- @gtmgrid/db@0.9.1
- @gtmgrid/email@0.9.1

## 0.9.0

### Patch Changes

- a6d488d: Two cloud-parity improvements:

  - **Live sidebar** — when a teammate creates, syncs, or deletes a table in your
    workspace, your sidebar table list now updates in real time (no app restart).
    Table create/delete events are broadcast on a per-workspace realtime room that
    the sidebar subscribes to.
  - **Deduplication on cloud tables** — the Dedupe control (previously local-only)
    now works on cloud tables: pick a column and keep-oldest/newest, and the server
    removes duplicate rows and broadcasts the deletions live to everyone viewing the
    table. Adds a nullable `dedupe_column` / `dedupe_keep` to the cloud `tables`
    schema (migration included).

- Updated dependencies [a6d488d]
  - @gtmgrid/db@0.9.0
  - @gtmgrid/cloud@0.9.0
  - @gtmgrid/email@0.9.0

## 0.8.0

### Patch Changes

- c3eb12d: Add live multiplayer presence to the cloud grid. You can now see who else is in a
  table in real time:

  - **Live users avatar stack** in the grid toolbar — everyone currently viewing the
    table, with their profile photo (or initials), capped at 5 with a **"+N more"**
    overflow. Hover an avatar to see the member's name.
  - **Cell cursors** — each other member's selected cell gets a colored ring and a
    small avatar chip (Airtable-style), so you can see where teammates are working.
  - **Editing indicator** — a member actively editing a cell shows a pulsing ring.
  - **Follow a teammate** — click their avatar to jump the grid to their current cell.

  Presence rides the existing per-table PartyKit channel (no extra connection) and
  each member's name/photo come from the workspace (the `me`/`listMembers` APIs now
  expose the user's avatar image). Built on shadcn/ui avatar + tooltip primitives.

  - @gtmgrid/cloud@0.8.0
  - @gtmgrid/db@0.8.0
  - @gtmgrid/email@0.8.0

## 0.7.8

### Patch Changes

- @gtmgrid/cloud@0.7.8
- @gtmgrid/db@0.7.8
- @gtmgrid/email@0.7.8

## 0.7.7

### Patch Changes

- @gtmgrid/cloud@0.7.7
- @gtmgrid/db@0.7.7
- @gtmgrid/email@0.7.7

## 0.7.6

### Patch Changes

- @gtmgrid/cloud@0.7.6
- @gtmgrid/db@0.7.6
- @gtmgrid/email@0.7.6

## 0.7.5

### Patch Changes

- @gtmgrid/cloud@0.7.5
- @gtmgrid/db@0.7.5
- @gtmgrid/email@0.7.5

## 0.7.4

### Patch Changes

- @gtmgrid/cloud@0.7.4
- @gtmgrid/db@0.7.4
- @gtmgrid/email@0.7.4

## 0.7.3

### Patch Changes

- @gtmgrid/cloud@0.7.3
- @gtmgrid/db@0.7.3
- @gtmgrid/email@0.7.3

## 0.7.2

### Patch Changes

- @gtmgrid/cloud@0.7.2
- @gtmgrid/db@0.7.2
- @gtmgrid/email@0.7.2

## 0.7.1

### Patch Changes

- @gtmgrid/cloud@0.7.1
- @gtmgrid/db@0.7.1
- @gtmgrid/email@0.7.1

## 0.7.0

### Patch Changes

- @gtmgrid/cloud@0.7.0
- @gtmgrid/db@0.7.0
- @gtmgrid/email@0.7.0

## 0.6.1

### Patch Changes

- @gtmgrid/cloud@0.6.1
- @gtmgrid/db@0.6.1
- @gtmgrid/email@0.6.1

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

- @gtmgrid/cloud@0.6.0
- @gtmgrid/db@0.6.0
- @gtmgrid/email@0.6.0

## 0.5.1

### Patch Changes

- @gtmgrid/cloud@0.5.1
- @gtmgrid/db@0.5.1
- @gtmgrid/email@0.5.1

## 0.5.0

### Patch Changes

- @gtmgrid/cloud@0.5.0
- @gtmgrid/db@0.5.0
- @gtmgrid/email@0.5.0

## 0.4.0

### Patch Changes

- @gtmgrid/cloud@0.4.0
- @gtmgrid/db@0.4.0
- @gtmgrid/email@0.4.0

## 0.3.18

### Patch Changes

- @gtmgrid/cloud@0.3.18
- @gtmgrid/db@0.3.18
- @gtmgrid/email@0.3.18

## 0.3.17

### Patch Changes

- @gtmgrid/cloud@0.3.17
- @gtmgrid/db@0.3.17
- @gtmgrid/email@0.3.17

## 0.3.16

### Patch Changes

- @gtmgrid/cloud@0.3.16
- @gtmgrid/db@0.3.16
- @gtmgrid/email@0.3.16

## 0.3.15

### Patch Changes

- @gtmgrid/cloud@0.3.15
- @gtmgrid/db@0.3.15
- @gtmgrid/email@0.3.15

## 0.3.14

### Patch Changes

- @gtmgrid/cloud@0.3.14
- @gtmgrid/db@0.3.14
- @gtmgrid/email@0.3.14

## 0.3.13

### Patch Changes

- @gtmgrid/cloud@0.3.13
- @gtmgrid/db@0.3.13
- @gtmgrid/email@0.3.13

## 0.3.12

### Patch Changes

- @gtmgrid/cloud@0.3.12
- @gtmgrid/db@0.3.12
- @gtmgrid/email@0.3.12

## 0.3.11

### Patch Changes

- @gtmgrid/cloud@0.3.11
- @gtmgrid/db@0.3.11
- @gtmgrid/email@0.3.11

## 0.3.10

### Patch Changes

- @gtmgrid/cloud@0.3.10
- @gtmgrid/db@0.3.10
- @gtmgrid/email@0.3.10

## 0.3.9

### Patch Changes

- @gtmgrid/cloud@0.3.9
- @gtmgrid/db@0.3.9
- @gtmgrid/email@0.3.9

## 0.3.8

### Patch Changes

- 7f41587: Fix the plan upgrade/checkout from a trial. Autumn `attach` now forces hosted
  Stripe Checkout (`redirectMode: "always"`) so upgrading a customer with no card on
  file (e.g. on a no-card trial) opens checkout to collect payment instead of
  failing with a Stripe "no payment source" 400. And selecting the plan you're
  already trialing (e.g. Team → Team) now uses `setupPayment` (add a card, convert
  the trial to paid) instead of re-attaching the same plan, which Autumn rejects
  with a 409 `plan_already_attached`.
- Updated dependencies [7f41587]
  - @gtmgrid/cloud@0.3.8
  - @gtmgrid/db@0.3.8
  - @gtmgrid/email@0.3.8

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
