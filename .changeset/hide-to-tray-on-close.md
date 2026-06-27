---
"@gtmgrid/desktop": patch
---

Closing the window now hides GTM Grid to the system tray instead of quitting, so
the engine and any in-flight agent runs keep going in the background. A tray icon
with **Show GTM Grid** / **Quit** is the deliberate exit path (Quit tears down the
sidecar). Relaunching while hidden re-shows the window. Previously closing the
window killed the engine and lost all session state.
