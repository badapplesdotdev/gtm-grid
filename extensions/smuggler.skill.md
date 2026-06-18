# Smuggler — Agent Skill
> LinkedIn outbound + engagement intelligence: search people/companies, find their emails, and pull the people who engaged with monitored posts/profiles.

## When to use
- Use to **find a person/company inside Smuggler's index** (free search), **resolve a work email** for a known person id, or **pull engagers** off a LinkedIn post or monitored profile.
- Use for **engagement-led prospecting**: list captured leads, or get the top engagers of a tracked profile, then enrich the best ones.
- Do NOT use to enrich an *arbitrary* LinkedIn URL or email you found elsewhere — Smuggler's email finder keys off a Smuggler **person id**, not a raw URL. For URL/email-first enrichment, use the `leadmagic` extension instead.
- Do NOT use for phone numbers — there is no mobile finder here (use `leadmagic.mobileFinder`).

## Auth & cost
- **Auth header:** `x-api-key: <apiKey>` (secret key name: `apiKey`).
- **Base URL:** `https://smuggler.dev/api/v1`.
- **Credits:** all search/get/list/engagement reads are **0 credits**. Email resolution costs **1 credit** (`findEmail`, `bulkFindEmail`). `bulkFindEmail` skips already-enriched ids, so you only pay for net-new emails.
- **Rate limit:** not documented by smuggler.dev (see "Not verified"), so the connector applies a safe default of **120 rpm / concurrency 3**. The two credit-consuming email calls (`findEmail`, `bulkFindEmail`) carry a stricter per-method override of **2 rps**. Treat search `limit` ≤ 100 per page and paginate with `offset`.

## Picker fields (live options)
Several id fields are now backed by live list endpoints, so they render as name-pickers (the engine stores the id):
- `listLeads.campaignId` → `listCampaigns` (label `name`, sublabel `status`).
- `listLeads.profileId` → `listProfiles` (label `fullName`, sublabel `headline`).
- `topEngagers.id` → `listProfiles` (a monitored-profile id).
- `postEngagements.id` → `listPosts` (label `title`, sublabel `authorName`).

The backing list endpoints (`listCampaigns`, `listProfiles`, `listPosts`) are all **0-credit** GETs returning `data[]`. Their field names follow the manifest's own conventions and could not be cross-checked against live docs (smuggler.dev is undocumented).

## Endpoints by job

### Find people
- `smuggler.searchPersons` — free-text / faceted people search. Inputs: `query`, `company`, `title`, `location`, `limit` (max 100, default 50), `offset`. Returns `data[]` of `{ id, fullName, headline, linkedinUrl, jobTitle, jobCompanyName, locationCountry, enrichmentStatus }`. The `id` is the key you feed into `findEmail`.
- `smuggler.getPerson` — full record for one person. Input: `id` (required). Returns `{ id, fullName, headline, linkedinUrl, jobTitle, jobCompanyName, seniority, jobFunction, locationCountry, enrichmentStatus }`.

### Find emails
- `smuggler.findEmail` — synchronous email waterfall for one person. Input: `id` (required, in path; no body). Returns the resolved email on the person record. **1 credit.**
- `smuggler.bulkFindEmail` — queue email enrichment for up to **500** person ids (background job). Input: `personIds` (array, 1–500, required). Already-enriched ids are skipped. **1 credit** per new email.

### Find companies
- `smuggler.searchCompanies` — company name search. Inputs: `query`, `limit` (max 100), `offset`. Returns `data[]` of `{ id, name, logoUrl, employeeCountRange, industry }`.
- `smuggler.getCompany` — one company by id. Input: `id` (required).

### Engagement intelligence
- `smuggler.listLeads` — captured leads (people who engaged with monitored profiles/posts) with engagement counts + enrichment status. Inputs: `campaignId`, `profileId`, `search`, `limit` (max 100), `offset`. Use to pull a working list, then `bulkFindEmail` the ids.
- `smuggler.postEngagements` — who engaged with a specific LinkedIn post. Input: `id` (Smuggler post id, required). Returns `data[]` of `{ id, type, engagerName, engagerHeadline, engagerLinkedinUrl, engagedAt }`.
- `smuggler.topEngagers` — top engagers for a monitored profile. Input: `id` (Smuggler profile id, required). Returns `data[]` of `{ personId, fullName, headline, engagementCount, lastEngagedAt }`. Note `personId` (not `id`) is the person key.
- `smuggler.listCampaigns` — list engagement-monitoring campaigns. Inputs: `search`, `limit` (max 100), `offset`. Returns `data[]` of `{ id, name, status, profileCount, leadCount }`. Backs the `campaignId` picker on `listLeads`.
- `smuggler.listProfiles` — list monitored LinkedIn profiles. Inputs: `campaignId`, `search`, `limit` (max 100), `offset`. Returns `data[]` of `{ id, fullName, headline, linkedinUrl, status, lastSyncedAt }`. Backs the `profileId` picker on `listLeads` and the `id` picker on `topEngagers`.
- `smuggler.listPosts` — list monitored LinkedIn posts. Inputs: `profileId`, `search`, `limit` (max 100), `offset`. Returns `data[]` of `{ id, title, authorName, postUrl, engagementCount, postedAt }`. Backs the `id` picker on `postEngagements`.

### Account
- `smuggler.credits` — balance + usage. No input. Returns `{ allowed, balance, usage, included, unlimited, interval, nextResetAt }`. Check before a large `bulkFindEmail`.

## Recipes

1. **Title-targeted email list**
   1. `smuggler.searchPersons` with `{ title: "VP of Sales", company: "{{Company}}", limit: 100 }`.
   2. Collect `id` from each `data[]` row.
   3. `smuggler.bulkFindEmail` with `{ personIds: [...] }`.
   4. Re-read with `smuggler.getPerson` per id once the job settles to read the resolved email.

2. **Enrich one known person**
   1. `smuggler.searchPersons` with `{ query: "{{Full Name}}", company: "{{Company}}" }` → take the top `id`.
   2. `smuggler.findEmail` with `{ id }` → resolved email (1 credit).

3. **Work a profile's top engagers**
   1. `smuggler.topEngagers` with `{ id: "{{Profile Id}}" }`.
   2. Map `personId` → `smuggler.bulkFindEmail` with `{ personIds: [...] }`.
   3. `smuggler.getPerson` per `personId` for titles/company before outreach.

4. **Pull engagers off a single post**
   1. `smuggler.postEngagements` with `{ id: "{{Post Id}}" }` → `data[]` of engagers + `engagerLinkedinUrl`.
   2. To email them, resolve a Smuggler `id` first via `searchPersons` (engagements carry name/URL, not a person id), then `findEmail`.

## Gotchas
- **Email needs a Smuggler person id, not a URL.** `findEmail` / `bulkFindEmail` only accept Smuggler `id`/`personIds`. A raw LinkedIn URL won't work — search first to get the id.
- **`topEngagers` returns `personId`, the others return `id`.** Use `personId` as the email-finder key for that endpoint.
- **`postEngagements` rows have no person id** — only `engagerName` / `engagerLinkedinUrl`. You must re-resolve to a Smuggler id via `searchPersons` before enriching.
- **Bulk is async.** `bulkFindEmail` queues a background job; the email isn't on the response. Poll `getPerson` (watch `enrichmentStatus`) to read results.
- **`findEmail` uses POST with the id in the path** — send no request body.
- **Credit trap:** `findEmail`/`bulkFindEmail` are the only paid calls (1 credit each new email). All search/get/list/engagement reads are free — don't burden them with retries thinking they cost credits, but DO check `smuggler.credits` before a 500-id bulk run.
- **Pagination:** `limit` caps at 100; use `offset` to page. No documented cursor.

## Not verified
- smuggler.dev is **not publicly documented** — the domain returns HTTP 403 and there is no public API reference, OpenAPI spec, G2/Capterra listing, or developer portal. Web search surfaces only unrelated "Smuggler" projects (HTTP request-smuggling security tools, a film production company).
- Therefore this skill documents **exactly the 10 methods already in `smuggler.json`** and could not be expanded with additional verified endpoints. Field names, credit costs, async/polling behaviour, and rate limits above are taken from the manifest's own descriptions and could not be cross-checked against live docs.
