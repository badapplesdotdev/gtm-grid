---
"@gtmgrid/engine": patch
---

Treat an expected upstream 404 on enrich-by-identifier connector methods as a no-data result instead of a hard error. Declarative manifest methods can now opt in with `emptyWhenNotFound`, and Trigify's profile/company enrichment use it — an unresolvable LinkedIn URL now leaves the cell empty rather than marking it failed and reporting a new Error Tracking issue.
