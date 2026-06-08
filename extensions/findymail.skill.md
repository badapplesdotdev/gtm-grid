# FindyMail — Agent Skill
> Find and verify B2B work emails (and direct phones) from a name+domain or a LinkedIn URL — reach for it when you have a person and need a deliverable, verified work email.

## When to use
- You have a person (name + company domain, or a LinkedIn profile URL) and need their **verified work email** → `findFromName` / `findFromLinkedin`. FindyMail verifies before returning, so hit rates skew high-quality.
- You have an email and need to confirm it's deliverable (`verify`), or need to reverse it to a person/company (`reverseEmail`).
- You need a **direct phone** from a LinkedIn URL (`findPhone`) — but note it costs 10 credits per hit, so gate it.
- NOT for bulk net-new prospecting from scratch unless you want the async IntelliMatch lead finder (`leadSearch`) — for known-person enrichment the `/search/*` calls are the right tools. Not for personal/B2C emails.

## Auth & cost
- **Auth:** `Authorization: Bearer <apiKey>` (manifest `auth.header = Authorization`, secret = `apiKey`).
- **Base URL:** `https://app.findymail.com/api` (manifest paths are relative to this, so `/search/name` → `https://app.findymail.com/api/search/name`).
- **Content-Type:** `application/json` for POST bodies.
- **Credits (real FindyMail credits, independent of grid `credits` field):**
  - Email finds (`findFromName`, `findFromLinkedin`): 1 credit **only if found** — no-result is free.
  - `verify`: uses verifier credits (separate pool from finder credits).
  - `findPhone`: **10 credits if a phone is found** — most expensive call; free if not found.
  - `reverseEmail`: 1 credit, **2 with `with_profile=true`**.
  - `findCompany`: 1 credit per success. `findEmployees`: 1 credit **per contact returned**.
  - `leadResults`: consumes credits per record; `leadStatus` / `listContactLists` / `credits` are free.
- **Rate limit:** up to ~300 concurrent requests by default. `402` response = out of credits.
- Check balance any time with `findymail.credits` (free) → `{ credits, verifier_credits }`.

## Endpoints by job

### Find an email
- `findymail.findFromName` — POST `/search/name`. Inputs: `name`, `domain`. Returns `{ contact: { name, email, domain } }`. Best when you have a clean full name + company domain.
- `findymail.findFromLinkedin` — POST `/search/linkedin`. Input: `linkedin_url`. Returns `{ contact: { name, email, domain, linkedin_url } }`. Best when you only have a LinkedIn URL.

### Verify / reverse an email
- `findymail.verify` — POST `/verify`. Input: `email`. Returns `{ verified, provider }`. Use to confirm deliverability before sending.
- `findymail.reverseEmail` — POST `/search/reverse-email`. Inputs: `email`, optional `with_profile`. Returns `{ contact }` (with LinkedIn profile fields when `with_profile=true`, +1 credit).

### Find a phone
- `findymail.findPhone` — POST `/search/phone`. Input: `linkedin_url`. Returns `{ phone }`. 10 credits on hit — only call after the lead is qualified.

### Enrich company / find people
- `findymail.findCompany` — POST `/search/company`. Inputs (≥1 of): `domain`, `name`, `linkedin_url`. Returns `{ company: { name, domain, company_size, industry, ... } }`.
- `findymail.findEmployees` — POST `/search/employees`. Inputs: `website`, `job_titles` (array), optional `count`. Returns `{ contacts: [{ name, linkedin_url, job_title }] }`. 1 credit per contact returned — set `count` to cap spend.

### Lead finder (IntelliMatch — async)
- `findymail.leadSearch` — POST `/intellimatch/search`. Inputs: `query` (natural language), optional `limit`, `config` (`find_contact`, `find_email`). Returns `{ hash }`. Does NOT return results directly.
- `findymail.leadStatus` — GET `/intellimatch/status`. Input: `hash`. Returns `{ status }`. Poll until complete.
- `findymail.leadResults` — GET `/intellimatch/data`. Inputs: `hash`, optional `page`. Returns `{ data: [{ name, domain, contact, email }] }`. Consumes credits per record.

### Contact lists / credits
- `findymail.listContactLists` — GET `/lists`. Returns `{ lists: [{ id, name }] }`. Free.
- `findymail.createContactList` — POST `/lists`. Input: `name`. Returns the created list. Free.
- `findymail.getContacts` — GET `/lists/{id}/contacts`. Inputs: `id`, optional `page`. Returns `{ contacts: [...] }`. Free.
- `findymail.credits` — GET `/credits`. Returns `{ credits, verifier_credits }`. Free.

## Recipes

1. **Find a work email from name + company**
   1. `findymail.findFromName` with `{ "name": "{{Full Name}}", "domain": "{{Company Domain}}" }`
   2. Read `contact.email` from the result. (Already verified by FindyMail — no separate verify needed.)

2. **Find a work email from a LinkedIn URL, then get the phone if qualified**
   1. `findymail.findFromLinkedin` with `{ "linkedin_url": "{{LinkedIn URL}}" }` → `contact.email`
   2. Only if the lead is qualified, `findymail.findPhone` with `{ "linkedin_url": "{{LinkedIn URL}}" }` → `phone` (10 credits on hit).

3. **Validate an email column you already have**
   1. `findymail.verify` with `{ "email": "{{Email}}" }` → keep rows where `verified` is true.

4. **Build a net-new lead list from a description (async)**
   1. `findymail.leadSearch` with `{ "query": "{{ICP description}}", "config": { "find_contact": true, "find_email": true } }` → save `hash`
   2. `findymail.leadStatus` with `{ "hash": "{{hash}}" }` — repeat until `status` is complete
   3. `findymail.leadResults` with `{ "hash": "{{hash}}" }` → `data[]` of companies/contacts/emails.

## Gotchas
- **No-result is free for finders, but a hit always charges.** Loop budget = (rows that resolve), not rows attempted. `findPhone` hits cost 10 credits each — gate it behind qualification.
- **Two credit pools:** finder credits vs. verifier credits. `credits` returns both as `{ credits, verifier_credits }`; a finder failing for "no credits" won't be fixed by topping up verifier credits.
- **IntelliMatch is async** — `leadSearch` returns only a `hash`, never inline results. You MUST poll `leadStatus` before `leadResults`, or you'll get an empty/incomplete payload.
- **`reverseEmail` profile data is opt-in:** without `with_profile=true` you get basic contact only; flipping it on costs +1 credit.
- **`findEmployees` charges per returned contact** — always pass `count` to cap spend; results are returned as a list, not a single object.
- **402 = out of credits**, not a bad request. Check `findymail.credits` before large batches.
- **Auth header is `Authorization` with a raw Bearer token** (unusual — many enrichment APIs use `X-API-Key`); don't reach for an `X-API-Key` header.
