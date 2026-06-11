---
"@gtmgrid/desktop": patch
---

Show the full-screen branded loader on launch while a signed-in user's cloud
workspace loads, instead of flashing the local app and then switching to cloud.
The loader holds until the cloud project is open, with a short minimum display
window so an instant (warm-cache) load still reads as an intentional splash
rather than a flicker, and a safety timeout so it can never get stuck.
