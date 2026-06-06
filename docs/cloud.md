# Cloud / Teams (commercial) — architecture

gtmgrid is **open-core**: the MIT-licensed local app stays fully capable and
offline forever; a paid **multiplayer / team** tier is added on top. This doc
covers what shipped across Waves 1–3 of the cloud build. For the user-facing
summary and setup, see the "Cloud / Teams (commercial)" section in the
[README](../README.md).

## Model

- **Free = local solo.** Local projects use the bundled SQLite engine via the
  sidecar (`packages/server`) and never call the cloud. Unchanged and offline.
- **Paid = cloud team.** Shared projects live in a [Convex](https://convex.dev)
  workspace (the cloud source of truth). The account unit is the **workspace
  (team)** from day one — members, projects, and credentials scope to it, and
  billing is per workspace.
- **No feature gating.** Connectors and tables are unlimited on both tiers. The
  **only** gate is **seats**.

```
Local project (free, solo)
  React UI ── local sidecar ── engine ── local SQLite        (unchanged, offline)

Cloud project (paid, team)
  React UI ──reactive useQuery──▶ Convex DB  ◀── source of truth (LIVE multiplayer)
  "Run column" ▶ LOCAL engine reads inputs from Convex, runs QuickJS + connectors
                 locally, writes cell status/results back via Convex mutations
```

## Realtime multiplayer via Convex

Convex's reactive database makes every `useQuery` a **live subscription**, so an
edit / add-row / column-run by any member appears in every other member's window
with no manual refresh and **no custom sync engine**. Cell run statuses
(`running` → `done`/`error`) stream to all members the same way.

The desktop cloud client lives in `packages/desktop/src/cloud/`:

- `convex.tsx` — Convex client + auth provider. Reads `VITE_CONVEX_URL`; when it
  is absent the client treats cloud as **disabled** (OSS local-only build).
- `auth.ts` / `AccountBar.tsx` — sign-in, the `me` query, workspace switcher,
  plan/seat badge.
- `useCloudGrid.ts` / `CloudGrid.tsx` — the realtime grid: reads via `useQuery`,
  writes via Convex mutations.
- `WorkspaceSettings.tsx` / `invite.ts` — members list and the invite → seat
  gate → upgrade flow.
- `useWorkspaceCredentials.ts` / `credentials.ts` — workspace-scoped shared keys.

## Execution stays local

The cloud only stores and syncs data. The engine `GridStore` abstraction
(`packages/engine/src/store.ts`) has two implementations:

- `SqliteGridStore` — thin wrapper over the synchronous `Db` (local projects;
  behaviour unchanged, regression-tested for parity).
- `ConvexGridStore` (`store-convex.ts`) — a Convex-client-backed store used for
  cloud projects.

When a column runs on a cloud project, the sidecar
(`packages/server/src/cloud-run.ts`) builds an `Engine` over the
`ConvexGridStore`: it reads inputs from Convex, runs the QuickJS sandbox +
connector HTTP calls **on the user's machine**, and writes status/results back
via the `cells.setCell` / `cells.setCellStatus` mutations. No engine ever runs
in the cloud. The engine package never imports `convex/_generated`, so its build
does not depend on codegen.

## Seats billing (Autumn)

Subscriptions are **seat-based**, metered per workspace via
[Autumn](https://useautumn.com) (Stripe underneath), with **no** connector/table
caps. The pure, unit-tested logic is in `packages/cloud/src/seats.ts`
(`SEATS_FEATURE_ID = "seats"`); the Convex bridge is `convex/model/seats.ts`,
which builds the Autumn client from `AUTUMN_SECRET_KEY`.

- Inviting a member runs an Autumn `check` on the `seats` feature.
- A free seat → the invite proceeds (and `track`s usage).
- Over the limit → returns the Autumn `checkout` URL; the desktop opens it as an
  upgrade modal. Completing checkout flips the entitlement and the invite then
  succeeds.

## Shared team credentials

Workspace connector keys are stored in the Convex `credentials` table, encrypted
at rest. The scheme is envelope encryption: a per-workspace data key wrapped by a
backend **master key** read from `CREDENTIALS_MASTER_KEY` (a 32-byte KEK on the
Convex deployment). Plaintext is only ever decrypted in the trusted run path —
never exposed to other members' clients. Domain logic in
`packages/cloud/src/crypto.ts` reads the key through an Effect `Layer` port so it
never touches `process.env` directly; `convex/model/crypto.ts` provides the live
layer. Local projects keep the existing machine-local `~/.gtmgrid/key`
AES-256-GCM model in `packages/engine/src/crypto.ts`, untouched.

## Effect-TS for business logic

All new client and cloud business logic (auth/cloud-run orchestration, seats,
membership, encryption, the grid stores) is built with Effect — typed errors +
`Layer`-based dependency injection — and unit-tested by providing test `Layer`s
instead of mocks. React rendering stays plain React; Convex handlers stay Convex
handlers, running their business logic as Effect via `Effect.runPromise` with
`ctx` injected through a `Layer`.

## Convex backend surface

`convex/schema.ts` mirrors the engine model as workspace-scoped tables
(`workspaces`, `members`, `projects`, `tables`, `columns`, `rows`, `cells`,
`extensions`, `credentials`) with indexes for reactive queries. Functions:

- **Queries (reactive):** `me` (user + workspaces + plan/seat usage),
  `listProjects`, `getTable`, `listExtensions`, workspace credentials.
- **Mutations:** `createWorkspace`, `inviteMember`, project/table CRUD,
  `addColumn`, `addRow`, `setCell`, `setCellStatus`, delete row/column/table,
  `saveExtension`, `saveCredential`.
- **Actions:** Autumn `checkout`; the credential decrypt-for-run path.

Workspace membership (`requireMember`) is enforced in every function, so a user
only ever sees workspaces they belong to.

## Web OAuth sign-in (GitHub + Google)

Sign-in supports email + password (always on) and **OAuth via the standard
Convex Auth web redirect flow** for GitHub and Google. Each provider is
registered in `convex/auth.ts` **only when its credentials are present** on the
deployment, so the deployment builds and `npx convex dev --once` stays green with
no OAuth secrets set — an unconfigured provider is simply not registered.

The client reads the public `auth.enabledProviders` query (booleans only, never
secrets) and renders one OAuth button per enabled provider in both the onboarding
flow and the AccountBar sign-in section; when no provider is enabled the OAuth row
and its divider are hidden entirely.

**Deployment env (set on the Convex deployment to enable a provider):**

| Variable | Provider | Notes |
| --- | --- | --- |
| `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` | GitHub | both required; either missing → GitHub disabled |
| `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` | Google | both required; either missing → Google disabled |
| `SITE_URL` | (shared) | redirect return URL, e.g. `http://localhost:5173` in dev |

**OAuth-app callback URL** — register this in each provider's OAuth app
(substitute `<provider>` with `github` or `google`):

```
https://capable-peccary-527.convex.site/api/auth/callback/<provider>
```

The flow is: client calls `signIn(provider)` → browser redirects to the provider
→ provider redirects to the Convex callback above → Convex redirects back to
`SITE_URL`, where the auth provider auto-reads the `code` from the URL. This is
the **web/browser** path and needs no Tauri deep-link.

## Packaged-desktop OAuth (native deep-link callback, C29)

The web redirect cannot complete inside a packaged Tauri webview (no shared
browser session, nowhere to land the redirect). The packaged app therefore uses
the documented Convex Auth desktop/RN pattern over a **custom URL scheme**:

1. The button calls `signIn(provider, { redirectTo: "gtmgrid://auth/callback" })`,
   which returns a `{ redirect }` URL **without navigating**.
2. The app opens that URL in the user's **system browser** (Tauri opener plugin).
3. Provider → Convex callback → redirects to
   `gtmgrid://auth/callback?code=<code>`, which the OS routes back to the running
   app as a deep link.
4. A listener (the Rust-emitted `oauth-callback` Tauri event **and**
   `@tauri-apps/plugin-deep-link`'s `onOpenUrl`) extracts the `code` and calls
   `signIn(provider, { code })` to complete the session.

The runtime branch (web redirect vs. desktop deep-link) is chosen by a single
`isTauri()` helper. `ConvexAuthProvider` is mounted with
`shouldHandleCode={() => !isTauri()}` so the web build still auto-reads the code
from `window.location` while the desktop path does **not** double-handle it.

**Scheme + wiring (already configured):**

| Piece | Where | Value |
| --- | --- | --- |
| Custom scheme | `src-tauri/tauri.conf.json` → `plugins.deep-link.desktop.schemes` | `["gtmgrid"]` |
| Capabilities | `src-tauri/capabilities/default.json` | `deep-link:default`, `core:event:default`, `opener:default` |
| Rust plugins | `src-tauri/src/main.rs` | single-instance (init **before** deep-link), deep-link, opener |
| Allowed redirect | `convex/auth.ts` `callbacks.redirect` | permits `gtmgrid://` **in addition to** `SITE_URL` |

**Provider OAuth-app callback URLs are unchanged** — they still point at the
Convex callback (`https://<deployment>.convex.site/api/auth/callback/<provider>`);
only the *final* `redirectTo` differs (`gtmgrid://auth/callback`), and that
custom scheme is allow-listed by the `redirect` callback in `convex/auth.ts`.

> **Not verified here:** the live OAuth round-trip is **not** exercised by this
> change. It requires (a) real OAuth-app credentials set on the deployment
> (`AUTH_GITHUB_*` / `AUTH_GOOGLE_*`), and (b) a packaged build or `tauri dev`
> run so the OS can register and route the `gtmgrid://` scheme to a native
> window. The automated gate (`pnpm typecheck` + `pnpm test` + `cargo check`)
> covers the code-extraction parsing, the Tauri-vs-web branch selection, and that
> the Rust shell compiles — but the end-to-end browser → deep-link handshake is a
> manual check pending creds + a packaged run.

## Setup

The cloud tier reads these environment variables (names only — never commit
secret values):

| Variable | Where | Purpose |
| --- | --- | --- |
| `CONVEX_DEPLOYMENT` | `.env.local` (dev) | deployment `convex dev` binds to |
| `VITE_CONVEX_URL` | `.env.local` (desktop) | deploy URL the client connects to |
| `AUTUMN_SECRET_KEY` | Convex deployment env | server-side Autumn key for seats |
| `CREDENTIALS_MASTER_KEY` | Convex deployment env | 32-byte KEK for credential encryption |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | Convex deployment env | enable GitHub OAuth (optional) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Convex deployment env | enable Google OAuth (optional) |
| `SITE_URL` | Convex deployment env | OAuth redirect return URL |

OAuth providers are **optional**: with none of the `AUTH_*` vars set the
deployment still builds and deploys cleanly (the provider is not registered).

Generate the Convex client bindings before typechecking the cloud code — the
client imports `convex/_generated/*`, which only exists after a deployment login:

```bash
npx convex dev          # logs in, creates/binds a deployment, generates convex/_generated/
# or codegen only:
npx convex codegen
```

The OSS local-only build needs none of these: `convex/` is kept out of the root
`tsc -b` graph and an absent `VITE_CONVEX_URL` disables cloud in the client.

## Verification

`pnpm typecheck` and `pnpm test` cover the data path end-to-end (124 tests across
the engine, cloud, server, and desktop cloud modules). Live two-window
multiplayer (open the same cloud project in two windows; an edit / add-row /
column-run in one appears live in the other, statuses streaming to both) is a
**visual** check that requires a human Tauri run — it is **not** asserted by the
automated gate.

## Future Expansion

- **Web app** — the same React UI subscribes to Convex directly; the gaps are
  execution (local engine) and the in-app agent (local CLI).
- **Cloud execution of grids** — run columns in a cloud runtime; prerequisite
  for a web build and unattended runs.
- **Native deep-link OAuth** — both the web redirect (see "Web OAuth sign-in")
  and the **packaged-desktop deep-link callback** (see "Packaged-desktop OAuth")
  are implemented. The live round-trip still needs OAuth-app credentials + a
  packaged / `tauri dev` run to verify end-to-end.
- **Proxied managed-key connectors** — our keys + Autumn credit metering as an
  extra revenue lever.
- **Offline editing of cloud projects** with later reconciliation (Convex is
  online-first today).
