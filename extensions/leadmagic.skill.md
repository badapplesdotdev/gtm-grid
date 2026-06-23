# LeadMagic — Agent Skill
> B2B data enrichment from public LeadMagic API docs: verified emails, mobile numbers, profiles, company intelligence, hiring signals, and ad research.

**Public reference:** https://leadmagic.io/docs/api-reference

## Mapping notes (connector config)
- **Rate limit (documented):** default **300 req/min** at the connector level (`rateLimit.rpm: 300`, `concurrency: 3`). Per-endpoint overrides at **100 req/min** where the docs specify: `profileSearch`, `companySearch`, `jobsFinder`, `companySearchV3`, `companyLookalike`, and `peopleSearch`. Source: LeadMagic API reference rate-limit tables.
- **Picker fields** — LeadMagic is a stateless enrichment API. The only enumerable-resource fields are numeric catalog IDs on **`jobsFinder`**, each backed by a free `GET` catalog method (returns `{ id, name }`; `labelKey:"name"` / `valueKey:"id"`):
  - `country_id` → `jobCountries`
  - `job_type_id` → `jobTypes`
  - `region_id` → `jobRegions`
  - `company_industry_id` → `jobIndustries`
  - `company_type_id` → `jobCompanyTypes`
- V3 search filters (`jobSearch`, `companySearchV3`, `peopleSearch`) resolve IDs via free autocomplete/helper endpoints — use `autoResolve` or the `jobSearch*` helper methods.

## When to use
- **Enrich a person:** find/validate work email, personal email, mobile, LinkedIn profile, job-change check.
- **Enrich a company:** firmographics, funding, technographics, competitors, lookalikes, employees, role-based lookup.
- **Discover at scale:** V3 company search, people search, and job search with filters and pagination.
- **GTM signals:** live job postings and Google / Meta / LinkedIn ad research.
- **Do NOT use for:** outreach sending, social listening, or CRM writes — LeadMagic is read-only enrichment.

## Auth & cost
- Auth: header `X-API-Key: <apiKey>` (set the `apiKey` secret).
- Base URL: `https://api.leadmagic.io`. Paths include their version (`/v1/...` or `/v3/...`). Enrichment uses `POST` + JSON; catalogs/account helpers use `GET`.
- Credits are mostly **per successful result**; misses are usually free. See each method description for the published rate.
- **Free helpers (0 credits):** job catalogs, V3 job-search helpers, `searchStats`, `analytics`, `checkCredits`.

## Endpoints by job

### Find / verify email
- `leadmagic.emailFinder` — work email from name + company (name AND company required). 1 credit on valid email.
- `leadmagic.emailValidation` — deliverability + company data for an `email`. 0.25 credit.
- `leadmagic.socialToWorkEmail` — work email from `profile_url`. 5 credits.
- `leadmagic.personalEmailFinder` — personal email(s) from `profile_url`. 2 credits.

### Phone
- `leadmagic.mobileFinder` — mobile from `profile_url`, `work_email`, or `personal_email`. 5 credits on hit.

### Profile & identity
- `leadmagic.profileSearch` — enrich `profile_url`; optional `extended_response` for profile image. 1 credit.
- `leadmagic.b2bProfile` — LinkedIn profile from `work_email` or `personal_email`. 10 credits.
- `leadmagic.jobChangeDetector` — `profile_url` + expected company. 3 credits.

### Company
- `leadmagic.companySearch` — V1 single-company lookup. Prefer `companySearchV3` for new work. 1 credit.
- `leadmagic.companySearchV3` — V3 lookup or criteria search via `company_filters`; supports `preview`. 1 credit per company.
- `leadmagic.companyLookalike` — similar companies from a seed domain/website/name/description. 1 credit per lookalike; `preview:true` is free.
- `leadmagic.competitorsSearch` — competitors from `company_domain`, `company_url`, or `company_name`. 5 credits.
- `leadmagic.technographics` — tech stack from `company_domain`. 1 credit.
- `leadmagic.companyFunding` — funding from `company_domain` or `company_name`. 4 credits.

### People at a company
- `leadmagic.roleFinder` — one person by title. Requires `job_title` AND company identifier. 2 credits.
- `leadmagic.employeeFinder` — employee list; 0.05 credit per employee returned.
- `leadmagic.peopleSearch` — V3 people discovery with company/people filters; optional contact unlock via `include_contact_details` + `confirm_credit_charge`. 1 credit per person.

### Jobs
- `leadmagic.jobsFinder` — V1 flat filters + page/per_page. 1 credit per job.
- `leadmagic.jobSearch` — V3 structured filters + cursor pagination; `dryRun` validates for free. 1 credit per job.
- Free V1 catalogs: `jobCountries`, `jobTypes`, `jobIndustries`, `jobRegions`, `jobCompanyTypes`.
- Free V3 helpers: `jobSearchCatalogs`, `jobSearchHelpers`, `jobSearchCompanies`, `jobSearchTitles`, `jobSearchOccupations`, `jobSearchTags`, `jobSearchLocations`.

### Ads
- `leadmagic.googleAdsSearch` / `leadmagic.metaAdsSearch` — 1 credit per ad returned; free if no ads.
- `leadmagic.b2bAdsSearch` — 1 base credit + 1 per ad (minimum 1).
- `leadmagic.b2bAdDetails` — full creative for one `ad_url`. 2 credits.

### Account
- `leadmagic.checkCredits` — balance. Free.
- `leadmagic.analytics` — usage snapshot. Free.
- `leadmagic.searchStats` — coverage/capabilities summary for filter builders. Free.

## Gotchas
- **Conditional required fields:** many endpoints need at least one identifier even when JSON Schema marks fields optional (e.g. emailFinder needs name + company; mobileFinder needs one of profile_url/work_email/personal_email).
- **Preview before spend:** `companySearchV3`, `companyLookalike` support `preview:true`; `jobSearch` supports `dryRun`.
- **V1 vs V3:** enrichment mostly on `/v1/...`; discovery/search on `/v3/...`.
- **jobsFinder filter IDs:** resolve via free catalog methods, not display names.
- **b2bAdDetails** needs `ad_url` from `b2bAdsSearch` results.
