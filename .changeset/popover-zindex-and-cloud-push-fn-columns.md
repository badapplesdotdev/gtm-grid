---
"@gtmgrid/desktop": patch
"@gtmgrid/engine": patch
"@gtmgrid/server": patch
"@gtmgrid/web": patch
---

Fix two desktop bugs:

- **In-app updater / notification popover was unclickable.** The transparent
  full-viewport `.popover-scrim` (z-index 100) sat *above* the bell notification
  popover (z-index 61), so clicking "Update & restart" (or any action) hit the
  scrim and just closed the popover instead of firing the button. Raised the
  notification popover — and the dedupe popover, which had the same z-index 50 <
  scrim bug — above the scrim.

- **Pushing a local table to the cloud dropped function-column config.** The
  local→cloud push only sent each column's name/type (and the sidecar hardcoded
  `kind: "manual"`), so a function/formula/code column landed in the cloud as a
  plain manual column and its cells could no longer be run/enriched. The push now
  carries the full config (kind/provider/method/code/params/condition); the
  `grid.addColumn` tRPC mutation also accepts `condition` so the "only run if"
  rule survives the push.
