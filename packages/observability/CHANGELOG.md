# @gtmgrid/observability

## 1.6.1

## 1.6.0

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

### Patch Changes

- 8ddbed1: Fix the Windows "Server not reachable" / engine-unreachable failure: connect the
  renderer to the sidecar over `127.0.0.1` instead of `localhost`.

  The sidecar binds IPv4 loopback only (`server.listen(8787, "127.0.0.1")`), but the
  renderer + cloud-run defaulted to `http://localhost:8787`. On Windows `localhost`
  resolves to `::1` (IPv6) first, so the WebView2 fetch hit `[::1]:8787` where nothing
  listens and the engine read as unreachable — even though the server was up and
  healthy. macOS resolves `localhost`→`127.0.0.1`, which is why this only bit Windows.
  Defaulting to `127.0.0.1` deterministically matches the bind on every platform.

  Also adds a `sidecar_listening` server-side event (over the posthog-node channel,
  the only desktop telemetry path that delivers from packaged builds) tagged with
  platform/arch, so sidecar boot-health is finally visible per-OS — confirming the
  engine actually starts on Windows rather than leaving that invisible.

## 0.22.4

## 0.22.3

## 0.22.2

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
