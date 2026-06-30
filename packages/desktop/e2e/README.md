# Desktop E2E suite (Playwright + Electron)

End-to-end tests that launch the **real** Electron app (`build/electron/main.cjs`)
via Playwright's `_electron` API and drive it against a **mock cloud** — so the
whole stack runs hermetically with no live `apps/web`, Postgres, auth provider,
or PartyKit.

## Run

```bash
# from the repo root or packages/desktop
pnpm --filter @gtmgrid/desktop e2e          # build + run everything
pnpm --filter @gtmgrid/desktop e2e:fast     # reuse the existing build (SKIP_E2E_BUILD=1)
pnpm --filter @gtmgrid/desktop e2e:report   # open the last HTML report
```

A real Electron window opens during the run. On a headless machine/CI, wrap it
in a virtual display: `xvfb-run -a pnpm --filter @gtmgrid/desktop e2e` (see
`.github/workflows/ci.yml`, the `e2e` job).

## How it works

The app is **cloud-only** (tRPC + Better Auth against `VITE_API_URL`) with no
offline bypass, so to drive it we stand up a single mock origin and point the
build at it:

- **`config.mjs`** — one fixed port (`53847`). The renderer build bakes
  `VITE_API_URL`/`VITE_API` → `http://localhost:53847`; the mock serves the
  renderer *and* the APIs from that origin (so there is no CORS), and the window
  is pointed at it via the `GTMGRID_RENDERER_URL` hook in `electron/main.ts`.
- **`mock/state.mjs`** — the seeded world (one workspace, one project, one
  `Leads` table with two columns + two rows) and the auth/`me`/table payloads.
- **`mock/trpc.mjs`** — a stateful tRPC procedure table. Writes (set-cell,
  add-row, add-column, create-table, …) **persist**, so a mutation is visible on
  the renderer's follow-up refetch — and assertable via `mockState()`.
- **`mock/server.mjs`** — one HTTP server: static renderer + Better Auth +
  batched tRPC + the engine `/api/health|functions|…` + a `/__test/reset`
  control endpoint.
- **`global-setup.ts` / `global-teardown.ts`** — build `dist-e2e/` + the Electron
  main, start/stop the mock.
- **`fixtures.ts`** — `launchApp(scenario)` resets the mock to a scenario
  (`{ signedIn, paid }`), then launches Electron with an isolated user-data dir.

## Coverage

| Spec | What it proves |
|------|----------------|
| `shell.spec.ts` | Real main process: single window, full preload bridge, `sidecarDiagnostics`/`stopSidecar` IPC, `app://` protocol, deep-link OAuth + update IPC delivery |
| `boot.spec.ts` | Boot gate: signed-out auth gate, signed-in paid shell, free-plan cloud-locked state, sign-in→shell transition |
| `grid.spec.ts` | Grid render, sidebar/plan, **cell edit persists**, add row, add-column UI, command palette, agent panel |
| `nav.spec.ts` | Account menu, notification center, project switcher, new-table chooser, **blank-table create end-to-end**, workspace settings |
| `trial.spec.ts` | Trial lifecycle: active-trial shell + countdown, fresh-trial welcome, **expired-by-date hard lock (plan id still "team", not yet synced)**, expired+synced lock, low-cloud-actions warning, upgrade-prompt funnel → Plan & billing modal |

The renderer's pure business logic (CSV import/export, grid run/dep-order,
table tree, presence, keyboard nav, notifications, etc.) is covered separately by
the Vitest unit suites next to the source in `src/`.
