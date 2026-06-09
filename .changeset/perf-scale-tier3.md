---
"@gtmgrid/desktop": patch
---

Performance & scale hardening, Tier 3 + cleanups. Column virtualization (visible columns × rows only) for very wide tables; desktop bundle code-split (lazy-loaded panels) to shrink first load; dedupe the bulk-insert chunk() helper into one shared util with a regression test bound to the real Drizzle path; recordDelivery prunes in a single set-based DELETE; cell runs force only the targeted cell (no re-billing unchanged cells); and lint is now warning-free.
