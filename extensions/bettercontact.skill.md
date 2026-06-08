# BetterContact — Agent Skill
> Async waterfall enrichment: finds & verifies work emails and direct phone numbers by fanning a lead across 20+ providers — reach for it when a single-source finder (e.g. LeadMagic) misses, or when you need the highest email/phone hit rate.

## When to use
- You have name + company (or domain) and need a **verified work email** and/or **direct phone**, and want max coverage from a waterfall instead of one provider.
- You want to **find net-new leads** by company/people filters (no input list) — use `findLeads`.
- NOT for instant lookups: every enrichment is **async** (submit → poll, minutes later). If you need a sub-second single email and a partial hit rate is fine, a synchronous finder is cheaper/faster.
- NOT for LinkedIn-profile or company-firmographic enrichment on its own — this tool is email/phone (and lead discovery) first.

## Auth & cost
- **Auth:** API key in `X-API-Key` header (manifest `auth.secretKey = apiKey`).
- **Base URL:** `https://app.bettercontact.rocks/api/v2`
- **Credits:** Charged on the **submit** call, billed per enriched contact (email and/or phone). Polling results is free. Lead-finder discovery is heavier (charged per lead returned). `checkCredits` is free.
- **Rate/quota:** Account-level credit pool; check it with `bettercontact.checkCredits` before large batches.

## Endpoints by job

### Enrich existing leads (email / phone)
- `bettercontact.enrich` — submit 1–100 leads for waterfall email/phone enrichment. Inputs: `data[]` (each lead: `first_name`, `last_name`, `company` OR `company_domain`, optional `linkedin_url` [recommended for phone], optional `custom_fields`), `enrich_email_address` (bool, default true), `enrich_phone_number` (bool). Returns `{ success, id, message }` — `id` is the poll key. **Async.**
- `bettercontact.getResult` — poll by `request_id`. Returns `{ id, status, credits_consumed, credits_left, summary, data[] }`. `status` = `pending` → `terminated`. Each `data` item: `enriched`, `contact_email_address`, `contact_email_address_status`, `contact_phone_number`, `contact_job_title`, `contact_gender`, `email_provider`, `custom_fields`. Free.

### Find net-new leads (prospecting)
- `bettercontact.findLeads` — submit a People/Company search. Input: `filters` object (company: `company` domains, `company_industry`, `company_technology`, `company_headcount_min/max`; people: `lead_fullname`, `lead_linkedin_url`, `lead_department`, `lead_function`, `lead_skills`, `lead_job_title` [+`exact_match`], `lead_location`, `lead_seniority` — each `{ include:[...], exclude:[...] }`), plus `limit` (1–200, default 100) and `offset`. Returns `{ success, message, request_id }`. **Async.**
- `bettercontact.getFoundLeads` — poll by `request_id`. Returns `{ id, status, credits_consumed, credits_left, summary:{ leads_found }, leads[] }`. Each lead has contact (name, job_title, seniority, linkedin_url, location, email, phone) + company (name, domain, industry, headcount, hq, founded) fields. Free.

### Account
- `bettercontact.checkCredits` — input `email` (account email). Returns `{ success, credits_left, email }`. Free. Use before bulk runs.

## Recipes

1. **Find + verify a work email for a known person**
   1. `bettercontact.enrich` with `{ data: [{ first_name: "{{First Name}}", last_name: "{{Last Name}}", company_domain: "{{Domain}}", linkedin_url: "{{LinkedIn URL}}" }], enrich_email_address: true }` → capture `id`.
   2. Poll `bettercontact.getResult` with `{ request_id: "{{id}}" }` until `status === "terminated"`; read `data[0].contact_email_address` and `contact_email_address_status`.

2. **Get a direct phone number**
   1. `bettercontact.enrich` with `{ data: [{ first_name: "{{First Name}}", last_name: "{{Last Name}}", company_domain: "{{Domain}}", linkedin_url: "{{LinkedIn URL}}" }], enrich_phone_number: true }` (include `linkedin_url` — it lifts phone hit rate) → capture `id`.
   2. Poll `bettercontact.getResult` with `{ request_id: "{{id}}" }` → `data[0].contact_phone_number`.

3. **Enrich a batch and keep row identity**
   1. `bettercontact.enrich` with `data` of up to 100 leads, each carrying `custom_fields: { uuid: "{{Row ID}}" }`, `enrich_email_address: true`.
   2. Poll `bettercontact.getResult`; match each returned `data[i].custom_fields.uuid` back to its grid row (order is not guaranteed — join on the uuid).

4. **Prospect net-new leads, then page through them**
   1. `bettercontact.findLeads` with `{ filters: { lead_job_title: { include: ["Head of Sales"] }, lead_seniority: { include: ["director","vp"] }, company_headcount_min: 50 }, limit: 100 }` → capture `request_id`.
   2. Poll `bettercontact.getFoundLeads` with `{ request_id }` until `terminated`; read `leads[]` and `summary.leads_found`.
   3. For more pages, call `findLeads` again with the same `filters` and an increased `offset`.

## Gotchas
- **Everything is async.** Submit returns only an id/request_id (HTTP 201), never the data. You MUST poll the matching GET until `status === "terminated"` — `pending` means not ready. Build columns as submit-then-poll, not one-shot.
- **Two separate poll endpoints.** Use `getResult` for `enrich` ids and `getFoundLeads` for `findLeads` request_ids — they are different paths, don't cross them.
- **Credits charge on submit, not poll.** Re-polling is free; re-submitting re-charges. Cache the id.
- **Lead requires name + a company anchor.** Each lead needs `first_name` + `last_name` + (`company` OR `company_domain`). `company_domain` resolves better than a bare company name.
- **Phone needs hints.** `enrich_phone_number` alone often whiffs without `linkedin_url`; always pass it when chasing phones.
- **Result order ≠ input order.** Join batch results back to rows via `custom_fields` (e.g. a uuid), not array index.
- **Toggle what you pay for.** `enrich_email_address` defaults true; set it false if you only want phone, and vice-versa, to avoid paying for both.
- **`checkCredits` needs the account `email`** as a query param (alongside the key), not just the API key.
- **Errors:** `401` = bad/missing API key; `406` = malformed/unknown `request_id` on the poll endpoints.

Official docs: https://doc.bettercontact.rocks/api-reference (OpenAPI: https://doc.bettercontact.rocks/api-reference/openapi.json)
