# AGENTS.md

Operational notes for AI agents (and humans) working in this repo.

## Verification flow

- **Every new user-facing desktop feature ships an Electron E2E test.** Add a
  Playwright spec under `packages/desktop/e2e/` that drives the real built app.
  Unit/component coverage is welcome, but it does not replace the E2E.
- **Run Electron E2E locally in the background before opening a PR.** Use
  `pnpm e2e:background`; it detaches the long run and writes its output under the
  ignored `.gtmgrid/e2e/` directory, so the active agent turn and user are not
  blocked by Playwright output. Continue useful work, then use
  `pnpm e2e:status`. Only inspect `pnpm e2e:log` when progress or a failure needs
  diagnosis. The launcher refuses to overlap two runs in one worktree.
- `listing-shots.spec.ts` is an asset-generation task, not verification. It is
  excluded from normal E2E because it overwrites tracked marketing images; run
  it explicitly with `pnpm --filter @gtmgrid/desktop e2e:listing-shots`.
- **Electron E2E is deliberately local-only, not a GitHub Actions gate.** CI
  keeps the fast `pnpm lint`, `pnpm typecheck`, `pnpm test`, and web-build gates;
  releases repeat the code checks. A PR containing a user-facing desktop feature
  is not ready until its detached local E2E run reports `passed`.

## Running the desktop app against **staging** (Electron → staging backend)

Use this for OAuth work. Staging has its **own database** (Supabase branch) and its
**own OAuth apps**, so you can connect, disconnect and break things without
touching production data or production grants.

| | staging | production |
|---|---|---|
| Backend | `https://staging.gtmgrid.dev` | `https://www.gtmgrid.dev` |
| Git branch | `staging` | `main` |
| Database | Supabase branch `pkbxzbnkpwjawifnlrct` | `fmzqedfoqhdzpdsguvci` |
| Vercel env | custom environment `staging` | Production |

### Build the PACKAGED app (what you want for OAuth)

`electron:pack` — not the un-packaged run below — because the OAuth callback
bounces the browser back through a `gtmgrid://` deep link, and that protocol only
registers with the OS for a **packaged** app. Un-packaged, consent completes but
the hand-back silently does nothing and the connect card just keeps polling.

```bash
cd packages/desktop
VITE_API_URL="https://staging.gtmgrid.dev" \
VITE_INNGEST_URL="https://staging.gtmgrid.dev" \
VITE_PARTY_URL="" \
VITE_POSTHOG_KEY="" \
CSC_IDENTITY_AUTO_DISCOVERY=false \
pnpm electron:pack           # → packages/desktop/release/mac-arm64/GTM Grid.app
```

`VITE_PARTY_URL` is deliberately EMPTY: staging has no PartyKit deployment, and
the renderer treats it as optional (`|| undefined`), so realtime multiplayer is
simply inactive. Everything else — auth, grids, columns, OAuth — works.
`CSC_IDENTITY_AUTO_DISCOVERY=false` skips code signing, which you do not have
certs for locally and do not need for a local test build.

**The endpoints are baked in at BUILD time.** There is no runtime switch: a
staging app and a production app are different binaries. If the app is talking to
the wrong backend, you rebuilt with the wrong `VITE_API_URL` — check
DevTools → Network, not the app's settings.

### ⚠️ `electron:pack` BREAKS the shared node_modules — repair it afterwards

Not a theoretical risk. Verified: after `electron:pack`, `pnpm test` fails with

```
.pnpm/better-sqlite3@11.10.0/.../better_sqlite3.node
NODE_MODULE_VERSION 130   ← Electron 33's ABI
requires NODE_MODULE_VERSION 127   ← Node 22
```

`electron:bundle` runs `electron-rebuild -f -w better-sqlite3 -m sidecar`. The
`-m sidecar` flag LOOKS like it confines the rebuild to
`packages/desktop/sidecar/` (which has its own `npm install`), and that reasoning
is wrong: electron-rebuild follows the symlink chain back into the pnpm store at
`~/repos/gtm-grid/node_modules/.pnpm/` and rebuilds THAT copy for Electron's ABI.

That store is shared by every worktree via a `node_modules` symlink, so one
`electron:pack` breaks `pnpm test` and `pnpm server` in this worktree AND in every
sibling worktree, until repaired.

**Repair (required after every `electron:pack`):**

```bash
D=~/repos/gtm-grid/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3
rm -rf "$D/build"                       # the Electron-ABI binary
( cd "$D" && npx prebuild-install --runtime=node --target=$(node -p "process.versions.node") )
pnpm test                               # confirm green again
```

`pnpm rebuild better-sqlite3` does **not** fix it — `prebuild-install` no-ops when
`build/` already exists, so it reports "Done" while leaving the Electron binary in
place. The `rm -rf build` is the load-bearing step.

Only the packaged build does this. `pnpm build` (renderer only) and
`pnpm electron:dev` are safe.

### Signing in

Staging's database is EMPTY — no accounts carry over from production. Sign up
fresh, then create a workspace before opening Tools.

Email OTP works. Google OAuth needs `AUTH_GOOGLE_*` on the staging environment;
if it is unset, use email OTP.

### Testing the Slack connection

1. **Tools → Slack.** The Connect button must be **enabled**. If it reads
   "Slack isn't set up on this deployment yet", `SLACK_CLIENT_ID` is missing from
   the staging environment — that copy means *not configured*, which is a
   different failure from *not connected*.
2. **Connect** → system browser → Slack consent → the page hands back via
   `gtmgrid://open` and the card converges to `Connected · <team>`.
3. Add a `slack.postMessage` column; the channel picker populates from
   `conversations.list`.

The redirect URI is derived from the **backend's** `SITE_URL`, not the app's —
so it must match the Slack app's registered redirect exactly. See `docs/slack.md`.

### Rebuilding after a backend change

The renderer bakes in endpoints, but all logic lives server-side. After pushing to
the `staging` branch, wait for the Vercel deploy — you do **not** need to rebuild
the app unless you changed `packages/desktop/`.

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
