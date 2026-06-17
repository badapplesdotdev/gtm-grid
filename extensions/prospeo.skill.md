# Prospeo — Agent Skill
> Email & mobile finder plus B2B person/company enrichment and database search — turn a name, LinkedIn URL, or domain into a verified work email, direct mobile, and full firmographics.

## When to use
- Use when a grid column needs a **verified work email** or **direct mobile** for a person you can identify (LinkedIn URL, email, name+company, or a Prospeo `person_id`).
- Use to **enrich a company** (firmographics, funding, technologies, job postings) from a domain, LinkedIn URL, or `company_id`.
- Use to **build a prospect list from scratch** via Search People / Search Companies, then enrich the matches for contact info.
- Do NOT use for LinkedIn profile scraping of posts/activity, intent signals, or for B2C/personal-email-only lookups — Prospeo is B2B contact + firmographic data only.

## Auth & cost
- **Header:** `X-KEY: <apiKey>` (secret stored as `apiKey`). Content-Type `application/json`.
- **Base URL:** `https://api.prospeo.io`
- **Credits:** Enrich Person = 1 credit per email match; +10 credits if a mobile is found (`enrich_mobile:true`). Enrich Company = 1 credit per match. Search People/Companies = 1 credit per page returned (25 results/page). Search Suggestions = **free**. Account Information = **free**.
- **Free re-enrichment:** enriching the same person/company again within **90 days** is 0 credits. Repeating identical search filters+page within **30 days** is free.
- **No-match = no charge.** You are never billed when no result is found.
- Bulk endpoints process up to **50 records** per call; charged per matched record only.

## Rate limits & picker fields
- **Rate limit (enforced by the connector):** Prospeo splits limits into two endpoint classes. Enrich endpoints (`/enrich-person`, `/enrich-company`, `/bulk-enrich-person`, `/bulk-enrich-company`) allow **5 req/s, 300 req/min** on Starter/Growth (up to 30 req/s on Pro). Search endpoints (`/search-person`, `/search-company`) are stricter at **1 req/s, 30 req/min** on Starter (2 req/s Growth, 5 req/s Pro). Over-limit returns HTTP **429 RATE_LIMITED**. The manifest sets a connector-level default of `rps:5 / rpm:300 / concurrency:3` and a per-method override of `rps:1 / rpm:30` on both search endpoints (conservative Starter baseline — raise if you are on Growth/Pro).
- **No live picker (`options`) fields.** Prospeo is a stateless enrichment/search API: there are no campaigns, lists, workspaces, sequences, owners, folders, or tags to enumerate by id/name. Filter values for Search People/Companies are resolved live via the free `searchSuggestions` endpoint (free-text in, canonical values out), not a fixed enumerable list, so no field is wired to an `options` list method.

## Endpoints by job

### Find email / mobile for a known person
- `prospeo.enrichPerson` — POST `/enrich-person`. Enrich ONE person to a verified work email (+ optional mobile) plus full person & company data. Put identifiers inside `data`: `{ linkedin_url }` OR `{ email }` OR `{ person_id }` OR `{ full_name + company field }` OR `{ first_name + last_name + company field }`, where a company field is `company_name` | `company_website` | `company_linkedin_url`. Options: `enrich_mobile:true` (10 credits if found), `only_verified_email`, `only_verified_mobile`. Returns `{ error, free_enrichment, person, company }`.
- `prospeo.bulkEnrichPerson` — POST `/bulk-enrich-person`. Same matching as above for up to 50 people. `data` is an array; each item needs your own `identifier` string (echoed back) plus the matching datapoints. Returns `{ error, total_cost, matched:[{ identifier, person, company }], not_matched:[identifier], invalid_datapoints:[identifier] }`. Prefer this over single calls for batches.

### Enrich a company
- `prospeo.enrichCompany` — POST `/enrich-company`. Enrich ONE company. `data`: `company_website` (preferred) OR `company_linkedin_url` OR `company_id` OR `company_name` (weakest alone). Returns `{ error, free_enrichment, company }` with `company_id, name, domain, industry, employee_count, employee_range, location, revenue_range, founded, keywords, funding, technology, job_postings`.
- `prospeo.bulkEnrichCompany` — POST `/bulk-enrich-company`. Up to 50 companies. `data` array; each item needs `identifier` + one company datapoint. Returns `{ error, total_cost, matched:[{ identifier, company }], not_matched, invalid_datapoints }`.

### Build a list from the database
- `prospeo.searchPerson` — POST `/search-person`. Search 200M+ contacts with 30+ `filters` (job title, seniority, department, location, company size/industry, technologies…). Returns `{ error, free, results:[{ person, company }], pagination:{ current_page, per_page, total_page, total_count } }`. 25/page, max 1,000 pages. **Email/mobile are NOT included** — feed each result's `person_id` into `enrichPerson`/`bulkEnrichPerson` to reveal contact info.
- `prospeo.searchCompany` — POST `/search-company`. Search 30M+ companies by firmographic `filters`. Returns `{ error, free, results:[{ company }], pagination }`. 25/page, max 1,000 pages. Website/name filter lists capped at 500 items.
- `prospeo.searchSuggestions` — POST `/search-suggestions`. FREE helper that resolves canonical filter values before searching. Provide exactly ONE field (min 2 chars): `location_search` | `job_title_search` | `technology_search` | `industry_search` | `naics_search` | `sic_search`. Returns the matching `*_suggestions` array; other fields null. Always call this first to build valid `filters`.

### Account
- `prospeo.accountInformation` — GET `/account-information`. Free. Returns `{ error, response:{ current_plan, current_team_members, remaining_credits, used_credits, next_quota_renewal_days, next_quota_renewal_date } }`.

## Recipes

1. **Work email from a LinkedIn URL** (cheapest, most reliable):
   `prospeo.enrichPerson` with `{ "data": { "linkedin_url": "{{LinkedIn URL}}" }, "only_verified_email": true }` → read `person.email`.

2. **Work email from name + company**:
   `prospeo.enrichPerson` with `{ "data": { "first_name": "{{First Name}}", "last_name": "{{Last Name}}", "company_website": "{{Domain}}" } }` → read `person.email`.

3. **Email + direct mobile in one call**:
   `prospeo.enrichPerson` with `{ "data": { "linkedin_url": "{{LinkedIn URL}}" }, "enrich_mobile": true, "only_verified_email": true }` → read `person.email` and `person.mobile` (note: +10 credits when a mobile is returned).

4. **Build a targeted list then enrich** (two stages):
   a. `prospeo.searchSuggestions` with `{ "job_title_search": "VP Sales" }` to get the canonical title value.
   b. `prospeo.searchPerson` with `{ "filters": { ...canonical values... }, "page": 1 }` → collect `person_id`s.
   c. `prospeo.bulkEnrichPerson` with `data:[{ identifier, person_id }, ...]` (≤50) to reveal emails/mobiles.

## Gotchas
- **Identifiers go inside `data`** for enrich endpoints — a flat `{ linkedin_url }` at the top level will not match. Search endpoints instead use `filters` at the top level.
- **Search never returns contact info.** Always do the two-step: search → enrich by `person_id`. Budgeting only for search will yield zero emails.
- **Call `searchSuggestions` before searching.** Raw free-text filter values often don't match; the suggestions endpoint returns the canonical strings/codes and is free.
- **Cannot search with exclude-only filters** — at least one positive (include) filter is required on both search endpoints.
- **Mobile is expensive:** `enrich_mobile:true` adds 10 credits per mobile *found*. Use `only_verified_mobile:true` to avoid paying for unverified numbers.
- **`free_enrichment:true` in the response means you were NOT charged** (no match, or a 90-day re-enrichment). Don't treat it as an error.
- **Pagination:** each page costs 1 credit; `pagination.total_count` / `total_page` tell you the full size before you page deeper. Max 1,000 pages per query.
- **Bulk responses split results** into `matched`, `not_matched`, and `invalid_datapoints` (records missing a valid identifier combo) — check all three; your `identifier` string is the join key back to the grid row.
- **`company_name` alone is the weakest identifier** for company enrichment/matching — prefer `company_website`.
