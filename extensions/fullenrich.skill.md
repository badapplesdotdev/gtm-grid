# FullEnrich — Agent Skill
> Waterfall email & phone enrichment that fans a contact across 15+ data vendors — reach for it when you need the highest hit-rate work email or mobile for a known person, and accuracy matters more than speed.

## When to use
- **Use** to enrich a known person (name + company/domain, ideally + LinkedIn URL) into a verified work email and/or mobile phone — `enrichBulk` runs a waterfall across many providers, so hit-rates beat any single-vendor finder.
- **Use** to reverse-resolve an email back into a full person + company profile (`reverseEmailBulk`) — e.g. enriching inbound signups from just their email.
- **Use** `searchPeople` / `searchCompany` to build a prospect/account list from filters (title, company, location, headcount) when you don't yet have names.
- **Do NOT use** for a single quick lookup where latency matters: enrichment and reverse lookup are ASYNC (submit → poll). For an instant single-record email finder, prefer a synchronous tool like LeadMagic. Search endpoints ARE synchronous.

## Auth & cost
- **Base URL:** `https://app.fullenrich.com/api/v1` (paths below are relative to it; FullEnrich's own docs label them `/api/v2` but the routes are identical).
- **Auth:** Bearer token in the `Authorization` header. Grid stores it as the `apiKey` secret; the connector adds `Authorization: Bearer <apiKey>` for you.
- **Credits:** Enrich/reverse cost ~1 credit per successfully enriched contact (charged on the contact, not the submit); polling and account calls are free. Search endpoints charge per call/page. Check live balance with `fullenrich.credits`.
- **Rate limit:** FullEnrich allows **60 API calls/minute** across all endpoints, with a queue of **100 concurrent enrichments** (and 100 concurrent reverse lookups). The connector enforces this at the manifest level (`rateLimit: { rpm: 60, concurrency: 100 }`); `enrichBulk` carries a stricter per-method override (`rps: 1`) because it is the credit-consuming bulk submit. Bulk endpoints take up to 100 contacts/call, so ~6000 contacts/min is achievable. Status `RATE_LIMIT` in a poll means back off.

## Picker (selection) fields
- **None.** FullEnrich is a stateless enrichment/search API. Every input is free-text (names, domains, emails) or an id that a *prior* call on this connector returned (`enrichment_id` from `enrichBulk`/`reverseEmailBulk`) — there is no endpoint that *enumerates* enrichments, lists, accounts, campaigns, etc. So no field is backed by a live list; no `options` blocks are wired. `enrich_fields` is a fixed enum (`contact.emails`, `contact.phones`), not an enumerable resource. If FullEnrich later ships a "list enrichments" endpoint, `enrichment_id` could become a picker.

## Endpoints by job

### Enrich a known person → email + phone (async)
- `fullenrich.enrichBulk` — submit 1–100 contacts for waterfall email/phone enrichment. Inputs: `name` (label), `datas[]` each `{ firstname, lastname, domain, company_name, linkedin_url, enrich_fields: ["contact.emails","contact.phones"] }`, optional `webhook_url`. Returns `{ enrichment_id }`. Minimum viable input per contact: firstname + lastname + (domain OR company_name); add `linkedin_url` to lift hit-rate.
- `fullenrich.getResult` — poll with `{ enrichment_id }`. Returns `{ status, datas[] }`; `status` is `CREATED`/`IN_PROGRESS` until `FINISHED`. Each item: `datas[].contact { most_probable_email, emails[]{email,status}, phones[]{number,region} }`.

### Reverse an email → person + company (async)
- `fullenrich.reverseEmailBulk` — submit `data[]` of `{ email, custom? }` plus a `name` label. Returns `{ enrichment_id }`. Use to identify who is behind an email.
- `fullenrich.getReverseEmailResult` — poll with `{ enrichment_id }`. Returns `{ id, name, status, cost, data[] }`; `status` values `CREATED|IN_PROGRESS|RATE_LIMIT|FINISHED|CANCELED|CREDITS_INSUFFICIENT`. Each `data[]` item carries the input email + the resolved person & company profile.

### Build a list from filters (synchronous, no polling)
- `fullenrich.searchPeople` — filter people by `current_position_titles`, `current_position_seniority_level`, `current_company_names`/`current_company_domains`, `current_company_headcounts` ([{min,max}]), `person_locations`, `person_skills`, etc. Each filter array holds `{ value, exclude?, exact_match? }`. Paging: `limit` (≤100), `offset` (≤10000), then `search_after` cursor. Returns `{ people[], metadata{ total, credits, search_after } }`.
- `fullenrich.searchCompany` — filter companies by `names`, `domains`, `industries`, `keywords`, `specialties`, `headquarters_locations`, `founded_years`/`headcounts` ([{min,max}]), `professional_network_urls`, etc. Filters within one field combine with AND. Same `limit`/`offset`/`search_after` paging. Returns company objects + `metadata`.

### Account
- `fullenrich.credits` — `{ balance }` of remaining workspace credits. Free.
- `fullenrich.verifyApiKey` — confirms the key works; returns `{ workspace_id }` (200) or 401. Free. Use to sanity-check setup before a big batch.

## Recipes

1. **Enrich a grid of known people (name + company → verified email/phone):**
   1. `fullenrich.enrichBulk` with `{ name: "grid batch", datas: [{ firstname: "{{First Name}}", lastname: "{{Last Name}}", domain: "{{Domain}}", company_name: "{{Company}}", linkedin_url: "{{LinkedIn URL}}", enrich_fields: ["contact.emails","contact.phones"] }] }` → capture `enrichment_id`.
   2. `fullenrich.getResult` with `{ enrichment_id: "{{Enrichment Id}}" }`; re-call until `status === "FINISHED"`, then read `datas[].contact.most_probable_email` and `datas[].contact.phones`.

2. **Identify inbound signups from their email (email → person/company):**
   1. `fullenrich.reverseEmailBulk` with `{ name: "inbound", data: [{ email: "{{Email}}" }] }` → capture `enrichment_id`.
   2. `fullenrich.getReverseEmailResult` with `{ enrichment_id: "{{Enrichment Id}}" }` until `status === "FINISHED"`; read the resolved person + company from each `data[]` item.

3. **Build a target list, then enrich it:**
   1. `fullenrich.searchPeople` with `{ current_position_titles: [{ value: "Head of Sales" }], current_company_headcounts: [{ min: 50, max: 500 }], person_locations: [{ value: "United Kingdom" }], limit: 100 }` (synchronous) → take `people[]`.
   2. Feed each result's name + company into `fullenrich.enrichBulk` (Recipe 1) for emails/phones.

4. **Pre-flight check before a large batch:**
   1. `fullenrich.verifyApiKey` (expect `{ workspace_id }`); 2. `fullenrich.credits` and confirm `balance` covers the batch size before submitting.

## Gotchas
- **Async submit/poll, not request/response:** `enrichBulk` and `reverseEmailBulk` return only `{ enrichment_id }`. You MUST poll the matching GET (or set `webhook_url`) — the email/phone is never in the submit response. The two flows use different poll endpoints (`getResult` vs `getReverseEmailResult`) — don't cross them.
- **Status gates the data:** treat results as not-ready while `status` is `CREATED`/`IN_PROGRESS`/`RATE_LIMIT`. Only `FINISHED` is complete; `CANCELED`/`CREDITS_INSUFFICIENT` mean no data is coming.
- **`datas` vs `data`:** enrich uses `datas` (contacts), reverse uses `data` (emails). Easy to swap by mistake — they are not interchangeable.
- **`enrich_fields` controls cost & output:** omit it and you may not get phones (or any field). Always pass `["contact.emails","contact.phones"]` (or the subset you want).
- **Hit-rate lever:** firstname + lastname + (domain OR company_name) is the minimum; adding `linkedin_url` materially raises email/phone hit-rate.
- **Search is paginated:** `searchPeople`/`searchCompany` default to 10 results, max 100 per page. Use `offset` up to 10000, then switch to the `search_after` cursor from `metadata` for deeper pages. Each page consumes credits (`metadata.credits`).
- **Search filter shape:** filter values are arrays of objects (`{ value, exclude?, exact_match? }`), not bare strings; ranges are `[{ min, max }]`. A bare string will be rejected.
- **Webhook retries:** a non-2xx response to `webhook_url` is retried every minute up to 5 times — make the receiver idempotent. Polling is the fallback if you don't run a webhook.
