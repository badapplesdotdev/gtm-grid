---
"@gtmgrid/desktop": patch
---

Auto-updater now re-checks for new releases while the app stays open, instead of
only at launch. It polls every 2 hours and re-checks when the window regains
focus (throttled to once per 15 minutes), so a long-running app surfaces the
update banner without needing a manual restart. Polling stops once an update is
found.
