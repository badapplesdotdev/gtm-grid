---
"@gtmgrid/services": patch
---

Stop re-polling a deleted Trigify Social Signals search every hour.

A binding whose Trigify search returns 404 now disables itself and shows a
human-readable message ("recreate this binding"), instead of failing each
hourly poll — which refiled an Error Tracking exception forever while the
table stayed empty.
