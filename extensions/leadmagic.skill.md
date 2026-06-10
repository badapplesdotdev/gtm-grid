# LeadMagic — Agent Skill
> Real-time B2B data enrichment: turn a name, email, domain, or LinkedIn URL into verified emails, mobile numbers, profile/company data, hiring signals, and competitor ad intel.

## When to use
- Use to **enrich a person**: find/validate work email, find personal email, find mobile, enrich a LinkedIn profile, or detect a job change.
- Use to **enrich a company**: firmographics, funding/financials, technographics (tech stack), competitors, lookalikes, employee lists, or find a person by role.
- Use to **discover accounts & contacts at scale**: criteria-based company search (`companySearchV3`), people search (`peopleSearch`), and live job search (`jobSearch`) — all V3, filter-driven, paginated.
- Use for **GTM intent signals**: live job postings (hiring) and a company's active Google / Meta / LinkedIn ads.
- Do NOT use for: building/sending outreach, social listening, or CRM writes — LeadMagic is read-only enrichment. For consumer/B2C data it has no coverage.

## Auth & cost
- Auth: header `X-API-Key: <apiKey>` (set the `apiKey` secret). Every call sends it automatically.
- Base URL: `https://api.leadmagic.io`. **Each method carries its own version in its path** — most enrichment lives on `/v1/...`, while the newer search/discovery endpoints (`companySearchV3`, `peopleSearch`, `companyLookalike`, `jobSearch` and its `/v3/jobs/search/*` helpers, `searchStats`) live on `/v3/...`. Enrichment calls are `POST` with a JSON body; catalog/helper lookups are `GET`.
- Credits are charged **per successful result** on most calls — a miss is usually free (see Gotchas for the exact numbers). Rate limit ~300 req/min.
- **Free helpers** (0 credits, cache locally): all job catalogs (`jobCountries`, `jobTypes`, `jobIndustries`, `jobRegions`, `jobCompanyTypes`), all V3 job-search helpers (`jobSearchCatalogs`/`Companies`/`Helpers`/`Locations`/`Occupations`/`Tags`/`Titles`), `searchStats`, `analytics`, and `checkCredits`.
- Many discovery endpoints accept `preview: true` (count-only, no credits) and `limit`/`offset` (or cursor) pagination — preview before spending.

## Endpoints by job

### Find / verify a person's email
- `leadmagic.emailFinder` — work email from name + company. Needs a name (`first_name`+`last_name` OR `full_name`) AND a company (`domain` OR `company_name`). Returns `{ email, status, employment_verified, company_name }`. 1 credit.
- `leadmagic.emailValidation` — deliverability + company data for an `email`. Returns `{ email_status, is_domain_catch_all, company_name, company_industry }`. ~0.25 credit.
- `leadmagic.socialToWorkEmail` — work email from a `profile_url` (LinkedIn). Returns `{ email, profile_url }`. 5 credits.
- `leadmagic.personalEmailFinder` — personal email(s) (Gmail/Outlook/iCloud) from a `profile_url`. Returns `{ first_personal_email, personal_emails[], name }`. 2 credits.

### Find a phone number
- `leadmagic.mobileFinder` — mobile number. Provide any of `profile_url`, `work_email`, `personal_email`. Returns `{ mobile_number, profile_url, email }`. 5 credits on hit.

### Profile <-> identity
- `leadmagic.profileSearch` — enrich a LinkedIn `profile_url` into full bio/title/experience/education. 1 credit.
- `leadmagic.b2bProfile` — reverse: LinkedIn `profile_url` from a `work_email`/`personal_email`. Returns `{ profile_url }`. 10 credits.
- `leadmagic.jobChangeDetector` — has this person left a known company? `profile_url` + expected `company_domain`/`company_name`. Returns `{ job_changed, still_employed, current_company, current_title }`. 3 credits.

### Company data & discovery
- `leadmagic.companySearch` — single-company firmographics (V1) from `company_domain`, `company_name`, or `profile_url`. Returns camelCase `{ companyName, industry, employeeCount, employeeRange, founded, headquarters, revenue, specialties[] }`. 1 credit.
- `leadmagic.companySearchV3` — V3 company **discovery**. Either look up one company (`company_domain`/`website`/`company_name`/`linkedin_url`) OR run criteria search via `company_filters` (industries, `country_codes`, headcount/revenue/funding ranges, technographics, founded-year range). `limit`/`offset`; `preview:true` for a free count. Returns `{ companies[] }` with firmographics + funding + technographics + SIC/NAICS. 1 credit per company; free on preview / zero matches.
- `leadmagic.companyLookalike` — find companies **similar to a seed** for ICP expansion. Provide exactly one seed: `company_domain`/`website`/`company_name`/`description`. Optional `company_filters`, `limit` (1–2000, default 25)/`offset`, `preview:true`. Returns matches with a `similarity` score + firmographics + contact coverage. 1 credit per lookalike; free on preview / zero matches.
- `leadmagic.competitorsSearch` — a company's competitors from `company_domain`/`company_url`/`company_name`. Returns `competitors[]{ name, domain, profile_url, industry, employee_count, description }`. 5 credits on hit; free if none.
- `leadmagic.technographics` — detect a company's **tech stack** (martech, analytics, hosting, CRM, CDN…) from `company_domain` (required). Returns `{ technologies[]{ name, category, website, icon }, categories }`. 1 credit if found; free otherwise.
- `leadmagic.companyFunding` — funding history + investors + CEO from `company_domain`/`company_name`. Returns `{ total_funding, latest_round, latest_round_amount, latest_round_date, funding_rounds[], investors[], leadership.ceo{...} }`. 4 credits.

### Find / discover people inside a company
- `leadmagic.roleFinder` — one person by title. Needs `company_domain`/`company_name`; `job_title` optional (partial match). Returns a single `{ full_name, job_title, profile_url }`. 2 credits.
- `leadmagic.employeeFinder` — list employees. Needs `company_domain`/`company_name`; optional `limit` (default 10). Returns `employees[]{ full_name, job_title, location, profile_url }`. 0.05 credit/employee.
- `leadmagic.peopleSearch` — **V3 unified people search** (multi-company discovery). Target by company (`company_domain`/`company_name`/`linkedin_url` or `company_filters`) + people filters (name, title, function, level, location, seniority, email/mobile availability). Paginated (`limit` max 100, `offset`). Returns `people[]` with nested company + `domain_intel`. 1 credit per person (free if none); `include_contact_details:true` adds +1/email and +5/mobile and needs `confirm_credit_charge`.

### Hiring & job signals
Two job APIs: the older **V1 `jobsFinder`** (flat filters, paginated by page) and the newer **V3 `jobSearch`** (richer nested filters, cursor pagination, free resolver helpers). Prefer `jobSearch` for new work.
- `leadmagic.jobsFinder` — V1 search of live job postings (all params optional: company/role/location/date filters + `page`/`per_page`). Returns paginated `results[]`. 1 credit per job returned.
- `leadmagic.jobSearch` — **V3** search of live job postings. All filters optional; many accept friendly strings or numeric IDs (set `autoResolve` to convert), with nested composite filters (`titles`, `companies`, `location`, `tags`, `salary`, `occupationTaxonomy`). Returns `{ signals[], total, pagination.next_cursor }`. 1 credit per job; free if none; `dryRun` validates for free. `limit` max 50, cursor pagination.

V1 jobs catalogs (all `GET`, free — cache; resolve filter IDs for `jobsFinder`):
- `leadmagic.jobCountries` — `country_id` values.
- `leadmagic.jobTypes` — `job_type_id` values (Full Time=1, Part Time=2, Temporary=3, Internship=4, Freelance=5, Contract=6).
- `leadmagic.jobIndustries` — `company_industry_id` values.
- `leadmagic.jobRegions` — `region_id` values (pair with `country_id`).
- `leadmagic.jobCompanyTypes` — `company_type_id` values (public/private/nonprofit…).

V3 job-search helpers (all free, resolve filters for `jobSearch`):
- `leadmagic.jobSearchCatalogs` — `GET`, no inputs. All filter taxonomies in one call (countries, regions, job_types, industries, company_types, seniority, stats).
- `leadmagic.jobSearchHelpers` — `POST /v3/jobs/search/resolve`. Bulk-resolve friendly filter values (companies, tags, titles, occupation taxonomy, locations) into canonical IDs; returns resolved objects + `warnings[]` for misses.
- `leadmagic.jobSearchCompanies` — `GET`, `q`/`domain`. Company name/domain → canonical company IDs.
- `leadmagic.jobSearchTitles` — `GET`, `q` (+`limit`). Title autocomplete with occupation taxonomy.
- `leadmagic.jobSearchOccupations` — `GET`, `q` (+`level`,`limit`). Occupation-taxonomy autocomplete (3-tier hierarchy).
- `leadmagic.jobSearchTags` — `GET`, `q` (+`tag_type_id`,`limit`). Hiring-signal tags (tools/skills, e.g. kubernetes, react).
- `leadmagic.jobSearchLocations` — `GET`, `q` **and** `type` (country/region/state/city) required. Location → canonical location IDs.

### Competitor ad intel
- `leadmagic.googleAdsSearch` — active Google Ads for a company (`company_domain` preferred OR `company_name`). Returns `ads[]{ creative_id, original_url, variants[], start, last_seen, format }`. ~0.2 credit/search.
- `leadmagic.metaAdsSearch` — active Meta (FB/IG) ads from the Ad Library. Same inputs. ~0.2 credit/search.
- `leadmagic.b2bAdsSearch` — LinkedIn/B2B ad creatives. Returns `ads[]{ content, link, image_url }`.
- `leadmagic.b2bAdDetails` — full copy for one B2B ad. Needs `ad_url` (the `link`/ID from `b2bAdsSearch`). Returns `{ ad_details{ heading, content, cta{ title, url } } }`. 2 credits.

### Account & meta
- `leadmagic.checkCredits` — `GET`, free. Returns `{ credits }`.
- `leadmagic.analytics` — `GET`, free. Real-time account snapshot: credit balance, rate-limit + concurrency utilization, and request/credit usage for today/week/month. Returns `{ user, credits, rate_limit, concurrency, stats }`.
- `leadmagic.searchStats` — `POST`, free. "What can I target?" summary across Jobs/Company/People search — powers filter builders. Requires `products[]` (jobs|company|people) and `sections[]` (coverage|top|capabilities); optional `limit`. Returns cached coverage/top/capabilities blocks.

## Recipes
1. **Name + company -> verified work email** (most common): `leadmagic.emailFinder` with `full_name={{Full Name}}`, `domain={{Domain}}`. Then `leadmagic.emailValidation` on the returned `email` to confirm deliverability.
2. **LinkedIn URL -> full contact**: `leadmagic.profileSearch` with `profile_url={{LinkedIn URL}}` for firmographics, then `leadmagic.socialToWorkEmail` (work email) and `leadmagic.mobileFinder` (`profile_url={{LinkedIn URL}}`) for direct dials.
3. **Domain -> account brief**: `leadmagic.companySearch` with `company_domain={{Domain}}`, then `leadmagic.companyFunding` (same input) for funding triggers, and `leadmagic.roleFinder` with `job_title="VP Sales"` to find the buyer.
4. **Domain -> competitor ad teardown**: `leadmagic.b2bAdsSearch` with `company_domain={{Domain}}`, then for each result `leadmagic.b2bAdDetails` with `ad_url={{ad link}}` to pull headline + CTA copy.

## Gotchas
- **V1 vs V3 paths**: enrichment is on `/v1/...`; the discovery/search family (`companySearchV3`, `peopleSearch`, `companyLookalike`, `jobSearch` + `/v3/jobs/search/*` helpers, `searchStats`) is on `/v3/...`. The connector `baseUrl` is the bare host (`https://api.leadmagic.io`) and each method's `path` includes its version — don't assume everything is V1.
- **Preview before you spend**: `companySearchV3`, `companyLookalike` take `preview:true` (free count-only); `jobSearch` takes `dryRun` (free validation). Use them to size a query before paying per-result.
- **Resolve V3 job filters first**: `jobSearch` filters take canonical IDs. Either set `autoResolve` or call the free `jobSearch*` helpers (`jobSearchHelpers` bulk-resolve, or the per-field `Companies`/`Titles`/`Tags`/`Locations`/`Occupations` autocompletes) and cache.
- **`peopleSearch` contact unlocks cost extra**: base 1 credit/person, but `include_contact_details:true` adds +1/email and +5/mobile and requires `confirm_credit_charge`.
- **One-of required, not in schema**: email/profile lookups need at least one identifier even though the manifest marks few fields `required`. `emailFinder` needs a name AND a company; `roleFinder`/`employeeFinder`/`companyFunding`/`competitorsSearch`/ads calls need `company_domain` OR `company_name`; `companyLookalike`/`companySearchV3`/`peopleSearch` need one seed/identifier OR a `*_filters` object.
- **Credits charge on success only** (mostly): emailFinder 1, socialToWorkEmail 5, personalEmailFinder 2, mobileFinder 5, b2bProfile 10, companyFunding 4, jobChangeDetector 3. A no-result response is typically free — but `jobsFinder` charges 1 **per job returned**, so cap with `per_page` (max 50).
- **`profile_url` accepts a bare username** (`johndoe`) as well as a full `linkedin.com/in/...` URL.
- **Resolve filter IDs first**: `jobsFinder` takes numeric `country_id`/`job_type_id`/`region_id`, not names — call `jobCountries`/`jobTypes` once and cache.
- **`b2bAdDetails` needs the `link`/ID from `b2bAdsSearch`** (`ad_url`), not a domain — it's a two-step flow.
- **Response key casing is inconsistent**: `companySearch` returns camelCase (`companyName`, `employeeCount`); most other endpoints return snake_case (`company_name`, `credits_consumed`). Read the per-method `description` for exact field names.
- **`jobsFinder` is paginated** (`page`/`per_page`, `total_pages`); loop pages for full coverage.
