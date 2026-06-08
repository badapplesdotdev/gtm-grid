# Smartlead — Agent Skill
> Run cold email at scale — manage Smartlead campaigns, push leads into sequences, read per-lead and per-campaign send stats, and inspect connected sending inboxes.

## When to use
- Use to push enriched leads from a grid into a Smartlead campaign sequence, then read back open/click/reply/bounce activity for each lead.
- Use to discover campaign ids (list/get), check a lead's status by email, or audit which sending inboxes (email accounts) are connected.
- Use for outbound *cold email* orchestration specifically — sequence sending, deliverability inboxes, reply tracking.
- Do NOT use for finding/verifying email addresses or enriching people/companies (that's LeadMagic/Trigify), for LinkedIn/social outreach (HeyReach), or for meeting/transcript data (Fireflies). Smartlead only knows leads and sends inside *your* Smartlead workspace.

## Auth & cost
- **Base URL:** `https://server.smartlead.ai/api/v1`.
- **Auth:** Smartlead authenticates with an `api_key` **query parameter**, NOT a header. Every request appends `?api_key=<apiKey>` (the manifest injects this from the `apiKey` secret). A missing/invalid key returns `401`. Grab the key from Smartlead → Settings → API.
- **Credits:** API calls themselves are free (`credits: 0` on every method) — you pay for sending via your Smartlead plan/lead limits, not per API request.
- **Rate limits:** ~60 requests per 60 seconds per API key, and no more than ~10 requests per 2 seconds. Heavy write endpoints (campaign create, lead upload) are throttled lower (~30/min). All endpoints share one bucket. Watch `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` response headers and back off on `429`.

## Endpoints by job

**Find / read campaigns**
- `smartlead.listCampaigns` — `GET /campaigns/`. Lists every campaign in the workspace; returns a direct array of campaign objects (id, name, status, schedule, tracking settings). Optional `include_tags` (boolean) to attach campaign tags. Use this to resolve a campaign name → id.
- `smartlead.getCampaign` — `GET /campaigns/{campaign_id}`. Fetches one campaign by `campaign_id` (integer, required). Returns the full single-campaign config object.

**Push leads into a sequence**
- `smartlead.addLeadsToCampaign` — `POST /campaigns/{campaign_id}/leads`. Adds contacts to a campaign (max **400** per call; keep batches small — heavier endpoint). Required: `campaign_id` and `lead_list` (array of lead objects, each requiring at least `email`; optional `first_name`, `last_name`, `company_name`, `phone_number`, `website`, `location`, `linkedin_profile`, `custom_fields`). Optional `settings` controls import behavior (`ignore_global_block_list`, `ignore_unsubscribe_list`, `ignore_duplicate_leads_in_other_campaign`, etc.). Returns `{ added_count, skipped_count, skipped_leads }`.

**Look up a lead**
- `smartlead.fetchLeadByEmail` — `GET /leads/`. Finds a single lead by `email` (string, required). Returns the lead object (id, status, campaign membership), or `{}` if no match exists in the workspace.

**Read performance**
- `smartlead.campaignStatistics` — `GET /campaigns/{campaign_id}/statistics`. Per-lead / per-sequence-step activity for a campaign: sent, opened, clicked, replied, bounced. Required `campaign_id` (integer); paginate with `offset` and `limit` (max **1000**).

**Audit sending inboxes**
- `smartlead.listEmailAccounts` — `GET /email-accounts/`. Lists all connected sending email accounts (senders/mailboxes) used to dispatch sequences. Paginate with `offset` and `limit`. Use to confirm warm inboxes are attached before launching.

## Recipes
1. **Resolve a campaign by name, then push grid leads into it**
   1. `smartlead.listCampaigns` (optionally `include_tags: true`) → find the object whose `name` matches the target and grab its `id`.
   2. `smartlead.addLeadsToCampaign` with `campaign_id: <id>` and `lead_list: [{ "email": "{{Email}}", "first_name": "{{First Name}}", "last_name": "{{Last Name}}", "company_name": "{{Company}}", "linkedin_profile": "{{LinkedIn URL}}" }]`. Read back `added_count` / `skipped_leads`.

2. **Enrich a grid column with a lead's send status**
   - `smartlead.fetchLeadByEmail` with `email: "{{Email}}"` → if it returns `{}` the contact isn't in Smartlead yet; otherwise read its status/campaign fields.

3. **Pull reply/open activity for a campaign into the grid**
   1. `smartlead.getCampaign` with `campaign_id: {{Campaign ID}}` to confirm it's live.
   2. `smartlead.campaignStatistics` with `campaign_id: {{Campaign ID}}`, `offset: 0`, `limit: 1000`; page with `offset += 1000` until fewer than `limit` rows return. Match each stat row back to a lead by email.

4. **Pre-flight check before launching a send**
   - `smartlead.listEmailAccounts` (`limit: 100`) to verify warmed sending inboxes are connected, then `smartlead.listCampaigns` to confirm the campaign is in the expected status.

## Gotchas
- **`api_key` is a QUERY param, not a header.** Never put it in `Authorization`; Smartlead ignores header auth and returns `401`.
- **Lead uploads are batched and capped at 400 per call** — split larger grids across multiple `addLeadsToCampaign` calls, and respect the lower ~30/min throttle on this write endpoint.
- **`addLeadsToCampaign` silently skips, it doesn't error.** Always inspect `skipped_count` / `skipped_leads` — duplicates, block-list hits, and unsubscribes are dropped unless you override via `settings`. A `200` does not mean every lead was added.
- **`email` is the only required lead field**, but sending personalization needs `first_name`/`company_name`/`custom_fields` populated — missing merge fields render as blanks in the email, not an error.
- **`fetchLeadByEmail` returns `{}` (empty object), not a 404**, when the lead isn't found — branch on emptiness, not HTTP status.
- **`listCampaigns` returns a bare array**, not a wrapped `{ data: [] }` object — index into it directly.
- **Statistics paginate** — `limit` maxes at 1000; loop `offset` to get every row, or you'll silently truncate large campaigns.
- **All endpoints share one rate bucket** (~60/min, ~10/2s). Mixing campaign + lead + stats calls counts together — throttle on `429` using `X-RateLimit-Reset`.
- **campaign ids are integers** — pass `campaign_id` as a number, not a string.
- Docs: https://api.smartlead.ai/reference/introduction · full index at https://api.smartlead.ai/llms.txt.
