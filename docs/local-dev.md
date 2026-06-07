# Local development — cloud tier (Supabase + Drizzle + Better Auth + tRPC)

Bring up the full cloud stack against a local Supabase (Docker). Validated end-to-end
on 2026-06-07 (TRI-3259).

## Prerequisites
- Docker running
- Supabase CLI (`brew install supabase`)
- `pnpm install`

## 1. Start Supabase
```bash
supabase init      # once; creates supabase/config.toml
supabase start     # pulls images on first run
supabase status    # note the DB URL + keys
```
Default ports: API `54321`, DB `54322`, Studio `54323`. **If another Supabase project is
already running**, those ports collide — bump this project's ports in `supabase/config.toml`
(e.g. the `544xx` range) before `supabase start`.

## 2. Env
Create `apps/web/.env.local` (server) — see `.env.example` for the full list. Minimum:
```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres   # direct local; prepare:false is harmless
SITE_URL=http://localhost:3000
INVITE_BASE_URL=http://localhost:3000
SUPABASE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long   # local default
SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable key from `supabase status`>
WEBHOOK_WORKER_SECRET=$(openssl rand -hex 24)
CREDENTIALS_MASTER_KEY=$(openssl rand -hex 32)
# AUTH_RESEND_KEY / AUTUMN_SECRET_KEY left empty locally: email no-ops; billing/seats (Autumn) need a sandbox key
```
And `packages/desktop/.env.local` (Vite): `VITE_API_URL=http://localhost:3000`,
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.

## 3. Migrate
```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm -F @gtmgrid/db db:migrate
```

## 4. Run
```bash
pnpm -F @gtmgrid/web dev        # tRPC API + Better Auth + worker endpoints on :3000
GTMGRID_PROJECT=default pnpm server   # engine sidecar (local grids)
pnpm desktop                    # or: pnpm tauri:dev (native window)
```

## Notes / gotchas (from the E2E)
- **better-auth + kysely:** `@better-auth/kysely-adapter` imports `DEFAULT_MIGRATION_TABLE`,
  which `kysely@0.29` dropped from its root export. Fixed via a pnpm patch
  (`patches/kysely@0.29.2.patch`) that re-exports it, plus `pnpm.overrides.kysely` pinning a
  single version, plus `serverExternalPackages` for the `@better-auth/*` scope in `next.config.ts`.
- **Auth timestamps:** the Better Auth tables (`users`/`sessions`/`accounts`/`verifications`)
  use `timestamptz`; the domain tables keep `bigint` epoch-ms.
- Email (Resend) and billing/seats (Autumn) are external — flows that need them (verification
  email, invite seat-gate, checkout) require real keys; locally they no-op or error.
