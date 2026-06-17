# Supabase — Agent Skill
> Query and manage your Supabase Postgres projects through the Management API — run arbitrary SQL (the way you read table rows here), apply migrations, generate types, and manage projects, edge functions, secrets, storage and branches. The right tool when a grid column needs data read straight out of a Supabase database, or a project/function/secret managed.

## When to use
- **Query / inspect Postgres:** run SQL against a project's database with `supabase.runQuery` (or `runQueryReadOnly`) — list tables, read rows, aggregate, join. This is how you read table data through the Management API.
- **Manage the database:** apply/list migrations, generate TypeScript types, enable webhooks, inspect pooler/Postgres config.
- **Manage projects & org:** list/get/create/delete/pause/restore projects, read API keys and PostgREST/Auth/Storage config, list organizations and members.
- **Manage functions, secrets, storage, branches:** CRUD Edge Functions, set/delete env secrets, list Storage buckets, create/delete preview branches.
- **Important:** this is the **Management API** authenticated with a **Personal Access Token** — it is NOT the per-project anon/service-role data API (PostgREST at `https://<ref>.supabase.co`). To read or write table rows, you run SQL via `runQuery`, not REST table calls. There is no per-project PostgREST surface in this connector.

## Auth & cost
- **Base URL:** `https://api.supabase.com`. Auth is `Authorization: Bearer <PAT>` — a **Personal Access Token** (starts `sbp_...`). Create one at supabase.com/dashboard/account/tokens. The manifest injects it from the `apiKey` secret.
- **The `{ref}` project ref is in nearly every project path.** It's the 20-char project id you see in the dashboard URL (`app.supabase.com/project/<ref>`) — get it from `supabase.listProjects` / `listOrganizationProjects` if you don't already have it.
- **Rate limits:** **120 requests/min**, tracked separately per project and per organization (manifest sets connector `rateLimit: { rpm: 120, concurrency: 3 }`). A few endpoints are stricter — `getDatabaseContext` (`GET .../database/context`) is capped at **10/min and 1/sec**, so it carries a per-method `rateLimit: { rpm: 10, rps: 1 }` override. Reads are credits 0; create/update/delete/`runQuery`/`applyMigration` are credits 1 (`runQuery` can mutate). Back off on `429` using the `X-RateLimit-Reset` header.
- **Picker fields (live options):** `ref` (project ref — on ~30 methods like `runQuery`, `getProject`, `createBranch`) is populated from `listProjects` (label = project `name`, value = `id`, sublabel = `status`). `slug` (org slug — on `getOrganization`, `listOrganizationMembers`, `listOrganizationProjects`) and `createProject.organization_slug` are populated from `listOrganizations` (label = org `name`, value = `slug`). Other id-ish path params (`function_slug`, `branch_id_or_ref`, snippet `id`) are NOT wired to pickers because enumerating them first needs a chosen `ref`, which the static-args options resolver can't supply.
- **Most common entry points:** `supabase.runQuery` (SQL → rows), `supabase.listProjects` (find a `ref`), and `supabase.getDatabaseContext` (schema before writing SQL).

## Endpoints by job

**Query the database (SQL) — the star**
- `supabase.runQuery` — ★ run any SQL on a project's Postgres and get rows back. Inputs: `ref` (required), `query` (required, the SQL string), `read_only?`. Runs as `postgres`, so it can read AND mutate.
- `supabase.runQueryReadOnly` — same, but in a guaranteed read-only transaction (writes rejected). Safer for SELECTs. Free.
- `supabase.getDatabaseContext` — compact schema/table/column listing to plan SQL.
- `supabase.listMigrations` / `applyMigration` / `upsertMigration` — migration history + apply new migrations.
- `supabase.getTypescriptTypes` — generate TS types for the schema (`included_schemas?`).
- `supabase.enableWebhooks`, `getPgbouncerConfig`, `getPoolerConfig`, `getPostgresConfig` — db config/pooler.

**Projects**
- `supabase.listProjects` / `getProject` — discover projects and their `ref`.
- `supabase.createProject` (`name`, `organization_slug`, `db_pass` required) / `deleteProject`.
- `supabase.pauseProject` / `restoreProject` / `getProjectHealth`.
- `supabase.listApiKeys` (`reveal?`) / `createApiKey`, plus `getPostgrestConfig`, `getAuthConfig`, `getStorageConfig`, `availableRegions`.

**Organizations**
- `supabase.listOrganizations` / `getOrganization` / `createOrganization`.
- `supabase.listOrganizationMembers` / `listOrganizationProjects`.

**Secrets & config**
- `supabase.listSecrets` — names (values masked).
- `supabase.createSecrets` — body is an array of `{ name, value }`. `deleteSecrets` — body is an array of name strings.

**Edge functions**
- `supabase.listFunctions` / `getFunction` / `getFunctionBody`.
- `supabase.createFunction` (`slug`, `name`, `body` required) / `updateFunction` / `deleteFunction`.

**Storage**
- `supabase.listBuckets` — the project's Storage buckets.

**Branches (preview environments)**
- `supabase.listBranches` / `createBranch` (`branch_name` required) / `getBranch` / `deleteBranch`.

**Snippets & account**
- `supabase.listSnippets` / `getSnippet` — saved SQL Editor queries (re-run via `runQuery`).
- `supabase.getProfile` — confirm the PAT works.

## Recipes
1. **List the tables in a project**
   - `supabase.runQuery` with `{ "ref": "{{Project Ref}}", "query": "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name", "read_only": true }` → one row per table.

2. **Read rows for a value from a grid column**
   - `supabase.runQuery` with `{ "ref": "{{Project Ref}}", "query": "SELECT id, name, plan FROM users WHERE email = '{{Email}}' LIMIT 50", "read_only": true }`. Quote/escape `{{Email}}` so a stray apostrophe can't break (or inject) the SQL.

3. **Find the project ref first, then query it**
   1. `supabase.listProjects` → pick the project, grab its `id` (that's the `ref`); `add_rows` with each ref if fanning out.
   2. `supabase.getDatabaseContext` with `{ "ref": "{{Project Ref}}" }` to see the schema.
   3. `supabase.runQuery` with the `ref` + your SELECT to pull the data into the grid.

4. **Aggregate a metric per account**
   - `supabase.runQuery` with `{ "ref": "{{Project Ref}}", "query": "SELECT count(*) AS orders, coalesce(sum(amount),0) AS revenue FROM orders WHERE account_id = '{{Account ID}}'", "read_only": true }` → write `orders`/`revenue` back to the row.

## Gotchas
- **Management API only — no per-project PostgREST here.** This connector's single `baseUrl` is `https://api.supabase.com`; the data API lives at `https://<ref>.supabase.co`, which isn't reachable through it. To read/write table rows, use `runQuery` (SQL), not REST table endpoints.
- **`runQuery` runs as the `postgres` superuser role and CAN mutate.** A bad `query` can DELETE/DROP. Default to `read_only: true` (or `runQueryReadOnly`) for any read; only drop read-only when you intentionally mean to write.
- **Escape values pulled from columns to avoid SQL injection.** `{{Column}}` templates are interpolated as plain text — quote string values, and prefer the `parameters` array for untrusted input rather than string-concatenating it into `query`.
- **`{ref}` must be the project ref string** (the 20-char id from the dashboard URL / `listProjects`), not the project name or display label. Branch endpoints (`getBranch`/`deleteBranch`) take `branch_id_or_ref` instead.
- **PAT scopes & expiry.** A `401` means a missing/invalid/expired Personal Access Token (`sbp_...`), or one without the scope for that resource — regenerate at the dashboard tokens page. This is a token issue, not a per-project anon-key issue.
- **Rate limits 120/min per project & per org.** `getDatabaseContext` is much stricter (10/min, 1/sec). Batch large fan-outs and back off on `429`.
- **SQL must be a single string** in the `query` body field — a multi-statement script is fine, but it's one `query` value, not an array. `createSecrets`/`deleteSecrets` bodies are arrays (of `{name,value}` / of names).
- Docs: https://supabase.com/docs/reference/api (OpenAPI at https://api.supabase.com/api/v1-json).
