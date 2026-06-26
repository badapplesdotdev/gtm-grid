---
"@gtmgrid/desktop": patch
---

Make "Copy diagnostics" self-report a dead engine. When the sidecar fails to
start, telemetry has been silent on some Windows machines, leaving us to guess at
the cause. The renderer previously had no visibility into the engine's boot at
all — and its version line read a never-set env var, so every build showed
"(dev)".

The Tauri shell now records boot facts in every spawn branch (including failures)
and exposes them via a new `sidecar_diagnostics` command: real installed version,
OS/arch, resolved node/server paths and whether they exist, the spawn outcome
(`spawned` / `dir_missing` / `binary_missing` / `spawn_error` / `exited`), any
early-exit code, and the engine's OWN captured stderr — i.e. the actual crash.
"Copy diagnostics" folds all of this in, so a stuck user's paste now contains the
root cause instead of just `engine: unreachable`. The version line is fixed to use
the real build version.
