# LeadMagic — Agent Skill
> Real-time B2B data enrichment: turn a name, email, domain, or LinkedIn URL into verified emails, mobile numbers, profile/company data, hiring signals, and competitor ad intel.

## When to use
- Use to **enrich a person**: find/validate work email, find personal email, find mobile, enrich a LinkedIn profile, or detect a job change.
- Use to **enrich a company**: firmographics, funding/financials, employee lists, or find a person by role.
- Use for **GTM intent signals**: live job postings (hiring) and a company's active Google / Meta / LinkedIn ads.
- Do NOT use for: building/sending outreach, social listening, or CRM writes — LeadMagic is read-only enrichment. For consumer/B2C data it has no coverage.

## Auth & cost
- Auth: header `X-API-Key: <apiKey>` (set the `apiKey` secret). Every call sends it automatically.
- Base URL: `https://api.leadmagic.io/v1`. All enrichment calls are `POST` with a JSON body; lookup helpers (`jobCountries`, `jobTypes`, `checkCredits`) are `GET`.
- Credits are charged **per successful result** on most calls — a miss is usually free (see Gotchas for the exact numbers). Rate limit ~300 req/min.
- `checkCredits` is free; call it to read the balance.

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

### Company data
- `leadmagic.companySearch` — firmographics from `company_domain`, `company_name`, or `profile_url`. Returns camelCase `{ companyName, industry, employeeCount, employeeRange, founded, headquarters, revenue, specialties[] }`. 1 credit.
- `leadmagic.companyFunding` — funding history + investors + CEO from `company_domain`/`company_name`. Returns `{ total_funding, latest_round, latest_round_amount, latest_round_date, funding_rounds[], investors[], leadership.ceo{...} }`. 4 credits.

### Find people inside a company
- `leadmagic.roleFinder` — one person by title. Needs `company_domain`/`company_name`; `job_title` optional (partial match). Returns a single `{ full_name, job_title, profile_url }`. 2 credits.
- `leadmagic.employeeFinder` — list employees. Needs `company_domain`/`company_name`; optional `limit` (default 10). Returns `employees[]{ full_name, job_title, location, profile_url }`. 0.05 credit/employee.

### Hiring & job signals
- `leadmagic.jobsFinder` — search live job postings (all params optional: company/role/location/date filters + `page`/`per_page`). Returns paginated `results[]`. 1 credit per job returned.
- `leadmagic.jobCountries` — `GET`, free. Resolve `country_id` values for `jobsFinder`. Cache it.
- `leadmagic.jobTypes` — `GET`, free. Resolve `job_type_id` values (Full Time=1, Part Time=2, Temporary=3, Internship=4, Freelance=5, Contract=6). Cache it.

### Competitor ad intel
- `leadmagic.googleAdsSearch` — active Google Ads for a company (`company_domain` preferred OR `company_name`). Returns `ads[]{ creative_id, original_url, variants[], start, last_seen, format }`. ~0.2 credit/search.
- `leadmagic.metaAdsSearch` — active Meta (FB/IG) ads from the Ad Library. Same inputs. ~0.2 credit/search.
- `leadmagic.b2bAdsSearch` — LinkedIn/B2B ad creatives. Returns `ads[]{ content, link, image_url }`.
- `leadmagic.b2bAdDetails` — full copy for one B2B ad. Needs `ad_url` (the `link`/ID from `b2bAdsSearch`). Returns `{ ad_details{ heading, content, cta{ title, url } } }`. 2 credits.

### Account
- `leadmagic.checkCredits` — `GET`, free. Returns `{ credits }`.

## Recipes
1. **Name + company -> verified work email** (most common): `leadmagic.emailFinder` with `full_name={{Full Name}}`, `domain={{Domain}}`. Then `leadmagic.emailValidation` on the returned `email` to confirm deliverability.
2. **LinkedIn URL -> full contact**: `leadmagic.profileSearch` with `profile_url={{LinkedIn URL}}` for firmographics, then `leadmagic.socialToWorkEmail` (work email) and `leadmagic.mobileFinder` (`profile_url={{LinkedIn URL}}`) for direct dials.
3. **Domain -> account brief**: `leadmagic.companySearch` with `company_domain={{Domain}}`, then `leadmagic.companyFunding` (same input) for funding triggers, and `leadmagic.roleFinder` with `job_title="VP Sales"` to find the buyer.
4. **Domain -> competitor ad teardown**: `leadmagic.b2bAdsSearch` with `company_domain={{Domain}}`, then for each result `leadmagic.b2bAdDetails` with `ad_url={{ad link}}` to pull headline + CTA copy.

## Gotchas
- **One-of required, not in schema**: email/profile lookups need at least one identifier even though the manifest marks few fields `required`. `emailFinder` needs a name AND a company; `roleFinder`/`employeeFinder`/`companyFunding`/ads calls need `company_domain` OR `company_name`.
- **Credits charge on success only** (mostly): emailFinder 1, socialToWorkEmail 5, personalEmailFinder 2, mobileFinder 5, b2bProfile 10, companyFunding 4, jobChangeDetector 3. A no-result response is typically free — but `jobsFinder` charges 1 **per job returned**, so cap with `per_page` (max 50).
- **`profile_url` accepts a bare username** (`johndoe`) as well as a full `linkedin.com/in/...` URL.
- **Resolve filter IDs first**: `jobsFinder` takes numeric `country_id`/`job_type_id`/`region_id`, not names — call `jobCountries`/`jobTypes` once and cache.
- **`b2bAdDetails` needs the `link`/ID from `b2bAdsSearch`** (`ad_url`), not a domain — it's a two-step flow.
- **Response key casing is inconsistent**: `companySearch` returns camelCase (`companyName`, `employeeCount`); most other endpoints return snake_case (`company_name`, `credits_consumed`). Read the per-method `description` for exact field names.
- **`jobsFinder` is paginated** (`page`/`per_page`, `total_pages`); loop pages for full coverage.
