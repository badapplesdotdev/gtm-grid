# AGENTS.md

Operational notes for AI agents (and humans) working in this repo.

## Running a local **prod** build of the desktop app (Electron → prod backend)

Goal: build the Electron desktop renderer as a production bundle, point it at the
**production** cloud backend (so you can sign in and inspect real data/UI), and run
it without a full `electron-builder` package.

The two non-obvious gotchas this procedure solves:

1. **Renderer URL** — `electron/main.ts` uses `DEV = !app.isPackaged`, so running an
   un-packaged Electron loads the Vite **dev server** (`localhost:5173`), not your
   built bundle. Override with `GTMGRID_RENDERER_URL=app://gtmgrid/index.html` to load
   the built `dist/` via the app's own privileged `app://` protocol handler.
2. **Engine CORS origin** — the desktop app gates boot on the local engine sidecar's
   `/api/health`. The engine (`packages/server`) allowlists browser `Origin`s
   (`packages/server/src/cors.ts`); the packaged app passes `GTMGRID_ALLOWED_ORIGINS=app://gtmgrid`
   to it, but a standalone/un-packaged engine does **not**, so the renderer's fetch
   from `app://gtmgrid` gets a **403** and you get stuck on
   "GTM Grid couldn't start its engine". Start the engine with that origin allowed.

### Prerequisites
- Vercel CLI authenticated (`vercel whoami`).
- The deployable web project is **`bad-apples/gtm-grid-web`** (live at www.gtmgrid.dev).
  Note: a sibling project named `gtm-grid` exists but is an empty placeholder — do
  **not** use it.
- `pnpm install` has run in this worktree (native deps like `better-sqlite3` built).

### 1. Pull the prod env / public URLs from Vercel
```bash
vercel link --yes --scope bad-apples --project gtm-grid-web
vercel pull --yes --environment=production --scope bad-apples   # → .vercel/.env.production.local (gitignored)
```
The desktop renderer only needs these (public) values, read from the pulled file:
- `SITE_URL`            → `VITE_API_URL`   (e.g. `https://www.gtmgrid.dev`)
- `PARTY_URL`           → `VITE_PARTY_URL` (PartyKit realtime)
- `NEXT_PUBLIC_POSTHOG_HOST` / `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` → `VITE_POSTHOG_HOST` / `VITE_POSTHOG_KEY` (optional; leave key empty to disable analytics)

> `.vercel/` is gitignored — never commit the pulled secrets.

### 2. Build the prod renderer (endpoints baked in at build time)
```bash
cd packages/desktop
VITE_API_URL="https://www.gtmgrid.dev" \
VITE_PARTY_URL="https://gtmgrid-party.iammorganparry.partykit.dev" \
VITE_INNGEST_URL="https://www.gtmgrid.dev" \
VITE_POSTHOG_HOST="https://us.i.posthog.com" \
VITE_POSTHOG_KEY="" \
pnpm build            # → packages/desktop/dist/  (VITE_API_URL is REQUIRED; build fails without it)

pnpm electron:main    # compiles electron/main.ts → build/electron/main.cjs
```

### 3. Start the local engine sidecar WITH the app origin allowlisted
```bash
cd packages/server
GTMGRID_PORT=8787 GTMGRID_ALLOWED_ORIGINS="app://gtmgrid" pnpm exec tsx src/index.ts &
# verify: curl -H "Origin: app://gtmgrid" http://127.0.0.1:8787/api/health  → 200 + access-control-allow-origin: app://gtmgrid
```

### 4. Launch Electron pointed at the built prod renderer
```bash
cd packages/desktop
GTMGRID_RENDERER_URL="app://gtmgrid/index.html" pnpm exec electron build/electron/main.cjs &
```
The app's background health poll flips it from the engine-error screen to the shell
as soon as step 3 is reachable (or click **Retry**).

### Signing in
Use **email OTP** (enter email → type the code) — it works in this un-packaged run.
Google OAuth *may* fail because its `gtmgrid://` deep-link callback isn't guaranteed
to register with the OS outside a packaged app; fall back to email OTP.

### Caveats
- This points at the **live production database** — in-app edits are real.
- The local engine only backs *local* column runs; all cloud data/auth goes to prod.
- For a double-clickable, fully self-contained build (bundled sidecar, working OAuth
  deep-links, no separate engine process), use `pnpm electron:pack` instead — heavier
  (native rebuild + electron-builder), but it's the real installable artifact.

### Stop everything
```bash
pkill -f "build/electron/main.cjs"   # quit the app
pkill -f "tsx src/index.ts"          # stop the local engine
```
