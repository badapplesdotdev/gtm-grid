---
"@gtmgrid/desktop": patch
---

CRM sync live-review fixes: rows and cells now insert atomically (no more blank "—" rows mid-sync), the status strip shows a live server-derived syncing indicator ("Pulling records from Attio… N so far") for background and cron runs, trial/plan lapse pauses syncing with an in-strip upgrade banner instead of silently retrying, and dropped realtime inserts trigger throttled refetches so sidebar, header, and strip counts stay in agreement during large syncs.
