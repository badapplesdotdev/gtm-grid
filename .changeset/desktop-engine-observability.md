---
"@gtmgrid/desktop": patch
"@gtmgrid/analytics": patch
---

Make desktop engine (sidecar) failures observable, and stop the offline banner
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
