# The Companies API — Agent Skill
> Company enrichment + firmographic/technographic search: turn a domain, name, email, or social URL into ~80 datapoints, and find target-account lists by attribute or natural-language ICP.

## When to use
- Enriching a **company** from a domain, work email, name, or social URL (firmographics, location, tech stack, finances, socials, logo).
- Building or expanding a **target-account list** by attributes, a prose ICP, or lookalikes of seed domains.
- Custom company facts the fixed datapoints don't cover — use `askCompany` (structured AI answer) or `companyContext` (raw text for your own LLM column).
- NOT for **people-level** data (names, personal emails, phones, LinkedIn profiles) — use LeadMagic/Trigify for contacts. `emailPatterns` returns the company's format, not specific people's emails.

## Auth & cost
- Base URL: `https://api.thecompaniesapi.com/v2` (manifest paths are relative to this).
- Auth: header `Authorization` with Basic scheme — the connector sends `Authorization: Basic <apiKey>`. Key is set as the extension's `apiKey` secret.
- Credits: most enrichment = 1 credit. Search endpoints bill **1 credit per company returned**, so cap `size`. `refresh=true` on enrichment forces a recrawl and costs **+10 credits**. `countCompanies` and `checkUser` are cheap/free.
- `simplified=true` returns a preview payload without full per-company billing — use it to scope before paying.

## Endpoints by job

### Enrich one known company
- `thecompaniesapi.enrichByDomain` — domain (e.g. `stripe.com`) → full company object (~80 nested datapoints: `about.*`, `locations.headquarters`, `technologies.active`, `finances.revenue`, `socials`, `assets.logoSquare`). The default workhorse.
- `thecompaniesapi.enrichByEmail` — work email → same object (extracts domain). Use when the grid has emails, not domains.
- `thecompaniesapi.searchByName` — company name → matching company object(s). Names aren't unique; multiple may return. Set `size` and `countries` to disambiguate.
- `thecompaniesapi.enrichBySocial` — a LinkedIn/Twitter/GitHub/etc. company URL → full object. LinkedIn is most reliable for GTM.

### Find / build account lists
- `thecompaniesapi.searchByPrompt` — natural-language ICP → matching companies. Easiest entry point ("B2B SaaS in Germany, 50-200 employees, using Salesforce"). Bills per company.
- `thecompaniesapi.searchCompanies` — structured boolean `query` (JSON-encoded condition array) → companies. Most precise; pair with `promptToSegmentation` to build the `query`.
- `thecompaniesapi.similarCompanies` — seed `domains` → lookalike companies. Expand a list from known good-fit accounts.
- `thecompaniesapi.countCompanies` — same filter as searchCompanies but returns only a **count** (no records, no per-company billing). Always size a segment with this first.

### Custom intelligence
- `thecompaniesapi.askCompany` — POST a free-text `question` about a domain; define output via `fields` ({key,type,description}) → structured `answer`. For columns the standard datapoints miss.
- `thecompaniesapi.companyContext` — domain → raw crawled site/profile text. Feed your own LLM column.
- `thecompaniesapi.emailPatterns` — domain → email-format patterns (e.g. `{first}.{last}@`) with usage %. Format only, not real addresses.

### Taxonomy resolvers (resolve human terms → valid filter values)
- `thecompaniesapi.searchIndustries` — keyword → canonical industry IDs for `query`.
- `thecompaniesapi.searchTechnologies` — keyword → canonical technology IDs for technographic targeting.
- `thecompaniesapi.searchCountries` / `thecompaniesapi.searchCities` — resolve locations for location filters.
- `thecompaniesapi.enrichJobTitles` — raw title → seniority/department/canonical role.

### Account
- `thecompaniesapi.checkUser` — account info + remaining credit balance. Free.

## Recipes
1. **Enrich a domain column** → for each row call `thecompaniesapi.enrichByDomain` with `domain={{Domain}}`. Read `about.industry`, `about.totalEmployees`, `locations.headquarters`, `finances.revenue` into new columns.
2. **Enrich from emails** → `thecompaniesapi.enrichByEmail` with `email={{Email}}` when you have contact emails but no domain column.
3. **Custom yes/no enrichment** → `thecompaniesapi.askCompany` with `domain={{Domain}}`, `question="Does this company sell primarily to enterprise?"`, `fields=[{"key":"enterprise","type":"boolean"}]`. Map `answer.enterprise` to a column.
4. **Build a target list from an ICP** → (a) `thecompaniesapi.countCompanies` to size it, then (b) `thecompaniesapi.searchByPrompt` with `prompt="<ICP>"`, `size=50` to pull rows. For precise/repeatable filters, run `thecompaniesapi.promptToSegmentation` first and pass its output as `query` to `thecompaniesapi.searchCompanies`.

## Gotchas
- **Per-company billing:** search/similar/prompt endpoints charge 1 credit *per company returned* — always set `size` and consider `simplified=true` or `countCompanies` first.
- **`refresh=true` costs +10 credits** on top of the base call. Only use when stale data is unacceptable.
- **`query` must be a JSON-stringified, URL-encoded array** of condition objects — don't pass loose JSON. Build it with `promptToSegmentation` rather than hand-writing.
- **Pagination:** results are paged (`page`, `size`, `meta` carries totals); loop `page` to collect a full list. `size` max is 100 for search endpoints, ~25 for `searchByName`.
- **`domain` in path** — pass the bare host (`stripe.com`), no scheme, no path, no `www.` needed.
- **Not found** returns an error/empty rather than a partial object; guard columns against null before mapping nested fields.
- **`emailPatterns` ≠ emails** — it returns the format template, not individual people's addresses. Use a people API for actual contacts.
