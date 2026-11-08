---
"@gtmgrid/desktop": patch
---

Stop reporting temporary GitHub 502, 503 and 504 responses during desktop update checks as auto-update failures. The next scheduled check recovers from these errors, so they are not release problems.
