---
"@gtmgrid/desktop": minor
"@gtmgrid/server": minor
"@gtmgrid/services": minor
"@gtmgrid/engine": minor
"@gtmgrid/mcp": minor
"@gtmgrid/web": minor
---

Remove the "local" paradigm — Postgres is now the only source of truth.

GTM Grid was built local-first: each project was a `better-sqlite3` `.db` file served by the desktop sidecar, with cloud (Postgres) as an optional team tier. That produced two parallel data worlds and pervasive local-vs-cloud branching. This change removes the local paradigm entirely:

- **Single data path.** The execution engine is always cloud-store-backed (`new Engine(config, registry, { store, creds })`); the SQLite `GridStore` layers, the engine's grid tables, the desktop's local `DataGrid`/`inCloud` fork, and the sidecar's local grid CRUD routes are gone. Every grid table operation goes through Postgres via tRPC. The one-way local→cloud push/sync apparatus and the `@gtmgrid/cli` package are deleted.
- **The sidecar stays as the execution host.** It still runs connector/AI/formula columns locally and keeps a small **secrets-only** local vault (encrypted connector/AI keys, extension manifests) — but it no longer owns grid data; it proxies grid I/O to the `apps/web` worker endpoints. A new `/api/cloud/preview-function` route powers "Try on N rows" against cloud data.
- **Login required.** `VITE_API_URL` is now mandatory (the build fails fast without it); the cloud/auth layer is always on; the "Continue locally — no account" escape hatches are removed; signed-out users hit a hard auth gate. Self-hosting = run your own Postgres + `apps/web`.
- **Optimistic UI on every mutation.** To keep the local-first *feel*, every cloud grid mutation now patches the React Query cache instantly and reconciles with the server. Inserts carry a client-supplied UUID so the optimistic id is the persisted id and the realtime self-echo converges idempotently instead of duplicating; failures roll back.

Note: the sidecar's local Trigify "signals" routes were local-grid-backed and have been removed pending a cloud-backed replacement (recurring signal refresh already runs as an Inngest cloud job).
