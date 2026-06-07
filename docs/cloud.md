# Cloud / Teams (commercial) — architecture

gtmgrid is **open-core**: the MIT-licensed local app stays fully capable and
offline forever; a paid **multiplayer / team** tier is added on top. This doc
describes the architecture after the cloud→Postgres migration epic — the tier
now runs on **Supabase Postgres + Drizzle + Better Auth + tRPC (serverless in
`apps/web`)**, with domain logic in the Effect-DI `@gtmgrid/services` package,
**server-gated PartyKit** realtime, and an **Inngest** worker for inbound
webhooks. For the user-facing summary and setup, see the "Cloud / Teams" section
in the [README](../README.md); for a local bring-up, see
[local-dev.md](./local-dev.md).

> Historical note: the cloud tier was originally built on Convex. The Convex
> backend (`convex/`, reactive `useQuery`, mutations/actions) has been **fully
> removed**; this doc describes only the current stack. Where a module's
> docblock says "ports `convex/…`", it is naming the source the pure logic was
> lifted from — not a live dependency.

## Model

- **Free = local solo.** Local projects use the bundled SQLite engine via the
  sidecar (`packages/server`) and never call the cloud. Unchanged and offline.
- **Paid = cloud team.** Shared projects live in a **Supabase Postgres**
  database (the cloud source of truth), accessed through the **tRPC API** in
  `apps/web`. The account unit is the **workspace (team)** — members, projects,
  and credentials scope to it, and billing is per workspace.
- **No feature gating.** Connectors and tables are unlimited on both tiers. The
  **only** gate is **seats**; **cloud actions** are metered (not capped per se,
  but a workspace has a `cloudActionsLimit`).

```
Local project (free, solo)
  React UI ── local sidecar ── engine ── local SQLite        (unchanged, offline)

Cloud project (paid, team)
  React UI ──tRPC (read/write)──▶ apps/web ──Effect services──▶ Postgres (source of truth)
            ◀──live patches───── PartyKit grid room ◀── server publish (after each write)
  "Run column" ▶ LOCAL engine reads inputs over /api/worker/*, runs QuickJS +
                 connectors locally, writes cell status/results back the same way
```

## The stack at a glance

| Concern | Component | Where |
| --- | --- | --- |
| Postgres schema + migrations | `@gtmgrid/db` (Drizzle) | `packages/db` |
| Auth (email/password + OAuth) | `@gtmgrid/auth` (Better Auth) + party-token | `packages/auth` |
| Domain logic (Effect-DI) | `@gtmgrid/services` (repos + services) | `packages/services` |
| Pure authz / billing / crypto core | `@gtmgrid/cloud` | `packages/cloud` |
| API surface | tRPC `appRouter` (serverless) | `apps/web/lib/trpc` |
| Auth HTTP handler | Better Auth catch-all | `apps/web/app/api/auth/[...all]` |
| Inbound webhooks (enqueue) | webhook receiver | `apps/web/app/api/webhooks/[token]` |
| Webhook worker (process) | Inngest function | `apps/web/lib/inngest` + `/api/inngest` |
| Headless worker endpoints | secret-gated routes | `apps/web/app/api/worker/*` |
| Realtime fan-out | server-gated PartyKit party | `apps/party` |
| Desktop cloud client | tRPC/react-query + realtime | `packages/desktop/src/cloud` |

## Data layer — `@gtmgrid/db` (Drizzle over Postgres)

`packages/db/src/schema.ts` defines the workspace-scoped tables (`workspaces`,
`members`, `projects`, `tables`, `columns`, `rows`, `cells`, `extensions`,
`credentials`, webhook config + delivery log, plus the Better Auth tables
`users`/`sessions`/`accounts`/`verifications`). Domain tables key on `bigint`
epoch-ms timestamps; the Better Auth tables use `timestamptz`.

The connection client (`packages/db/src/client.ts`) points at Supabase's
**Supavisor pooler in TRANSACTION mode** (`DATABASE_URL`, port 6543) and opens
it with `prepare: false` (mandatory for transaction-mode pooling). Migrations
are generated offline (`pnpm db:generate`) and applied with `pnpm db:migrate`.

## Domain logic — `@gtmgrid/services` (Effect-DI)

All cloud data access and business logic live behind Effect-TS services
(`Context.Tag` + `Layer`) — typed errors and Layer-based dependency injection,
unit-tested by substituting in-memory Layers (never mocks). See
[`packages/services/README.md`](../packages/services/README.md) for the full
pattern. The three building blocks:

- **Repository** — one per table, the Effect↔Drizzle adapter. A `Context.Tag`
  with a **Live** Layer (Drizzle over `@gtmgrid/db`, depends on the per-request
  `DbClient`) and a **Test** Layer (in-memory, backed by a fixed array). Repos
  are the **only** place Drizzle is touched.
- **Domain service** — business logic composing repositories and the reused pure
  `@gtmgrid/cloud` authz core (`MembershipService.requireMember`, seats, crypto).
- **Composed Layers** (`src/layers.ts`) — `appLayer({ db, userId })` wires every
  service to its Drizzle implementation (LIVE); `TestLayer(fixtures)` wires every
  service to its in-memory Layer (no `DbClient` ever needed). Both produce the
  **same** services, so a program is identical across production and tests.

Two per-request pieces flow in as Layers, not globals: **`DbClient`** (the
pooled Drizzle handle) and **`Identity`** (the caller's user id, resolved from
the Better Auth session via `@gtmgrid/auth`). Notable services include
`GridService`, `WebhookService`, `MeterService` (the single cloud-actions
metering surface), `InvitationService` (seat-gated), `CredentialService`, and
`RealtimePublisher` (the PartyKit publish port).

## API — tRPC in `apps/web`

The single API surface is the tRPC `appRouter`
(`apps/web/lib/trpc/root.ts`), served serverless at `/api/trpc`. Each router
under `apps/web/lib/trpc/routers/` resolves its service from the per-request
Effect runtime and runs the program via the `runEffect` helper; the runtime is
built from `appLayer` in the tRPC context (`apps/web/lib/trpc/context.ts`).
Procedure middleware (`workspaceProcedure`) asserts membership **before** the
body runs, so a non-member never reaches a handler. Routers:

- `health` — public liveness probe (no auth, no DB).
- `auth.enabledProviders` — booleans-only OAuth/email gating for the sign-in UI.
- `workspaces` — `me`, `listMembers`, `createWorkspace`.
- `billing` — `checkout` (Autumn upgrade URL).
- `invitations` — invite → accept lifecycle (seat-gated).
- `credentials` — encrypt/save, member-gated decrypt, metadata list.
- `webhooks` / `extensions` — member-gated config CRUD.
- `grid` — projects/tables/columns/rows/cells; `getTable` returns the full grid
  in one read; mutations meter cloud actions on the write path.
- `realtime.token` — mints a workspace-scoped token for the PartyKit connection.

The Convex action/mutation split is gone: each operation is a **single**
procedure that runs one Effect.

## Auth — Better Auth (`@gtmgrid/auth`)

Sign-in is **Better Auth**: email + password (always on), 6-digit OTP email
verification, and OAuth (GitHub + Google) registered **only when their
credentials are present** on the deployment, so the build stays green with no
OAuth secrets set. The HTTP handler is the catch-all route
`apps/web/app/api/auth/[...all]/route.ts`; the client reads the public
`auth.enabledProviders` tRPC query (booleans only, never secrets) to render one
OAuth button per enabled provider. The desktop uses the same web redirect plus a
`gtmgrid://` deep-link callback for the packaged Tauri build.

`@gtmgrid/auth` also mints the **PartyKit connection token** (workspace-scoped,
HS256) used to authorize the realtime socket — see Realtime below.

## Execution stays local

The cloud only stores and syncs data; the engine never runs in the cloud. The
engine `GridStore` abstraction (`packages/engine/src/store.ts`) has two
implementations:

- `SqliteGridStore` — thin wrapper over the synchronous `Db` (local projects;
  behaviour unchanged, regression-tested for parity).
- the cloud store (`packages/engine/src/store-cloud.ts`) — fed an injected
  `CloudClientLike` whose "function refs" are just `/api/worker/*` route paths.

When a column runs on a cloud project, the sidecar
(`packages/server/src/cloud-run.ts`) builds an `Engine` over the cloud store: it
reads inputs over the worker endpoints, runs the QuickJS sandbox + connector
HTTP calls **on the user's machine**, and writes status/results back via the
same endpoints. Status (`running` → `done`/`error`) then streams live to every
member through the realtime publish the server emits on each write.

### Headless worker endpoints — `apps/web/app/api/worker/*`

These Next.js route handlers (`runtime = "nodejs"`) replace the Convex
`convex/http.ts` `/webhook/*` boundary. The caller (the Inngest webhook worker
and the desktop sidecar's cloud-run path) is **not** a member and carries no
session, so the trust boundary is a shared **`WEBHOOK_WORKER_SECRET`
constant-time bearer** checked in `_lib.ts` (`isAuthorizedWorker`). A
missing/incorrect bearer returns 401 **before** any service runs; an unset env
secret rejects everything (fail-closed). Authorized requests run a
`WebhookService` Effect against `appLayer` with `userId: null` (the worker has no
member identity — the secret, not membership, gates these routes).

> **Member attribution (noted follow-up).** `packages/server/src/cloud-run.ts`
> forwards the signed-in member's token as an `X-Gtmgrid-Member` header on each
> worker call. The worker routes currently **do not read it** — they run with
> `userId: null` and the secret is the only trust boundary. Attributing
> worker-path writes to the originating member (consuming `X-Gtmgrid-Member`) is
> a deliberate follow-up; the current intentionally-ignored behaviour is pinned
> by `apps/web/lib/inngest/worker-gate.test.ts`.

## Inbound webhooks — Inngest worker

An inbound webhook hits `apps/web/app/api/webhooks/[token]`, which authenticates
the per-table token and **enqueues** an Inngest event; the
`process-webhook-record` Inngest function (`apps/web/lib/inngest`, served at
`/api/inngest`) processes it asynchronously, calling the worker endpoints to
upsert rows/cells. Set `INNGEST_DEV=1` for local dev (no signing key; talks to
the Inngest dev server).

## Realtime multiplayer — server-gated PartyKit (`apps/party`)

The Convex `useQuery` live subscription is replaced by a **server-gated PartyKit
party**. One room per workspace+table (room id `${workspaceId}:${tableId}`):

- **Authorization (`onBeforeConnect`).** The client opens the socket with a
  `?token=` minted by the server (`realtime.token` tRPC procedure →
  `@gtmgrid/auth`, HS256, `PARTY_AUTH_SECRET`). The party verifies the token and
  **rejects** (401) unless its `workspaceId` matches the room and it is
  unexpired — the pure `authorizeGridConnection` decision. This closes a
  non-member's socket before it can receive any event (the cross-tenant-leak
  fix).
- **Server publish (`onRequest`).** A grid change enters the room **only** via a
  server POST from `RealtimePublisher`'s Live Layer, authorized with
  `Authorization: Bearer PARTY_PUBLISH_SECRET` (constant-time, fail-closed). The
  party then `broadcast`s the typed `GridChangeEvent` to connected (already
  authorized) clients, which patch their cached `getTable` snapshot via the pure
  reducer `applyGridEvent` — no refetch, no CDC.
- **Presence.** Each connection derives its `userId` from the token; the party
  broadcasts the roster on join/leave so members see who's editing.

The wire protocol, event schema, reducer, and the thin client subscriber
(`subscribeToGrid`) live in `@gtmgrid/services/realtime` so the desktop imports
them. The Live publisher is **best-effort**: a transport error never fails a
write that already succeeded (tRPC reads remain the source of truth), and when
`PARTY_URL` / `PARTY_PUBLISH_SECRET` are unset it degrades to a no-op publisher.
The server publish endpoint is
`${PARTY_URL}/parties/grid/${workspaceId}:${tableId}`.

For deploying the party (`partykit deploy`) and the prod env wiring, see
[**Production PartyKit deploy**](#production-partykit-deploy) below.

## Seats billing (Autumn)

Subscriptions are **seat-based**, metered per workspace via
[Autumn](https://useautumn.com) (Stripe underneath), with **no** connector/table
caps. The pure, unit-tested logic is in `packages/cloud/src/seats.ts`
(`SEATS_FEATURE_ID = "seats"`); the Autumn client port (`AUTUMN_SECRET_KEY`) is
injected, and falls back to a fake Autumn when the key is unset so the build runs
without billing. Inviting a member runs an Autumn `check` on `seats`; a free seat
proceeds (and `track`s usage); over the limit returns the Autumn `checkout` URL.
A transactional seat-ceiling assertion at the limit fails the insert with
`SeatLimitExceededError` (covered by `invitation-service.test.ts`).

## Cloud-actions metering (single surface)

Every billable cloud grid mutation counts toward the workspace's cloud-actions
usage. Metering is a **single write-path surface**: `MeterService.meterActions`
increments `cloudActionsUsed` directly (and best-effort `track`s to Autumn) —
there is no separate pending counter and no cron flush (the Convex
pending+cron model was dropped in the migration). The read snapshot (`me`) lives
on `WorkspaceRepo`; the metering write lives on `MeterService`, so the two never
tangle and a mutation is metered **exactly once** (e.g. `setCell`/`setCellStatus`
meter only on a **terminal** status, never on `running`; `createProject` is not
metered). This single-count discipline is covered by `grid-service.test.ts` and
`webhook-service.test.ts`.

## Shared team credentials

Workspace connector keys are stored in the Postgres `credentials` table,
encrypted at rest with envelope encryption: a per-workspace data key wrapped by a
backend **master key** read from `CREDENTIALS_MASTER_KEY` (32-byte hex KEK).
Plaintext is only ever decrypted in the trusted run path — never exposed to other
members' clients. The crypto domain logic
(`packages/services/src/credential-crypto.ts` over the pure
`packages/cloud/src/crypto.ts`) reads the key through an Effect port so it never
touches `process.env` directly. Local projects keep the existing machine-local
`~/.gtmgrid/key` AES-256-GCM model in `packages/engine/src/crypto.ts`, untouched.

## Setup

The cloud tier reads these environment variables (names only — never commit
secret values). See `.env.example` for the authoritative list with comments.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | apps/web env | Supabase pooled (Supavisor transaction, port 6543) connection |
| `SITE_URL` | apps/web env | deployment base URL; trusted OAuth/redirect origin |
| `SUPABASE_JWT_SECRET` | apps/web env | (legacy realtime token signing; PartyKit now uses `PARTY_AUTH_SECRET`) |
| `AUTH_RESEND_KEY` / `RESEND_FROM` | apps/web env | transactional email (Resend); unset → email no-ops |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | apps/web env | enable GitHub OAuth (both required, else disabled) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | apps/web env | enable Google OAuth (both required, else disabled) |
| `AUTUMN_SECRET_KEY` | apps/web env | server-side Autumn key for seats; unset → fake Autumn |
| `CREDENTIALS_MASTER_KEY` | apps/web env | 32-byte hex KEK for credential envelope encryption |
| `WEBHOOK_WORKER_SECRET` | apps/web + worker callers | shared bearer gating `/api/worker/*` |
| `INNGEST_DEV` | apps/web env | `1` for local Inngest dev server |
| `PARTY_AUTH_SECRET` | apps/web + apps/party | HS256 secret for the PartyKit connection token (shared) |
| `PARTY_PUBLISH_SECRET` | apps/web + apps/party | server-publish bearer (shared) |
| `PARTY_URL` | apps/web env | base URL of the deployed party host (server publish target) |
| `VITE_API_URL` | desktop env | apps/web base URL the desktop client connects to |
| `VITE_PARTY_URL` | desktop env | party host URL the desktop subscriber connects to |

OAuth providers and Autumn are **optional**: with none of the `AUTH_*` vars set
the build/deploy is clean (the provider is not registered), and an unset
`AUTUMN_SECRET_KEY` falls back to the fake Autumn client. The OSS local-only
build needs none of these: an absent `VITE_API_URL` disables cloud in the client.

## Production PartyKit deploy

The realtime party (`apps/party`) deploys to **Cloudflare via PartyKit**. It is
**not** auto-deployed by the epic — run it explicitly:

```bash
pnpm -F @gtmgrid/party deploy        # = partykit deploy (Cloudflare)
```

`apps/party/package.json` exposes `dev` (`partykit dev`) and `deploy`
(`partykit deploy`); `apps/party/partykit.json` declares the `grid` party
(`src/server.ts`). The deploy prints the party host URL — that URL becomes
**`PARTY_URL`** on `apps/web` (the server-publish target) and **`VITE_PARTY_URL`**
on the desktop (the subscriber target).

**Prod env wiring** (the secrets must MATCH on both sides):

| Variable | Set on | Value |
| --- | --- | --- |
| `PARTY_AUTH_SECRET` | `apps/web` **and** the deployed party | same HS256 secret (mint vs. verify the connection token) |
| `PARTY_PUBLISH_SECRET` | `apps/web` **and** the deployed party | same server-publish bearer |
| `PARTY_URL` | `apps/web` | the deployed party host URL (e.g. `https://gtmgrid-party.<account>.partykit.dev`) |
| `VITE_PARTY_URL` | desktop build | the same deployed party host URL |

Set the party-side secrets with `partykit env` (or the PartyKit dashboard); set
`PARTY_URL` + the matching secrets on the `apps/web` deployment. If `PARTY_URL`
or `PARTY_PUBLISH_SECRET` is unset on `apps/web`, the publisher degrades to a
no-op (writes still succeed; no live fan-out), and if `PARTY_AUTH_SECRET` is
unset on the party, every connection is rejected (fail-closed).

## Verification

`pnpm typecheck` and `pnpm test` cover the data path end-to-end: every tRPC
procedure is tested via `createCaller` against a `TestLayer` (no live DB), and
every service/repository method is unit-tested with in-memory Layers. The
worker shared-secret gate and the `X-Gtmgrid-Member` follow-up are pinned by
`apps/web/lib/inngest/worker-gate.test.ts`; the party authorization decision is
unit-tested in `@gtmgrid/auth` (`party-token.test.ts`). Live two-window
multiplayer (open the same cloud project in two windows; an edit/add-row/
column-run in one appears live in the other) is a **visual** check that requires
a deployed (or local) party + a desktop run — it is **not** asserted by the
automated gate.

## Future Expansion

- **Worker-path member attribution** — consume the forwarded `X-Gtmgrid-Member`
  header so cloud-run writes are attributed to the originating member.
- **Cloud execution of grids** — run columns in a cloud runtime; prerequisite
  for unattended runs (today execution is always local).
- **Proxied managed-key connectors** — our keys + Autumn credit metering as an
  extra revenue lever.
- **Offline editing of cloud projects** with later reconciliation.
