---
"@gtmgrid/desktop": patch
---

Fix the Windows "engine unreachable / port 8787 still in use" failure.

The engine's parent-death watchdog detected orphaning via a Unix-only signal
(reparent-to-init), which never happens on Windows — so a crashed, killed, or
reinstalled app left the engine orphaned, holding the port, and every later launch's
engine gave up. Now the watchdog uses a cross-platform liveness probe
(`process.kill(pid, 0)`), and on persistent port contention the new engine reclaims
the port from the stale holder (netstat+taskkill / lsof+kill), so a machine that
already has a stuck orphan self-heals on the next launch. Covered by a regression
test that reproduces the orphaned port-holder and verifies the reclaim.
