---
"@gtmgrid/web": patch
---

Fix `process-webhook-record` (and any worker self-call) failing with
"SITE_URL is not configured" on deployments without the manual env var: the
worker base URL now falls back to the Vercel-injected deployment host
(`VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`) when `SITE_URL` is
unset. An explicit `SITE_URL` still wins; off-Vercel with nothing set still
fails closed.
