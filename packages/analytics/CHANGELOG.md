# @gtmgrid/analytics

## 1.5.2

## 1.5.1

## 1.5.0

## 1.4.0

## 1.3.0

## 1.2.1

## 1.2.0

## 1.1.1

## 1.1.0

## 1.0.6

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

## 0.22.12

## 0.22.11

## 0.22.10

## 0.22.9

## 0.22.8

## 0.22.7

## 0.22.6

## 0.22.5

## 0.22.4

## 0.22.3

### Patch Changes

- fbcb535: Make desktop engine (sidecar) failures observable, and stop the offline banner
  from showing end users a dev command.

  The desktop shell now reports the bundled engine's lifecycle to PostHog: every
  `spawn_sidecar` failure path emits `sidecar_spawn_failed`, and a new liveness
  monitor emits `sidecar_exited` (with exit code + a tail of the captured stderr)
  when the engine dies unexpectedly soon after launch — e.g. a native module that
  won't load on a user's OS/arch. Previously these only `eprintln!`d to a stderr
  the packaged app discards, so a dead engine was invisible until a user reported
  it. The renderer's boot poll now emits `server_ready` (with cold-start time) and
  `server_unreachable` (once a sustained failure passes the cold-start grace), and
  every desktop event carries a `platform: "desktop"` super-property so desktop
  health is filterable/alertable.

  The "Server not reachable" banner no longer tells packaged users to run
  `pnpm --filter @gtmgrid/server dev` (that command only exists in a dev checkout).
  Packaged builds show a calm "Starting the local engine…" during a normal cold
  start, escalating to a real recovery message with a "Copy diagnostics" button
  only if the engine stays down.

## 0.22.2

### Patch Changes

- 325e90b: Track new signups server-side. Better Auth account creation now captures a
  `user_signed_up` PostHog event from the `user.create.after` hook, keyed on the
  user id (the same distinct id the desktop client identifies with) and `$set`ting
  the person's email/name. Previously a signup only became an identified person if
  and when the desktop client's identify bridge ran, so accounts created without
  that (older build, analytics disabled, web/invite-only flows) stayed anonymous.

## 0.22.1

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

## 0.19.1

## 0.19.0

## 0.18.0

## 0.17.4

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.2

## 0.16.1

## 0.16.0

### Minor Changes

- 735d94c: Full PostHog Error Tracking observability so bugs surface as they occur. All telemetry now points at the GTM Grid **US** project (`us.i.posthog.com`). New `@gtmgrid/observability` package shares one error-tracking + structured-logging convention across the sidecar, MCP server, and CLI (process-level crash handlers + exception capture).

  Closed the remaining blind spots:
  - **Engine run failures** — connector/AI/enrichment errors now feed Error Tracking via an injected, dependency-free `reportError` hook on the engine, **deduped per run** (a large run with one failure mode raises one exception, not thousands), plus a `column_run_failed` analytics event for failure-rate dashboards.
  - **tRPC** — non-typed defects keep their original stack (attached as the `TRPCError` cause) instead of being flattened to a string.
  - **Services** — a new injectable `ErrorReporter` port surfaces deliberately-swallowed best-effort failures (e.g. a failed invite email) without coupling the package to a telemetry client.
  - **Signals** — per-binding sync/warm-up failures in the cron worker are now reported (previously `console.error` only).
  - **Desktop shell** — a Rust panic hook reports Tauri-side panics (sidecar spawn, updater, window setup) to Error Tracking.
  - **PartyKit** — realtime handlers capture unexpected exceptions.

  No behaviour change when PostHog is unconfigured — every surface no-ops without a key.

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0
