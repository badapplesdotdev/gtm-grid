# TheirStack — Agent Skill
> TheirStack provides job-posting, company, technographic, and buying-intent data plus lists, catalogs, saved searches, datasets, usage records, and webhooks.

## Connect and authenticate
- Save a TheirStack **API key** in the credential. The connector sends `Authorization: Bearer <api-key>`; do not include `Bearer ` yourself.
- Create and revoke keys under TheirStack Settings → API Keys. Keys may have an expiration policy and are displayed only once.
- Base URL: `https://api.theirstack.com`. Requests use JSON except the two RFC 8058 one-click unsubscribe methods.
- Ten public catalog/unsubscribe operations do not send or require the saved key, though connecting a credential unlocks the complete tool catalog in the app.

## Complete active catalog (51 endpoints)
- **Jobs (1):** `search_jobs_v1`.
- **Companies (3):** `search_companies_v1`, `technographics_v1`, `buying_intents_v1`.
- **Catalog (7):** keyword, category, subcategory, industry, location, and country coverage metadata.
- **Company Lists (10):** list/create/get/rename/delete, members, add/remove/duplicate, and multi-list additions.
- **Webhooks (12):** event types, CRUD/status/archive, test delivery, event history/counts, and retries.
- **Saved Searches (7):** create/list/get/update/archive and alert unsubscribe methods.
- **Email Preferences (4), Requests (2), Datasets (2), Credit Consumption (1), Billing (1), App URLs (1).**
- The single upstream endpoint marked deprecated (`get_company_lists_companies_export_v0`) is intentionally omitted. Regenerate with `pnpm --filter @gtmgrid/engine gen:theirstack` when the official schema changes.

## Job-search workflow
1. Call `search_jobs_v1` with at least one required performance filter: a posted-date filter or company domain, LinkedIn URL, or name filter.
2. For per-row account signals, use `company_domain_or: ["{{Domain}}"]`, a recent `posted_at_max_age_days`, and a small `limit`.
3. Add title, country, remote, seniority, salary, technology, keyword, location, or property-existence filters as needed.
4. Use `discovered_at_gte` plus `job_id_not` for incremental polling without paying for duplicates.
5. `blur_company_data: true` provides preview results without credits where supported; it cannot be combined with company identifier filters.

## Company and intent workflows
- `search_companies_v1` combines firmographics, funding, employee count, location, technology, and nested hiring filters. It costs 3 API credits per returned company.
- `technographics_v1` requires a company domain, name, or LinkedIn URL and returns technologies with confidence, job counts, and first/last detection dates. It costs 3 credits per company lookup when results exist.
- `buying_intents_v1` uses the same company identifiers and returns detected buying-intent topics. It costs 3 credits per successful company lookup.
- Prefer domain or LinkedIn URL for durable deduplication; TheirStack documents its internal company ID as temporary.

## Pagination, credits, and limits
- List methods support page-based (`page`, `limit`) or offset-based (`offset`, `limit`) pagination. POST methods place them in JSON; GET methods use query parameters.
- Keep `include_total_results: false` after the initial count because calculating totals is slower.
- Job Search costs 1 API credit per returned job. Company Search costs 3 credits per returned company.
- The three tier-limited search endpoints share free-tier windows of 4/second, 10/minute, 50/hour, and 400/day; paid users have 4/second. The connector conservatively schedules those calls at 10/minute with one in flight.
- The runtime honors HTTP 429 retry guidance. Watch `RateLimit`, `RateLimit-Policy`, and remaining/reset headers for longer jobs.

## Mutations and safety
- Confirm before deleting lists, archiving saved searches/webhooks, changing email preferences, retrying webhook events, or invoking unsubscribe operations.
- `post_webhooks_test_v0` sends a test delivery to an external URL; only invoke it when the user explicitly asks.
- Dataset credential generation creates temporary S3 access credentials. Treat returned secrets as sensitive and do not persist them into ordinary grid columns.
- A 402 usually indicates insufficient credits or plan access; 422 indicates invalid inputs; 429 indicates rate limits; 401 indicates an invalid or expired key.

## Official documentation
- API reference and OpenAPI download: https://theirstack.com/en/docs/api-reference
- Authentication: https://theirstack.com/en/docs/api-reference/authentication
- Pagination: https://theirstack.com/en/docs/api-reference/pagination
- Rate limits: https://theirstack.com/en/docs/api-reference/rate-limit
- Webhooks: https://theirstack.com/en/docs/webhooks
- Machine-readable schema: https://api.theirstack.com/openapi.json
