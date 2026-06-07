# `@gtmgrid/services`

The Effect-DI foundation **every tRPC router builds on**. It holds the cloud
tier's **repositories** (Effect ↔ Drizzle adapters over `@gtmgrid/db`) and
**domain services** (business logic composing repositories + the reused
`@gtmgrid/cloud` authz core). W2 lanes add their routers' repos/services here,
following the conventions below.

> **Architecture mandate:** all data access + domain logic are Effect-TS services
> (`Context.Tag` + `Layer`). No raw Drizzle in routers / Inngest / UI, no `as`
> casts. Repositories are the only place Drizzle is touched.

## The three building blocks

### 1. Repository — the Effect ↔ Drizzle adapter

One per table. A `Context.Tag` whose methods return `Effect.Effect<…, RepoError>`,
with **two** Layers:

- **Live** (`*Live`): Drizzle-backed, depends on [`DbClient`](#dbclient-the-per-request-handle).
  Every query is wrapped in `Effect.tryPromise` so transport failures become a
  typed `Data.TaggedError`, never a thrown rejection.
- **Test** (`*Layer(rows)`): in-memory, backed by a fixed array. Tests use this
  so repos are exercised with **no live database**.

See `src/repositories/workspace-repo.ts` for the worked example.

```ts
export class WorkspaceRepo extends Context.Tag("WorkspaceRepo")<
  WorkspaceRepo,
  { readonly findById: (id: string) => Effect.Effect<Option.Option<Workspace>, WorkspaceRepoError> }
>() {}

export const WorkspaceRepoLive: Layer.Layer<WorkspaceRepo, never, DbClient> = /* Drizzle */;
export const workspaceRepoLayer = (rows: readonly Workspace[]): Layer.Layer<WorkspaceRepo> => /* in-memory */;
```

### 2. Domain service — business logic over repositories

Defined with the `Effect.Service` pattern (Tag + Layer in one). Composes
repositories and other services (e.g. the authz `MembershipService`) into a
domain operation with the rules attached. See
`src/services/workspace-service.ts`: `getWorkspace` asserts membership
(`MembershipService.requireMember`, the Effect port of
`convex/model/auth.ts:162`) **before** returning data.

```ts
export class WorkspaceService extends Effect.Service<WorkspaceService>()("WorkspaceService", {
  effect: Effect.gen(function* () {
    const repo = yield* WorkspaceRepo;
    const membership = yield* MembershipService;
    return {
      getWorkspace: (id: string) => Effect.gen(function* () {
        yield* membership.requireMember(id); // authz first
        /* … load via repo, 404 if missing … */
      }),
    } as const;
  }),
  dependencies: [],
}) {}
```

### 3. Composed Layers — the DI wiring point (`src/layers.ts`)

- **`appLayer({ db, userId })`** — LIVE composition. Wires every service to its
  Drizzle implementation, closing over the per-request pooled `db` handle and the
  caller's resolved `userId`. The tRPC context builds a `Runtime` from it.
- **`TestLayer(fixtures)`** — in-memory composition factory. Takes
  `{ workspaces, memberships, currentUserId }` and wires every service to its
  in-memory Test Layer. **No `DbClient` is ever needed.**

Both produce the **same** services, so a program is identical across production
and tests — swapping `TestLayer` for `appLayer` changes behaviour with no live
database.

## Context injection (the DI seam)

Two pieces of **per-request** data flow in as Layers, not globals:

- **`DbClient`** — the pooled Drizzle handle (`@gtmgrid/db/client`, `prepare:false`
  Supavisor transaction mode). Resolved once per request and provided via
  `dbClientLayer(db)`; repos depend on it instead of importing `db` directly.
- **`Identity`** — the caller's user id, resolved from the Better Auth session
  (`@gtmgrid/auth` `getSessionUserId`) and provided via `identityFromUserId(id)`.

The tRPC context (`apps/web/lib/trpc/context.ts`) resolves both and builds the
`appLayer`; a `runEffect` helper runs procedure programs against it. Tests swap
in `TestLayer` and run the **same** procedures via `createCaller`.

### `DbClient` — the per-request handle

`DbClient` is a plain `Context.Tag` (value supplied externally). Production
provides the live pooled handle; tests never provide it (the repos are swapped
wholesale), so no connection is opened.

## Testing pattern (offline, no live DB)

1. **Service method** — provide `TestLayer(fixtures)`, run with
   `Effect.runPromiseExit`, assert the value or the typed error `_tag` via
   `Cause.failureOption`. See `src/services/workspace-service.test.ts`.
2. **Procedure** — build a tRPC test context whose Layer is `TestLayer(fixtures)`,
   then call `appRouter.createCaller(ctx)` and assert outcomes (member success,
   non-member rejection). See `apps/web/lib/trpc/*.test.ts`.

Never mock — substitute real in-memory Layers. This is the same discipline as
`@gtmgrid/cloud` (`docs/effect-conventions.md`).

## Realtime — live grid + presence (W3, TRI-3251)

The Convex `useQuery(api.tables.getTable)` live subscription is replaced by
**Supabase Realtime Broadcast + Presence**, fronted by an injectable Effect port.

**Channel model.** One channel per workspace+table: `grid:{workspaceId}:{tableId}`
(`gridChannelName` in `src/realtime/events.ts`). After a successful grid write,
`GridService` calls `RealtimePublisher.publish` with the owning workspace, table,
and a typed `GridChangeEvent` (cell/row/column insert·update·delete, table
insert·delete). Every other client subscribed to that table receives the
Broadcast and patches its cached `getTable` snapshot via the **pure reducer**
`applyGridEvent` (`src/realtime/reducer.ts`) — no refetch, no Postgres-Changes/CDC.

**Auth model (no RLS).** The client authorizes the Realtime *connection* with a
Supabase-compatible HS256 JWT minted by the server (`realtime.token`
protectedProcedure → `@gtmgrid/auth` `mintSupabaseJwt`, signed with
`SUPABASE_JWT_SECRET`). The JWT authorizes the socket only; **all reads/writes
still go through tRPC**. Presence carries who's-editing / cursor state. The thin
client subscriber is `subscribeToGrid` (`src/realtime/channel.ts`); the event
schema + reducer + subscriber live HERE (not apps/web) so the desktop (W4) imports
them from `@gtmgrid/services`.

**DI.** `RealtimePublisher` (`src/services/realtime-publisher.ts`) is a
`Context.Tag` with a LIVE Layer (`realtimePublisherLayerFromEnv` — Supabase
broadcast, best-effort, degrades to a no-op when `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` are unset) and a TEST Layer
(`recordingRealtimePublisherLayer` — records events into a shared array). Both are
registered in `appLayer` / `TestLayer` and provided to `GridService`, so grid
mutations are unit-tested offline by asserting the recorded events. The live
publish is best-effort by construction: a realtime transport error never fails a
write that already succeeded (tRPC reads remain the source of truth).

> **Fallback note (option b).** If Supabase Realtime auth without RLS proves
> awkward in the live two-client verification (deferred to TRI-3259 E2E), the
> publisher port can be re-pointed at a dedicated CRDT provider authed via tRPC
> with NO change to `GridService` — the whole point of the injectable port.

## Adding a router's data layer (W2 checklist)

1. Add a repository in `src/repositories/<name>-repo.ts` (Tag + `*Live` + test
   `*Layer`). Export it from `src/index.ts`.
2. Add a domain service in `src/services/<name>-service.ts` if there is logic
   beyond raw reads/writes; otherwise call the repo from the procedure.
3. Wire the new repo/service into `appLayer` and `TestLayer` in `src/layers.ts`.
4. Unit-test the service against its Test Layer; test the procedure via
   `createCaller` with a `TestLayer` context.
