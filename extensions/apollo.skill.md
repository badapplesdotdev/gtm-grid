# Apollo.io — Agent Skill
> Apollo is the broadest B2B people/company database with native enrichment — reach for it to find net-new prospects by firmographic/title filters and then enrich them into emails, titles, and firmographics.

## When to use
- **People/company discovery**: build prospect lists by title, seniority, location, headcount, technology, or revenue (`searchPeople`, `searchOrganizations`).
- **Enrichment**: turn a name+company (or domain) into a verified work email, title, LinkedIn, and full firmographics (`enrichPerson`, `enrichOrganization`, and the bulk variants for ≤10 rows/call).
- **CRM + sequencing actions**: read/write your own Apollo account — contacts, accounts, deals, tasks, and pushing contacts into outbound sequences.
- **NOT for**: pure email verification of arbitrary addresses (Apollo enriches, it doesn't have a standalone validate endpoint — use LeadMagic for that), personal phone numbers without a webhook (Apollo returns phones async), or B2C/consumer data.

## Auth & cost
- **Auth**: API key in header `X-Api-Key` (manifest secret `apiKey`). Base URL `https://api.apollo.io/api/v1`.
- **Master key required** for: `searchPeople`, `addContactsToSequence`, `createAccount`, `createDeal`, `listDeals`, `bulkCreateTasks`, `getUsers`. A non-master key returns **403** on these.
- **Credits**: search of the public DB is free for people (`searchPeople`); company search and all enrichment consume credits. CRM reads/writes against your own account don't consume enrichment credits. Bulk enrich is billed per matched record (manifest marks bulk as 2 to flag the heavier spend).
- **Rate limits**: per-minute / hourly / daily caps per endpoint; bulk enrich is throttled to ~50% of the single-enrich per-minute limit. Watch for **429**.

## Endpoints by job

### Find net-new people & companies (public DB)
- `apollo.searchPeople` — filter Apollo's people DB by `person_titles`, `person_seniorities`, `person_locations`, `organization_num_employees_ranges`, `currently_using_any_of_technology_uids`, `q_organization_domains_list`, `q_keywords`. Returns `{ people, pagination }` **without emails/phones**. Free, master key, 100/page × 500 pages.
- `apollo.searchOrganizations` — filter the company DB by name, headcount, location, keyword tags, domains (≤1000), technology. Returns `{ organizations, pagination }`. Consumes credits.

### Enrich (get emails, titles, firmographics)
- `apollo.enrichPerson` — best identifier first: `email` > `linkedin_url` > `name`+`domain`. Returns `{ person }` (title, email, email_status, linkedin_url, organization). `reveal_personal_emails` for personal emails; `reveal_phone_number`+`webhook_url` for phones (async).
- `apollo.bulkEnrichPeople` — same fields, `details` array up to 10 people/call. Returns `{ matches }`.
- `apollo.enrichOrganization` — `domain` only (bare, no www). Returns `{ organization }` (industry, employees, revenue, founded_year, linkedin_url, phone, location).
- `apollo.bulkEnrichOrganizations` — `domains` array up to 10. Returns `{ organizations }`.

### Buying signals
- `apollo.getOrganizationJobPostings` — `organization_id` (get it from enrich/search first). Returns `{ organization_job_postings }` (title, url, city, posted_at) — a hiring/growth signal.

### Your Apollo CRM (reads)
- `apollo.searchContacts` — search contacts saved in YOUR account by `q_keywords`, `contact_stage_ids`, `contact_label_ids`. Returns `{ contacts }`.
- `apollo.searchAccounts` — search saved accounts (companies) by name/stage/label. Returns `{ accounts }`.
- `apollo.listDeals` — every deal/opportunity in your account. Returns `{ opportunities }`. Master key.
- `apollo.getUsers` — teammate IDs needed as `owner_id`/`user_id` elsewhere. Master key.

### Your Apollo CRM (writes)
- `apollo.createContact` — add a contact; set `run_dedupe:true` to avoid duplicates. Returns `{ contact }`.
- `apollo.createAccount` — add a company; requires `name`+`domain`. Master key. Returns `{ account }`.
- `apollo.createDeal` — requires `name`; link with `owner_id`/`account_id`. Master key. Returns `{ opportunity }`.
- `apollo.bulkCreateTasks` — one task per contact; requires `user_id`,`contact_ids`,`priority`,`due_at`,`type`,`status`. Master key.
- `apollo.addContactsToSequence` — push `contact_ids` into sequence `sequence_id`; `emailer_campaign_id` must equal `sequence_id` and you must pass `send_email_from_email_account_id`. Master key.

## Recipes

1. **Find + email a target persona at named companies**
   1. `apollo.searchPeople` with `{ "person_titles": ["VP of Sales"], "q_organization_domains_list": ["{{Domain}}"], "per_page": 25 }` → collect `people[].id`.
   2. `apollo.enrichPerson` per row with `{ "id": "{{Apollo Person ID}}" }` (or `{ "name": "{{Name}}", "domain": "{{Domain}}" }`) → read `person.email`, `person.email_status`.

2. **Enrich a column of names you already have**
   1. `apollo.enrichPerson` with `{ "first_name": "{{First Name}}", "last_name": "{{Last Name}}", "domain": "{{Domain}}" }` → `person.email`.
   2. For batches, prefer `apollo.bulkEnrichPeople` with up to 10 rows in `details` to save calls.

3. **Firmographic enrich + hiring signal for a company list**
   1. `apollo.enrichOrganization` with `{ "domain": "{{Domain}}" }` → read `organization.id`, headcount, revenue.
   2. `apollo.getOrganizationJobPostings` with `{ "organization_id": "{{Apollo Org ID}}" }` → flag rows where they're hiring your champion role.

4. **List build → push to outbound sequence**
   1. `apollo.searchPeople` → enrich → `apollo.createContact` (`run_dedupe:true`) to get Apollo contact IDs.
   2. `apollo.getUsers` for the sending teammate, then `apollo.addContactsToSequence` with `{ "sequence_id": "{{Seq ID}}", "emailer_campaign_id": "{{Seq ID}}", "send_email_from_email_account_id": "{{Mailbox ID}}", "contact_ids": ["{{Contact ID}}"] }`.

## Gotchas
- **Search ≠ enrich.** `searchPeople` returns NO emails/phones by design — always pipe IDs into `enrichPerson`/`bulkEnrichPeople`. Don't expect contact data from a search response.
- **Phones are async.** `reveal_phone_number` (single or bulk) requires `webhook_url`; the enrich call returns demographics synchronously and the phone arrives later via webhook — there's no phone in the immediate response body.
- **Master-key 403s.** Several CRM/search/sequence endpoints silently require a master API key and return 403 with a normal key. If a write or `searchPeople`/`getUsers` 403s, the key tier is the cause, not the payload.
- **Sequence quirk.** `emailer_campaign_id` is a required body param that must duplicate the `sequence_id` path value, and you must supply `send_email_from_email_account_id` — omitting either fails validation.
- **No dedupe by default.** `createContact`/`createAccount` create duplicates unless you pass `run_dedupe:true` (contacts) / use update endpoints (accounts).
- **Domains must be bare** (no `http://`, `www.`, or `@`) for `enrichOrganization`, `bulkEnrichOrganizations`, and domain filters.
- **Pagination cap.** Search endpoints expose at most 50,000 records (100/page × 500 pages) and job postings 10,000 — narrow filters rather than paging endlessly.
- **Bulk = ≤10.** Both bulk enrich endpoints hard-cap at 10 items per call; chunk larger lists.

## Connector mapping — pickers & rate limit
- **Rate limit**: connector default `rateLimit.rpm: 200` (paid-plan ceiling), `concurrency: 3`. Free plan is 50/min, 600/day — lower the rpm if the key is free-tier. Per-method overrides: `searchPeople`/`searchOrganizations` `rpm:100` (search endpoints), `bulkEnrichPeople` `rps:2` (credit-heavy), `addContactsToSequence` `rps:1` (documented 600/hour).
- **Selection (picker) fields** are backed by two list methods on this connector:
  - `searchSequences` — POST `/emailer_campaigns/search` → `{ emailer_campaigns: [{ id, name, active, ... }] }`. Backs `addContactsToSequence.sequence_id` and `.emailer_campaign_id` (label `name`, value `id`).
  - `listEmailAccounts` — GET `/email_accounts` → `{ email_accounts: [{ id, email, ... }] }`. Backs `addContactsToSequence.send_email_from_email_account_id` (label `email`, value `id`).
- The enrichment/search methods take only free-text names, domains, titles, locations and seniorities (no enumerable-resource ids), so they carry no `options`.

## Official docs
https://docs.apollo.io/reference (machine-readable index: https://docs.apollo.io/llms.txt)
