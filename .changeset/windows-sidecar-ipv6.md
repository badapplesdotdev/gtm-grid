---
"@gtmgrid/desktop": patch
"@gtmgrid/server": patch
"@gtmgrid/observability": patch
---

Fix the Windows "Server not reachable" / engine-unreachable failure: connect the
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
