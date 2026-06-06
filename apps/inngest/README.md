# @gtmgrid/inngest

Headless Next.js (App Router) worker app for GTM Grid webhooks. It has two API
surfaces and no real UI:

- **`POST /api/webhooks/[token]`** — the public webhook receiver. Resolves the
  token against the secret-gated Convex `/webhook/resolveToken` route, verifies
  the `X-GTMGrid-Signature` HMAC-SHA256 header against the webhook's signing
  secret over the raw body, applies the stored field mapping
  (`[{ path, columnId }]`) to the JSON payload, computes an idempotent
  `recordId`, enqueues a `webhook/record.received` Inngest event, and returns
  `202`.
- **`GET|POST|PUT /api/inngest`** — the Inngest serve endpoint, registering the
  durable `process-webhook-record` function.

The durable function inserts (or upserts) one row via the Convex worker routes,
then — when the webhook's `autoRun` is on — recomputes the table's function
columns over just the new row using `@gtmgrid/engine` directly (the same cloud
run path as the desktop sidecar, with the Convex client pointed at the
secret-gated `/webhook/*` routes). The engine runs **Db-free** on this path, so
`better-sqlite3` is never loaded; `quickjs-emscripten` (WASM) runs fine on Node.

## Why this app is isolated from the root build

It is intentionally OUT of the root `tsc -b` (`tsconfig.json` references only the
`packages/*` libraries) and out of the root `vitest` (the root config only globs
`packages/*/vitest.config.ts`), mirroring how `packages/desktop` and `convex/`
are typechecked/tested separately. Root `pnpm lint` only targets `packages
convex`. Verify this app with:

```
pnpm --filter @gtmgrid/inngest build      # next build
pnpm --filter @gtmgrid/inngest typecheck  # tsc --noEmit
```

## Environment variables

| Var | Purpose |
| --- | --- |
| `CONVEX_URL` | The Convex deployment URL (`https://<name>.convex.cloud`). |
| `CONVEX_SITE_URL` | The Convex HTTP actions origin (`https://<name>.convex.site`) the worker POSTs the `/webhook/*` routes to. |
| `WEBHOOK_WORKER_SECRET` | Shared bearer secret authenticating this worker to the Convex `/webhook/*` routes. Must match the value set on the Convex deployment. |
| `INNGEST_EVENT_KEY` | Inngest event key used to `inngest.send(...)` (not needed against the local dev server). |
| `INNGEST_SIGNING_KEY` | Inngest signing key the serve endpoint uses to verify requests (not needed against the local dev server). |

If enrichment needs AI columns, also set the relevant provider key the engine
reads (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`, plus
optionally `GTMGRID_AI_MODEL`).

No secrets are committed. Provide all of the above via the deployment's
environment (Vercel project settings / `.env.local` for local dev).

## Local development

```
pnpm --filter @gtmgrid/inngest dev      # Next dev server on :3000
npx inngest-cli@latest dev              # Inngest dev server (separate terminal)
```

Then POST a signed payload to `http://localhost:3000/api/webhooks/<token>` with
an `X-GTMGrid-Signature: <hex hmac>` header.
