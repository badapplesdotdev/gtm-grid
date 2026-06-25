# @gtmgrid/analytics

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
