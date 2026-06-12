---
"@gtmgrid/services": patch
---

Fix every poll-trigify-signals run failing at the due-bindings query. The
SQL due-filter bound `-Infinity` as the CASE fallback threshold, but
`last_synced_at` is a bigint column and Postgres rejects `-Infinity` for
integer types — so the query errored on every execution and no scheduled
signal binding was ever polled. The fallback is now `NULL` (never due),
matching the intended semantics.
