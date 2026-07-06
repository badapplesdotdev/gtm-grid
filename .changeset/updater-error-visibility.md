---
"@gtmgrid/desktop": patch
---

Failed auto-updates are no longer silent: if an update can't install (e.g. the app is running from the DMG or a location it can't replace itself in), the update dialog now says so and offers a manual download — instead of endlessly re-offering the same version. Install failures are also reported to error tracking so we can diagnose them remotely.
