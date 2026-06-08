# HeyReach — Agent Skill
> Drive LinkedIn outreach automation from a grid: list senders, push leads into campaigns or lists, and read inbox replies — the right tool when a column needs to ACT on people (sequence them, sort them into lists) rather than find or enrich them.

## When to use
- Use to take a grid of LinkedIn profiles and push them into a HeyReach campaign (to start an outreach sequence) or into a lead list (to stage them for later).
- Use to read your HeyReach inbox — pull conversations/replies filtered by sender account, campaign, or a specific lead's profile URL — to surface who responded.
- Use to discover the building blocks you need before pushing: campaign ids (`listCampaigns`), list ids (`listLists`), and sender account ids (`listSenders`).
- Do NOT use to find or verify emails, enrich a person/company, or look up a profile by name — that's LeadMagic/Trigify. HeyReach only knows profiles you already give it; it does outreach, not discovery.

## Auth & cost
- **Base URL:** `https://api.heyreach.io/api/public` (set in the manifest).
- **Auth:** `X-API-KEY: <apiKey>` header on every request (manifest maps the `apiKey` secret to that header). Keys never expire but can be revoked in the HeyReach app. Validate with `heyreach.checkApiKey` (returns 200 when valid).
- **Cost:** these public-API calls cost **0 platform credits** — HeyReach bills on LinkedIn sender-account seats, not per API call. Adding a lead to a campaign does consume that campaign's sending capacity downstream.
- **Rate limit:** **300 requests / minute** across the whole API key. Back off on HTTP 429.

## Endpoints by job

**Auth check**
- `heyreach.checkApiKey` — `GET /auth/CheckApiKey`. No inputs. Returns 200 if the key is valid; use it as a connectivity/credentials probe before a batch run.

**Find the ids you need (senders, campaigns, lists)**
- `heyreach.listSenders` — `POST /li_account/GetAll`. Lists connected LinkedIn sender accounts. Inputs: `offset`, `limit`, `keyword`. Each account's `id` is the `linkedInAccountId` used everywhere else.
- `heyreach.listCampaigns` — `POST /campaign/GetAll`. Lists campaigns with progress stats. Inputs: `offset`, `limit` (≤100), `keyword` (filter by name). Returns campaign `id`, name, and status — you need the `id` (and an ACTIVE status) before pushing leads.
- `heyreach.getCampaign` — `GET /campaign/GetById`. One campaign by `campaignId` (required), including its sequence and stats. Use it to confirm a campaign is active and which senders are assigned.
- `heyreach.listLists` — `POST /list/GetAll`. Lists your lead/company lists. Inputs: `offset`, `limit` (≤100), `keyword`. Returns each list's `id`.

**Push leads (the core action)**
- `heyreach.addLeadsToCampaign` — `POST /campaign/AddLeadsToCampaignV2`. Pushes leads into a campaign to start the sequence. Inputs: `campaignId` (required) + `accountLeadPairs` (required, max **100**) — each pair is `{ linkedInAccountId?, lead }`. `lead` requires `profileUrl` + `firstName` + `lastName` (optional `companyName`, `position`, `emailAddress`). Optional `linkedInAccountId` binds the lead to a specific sender already on the campaign; omit it to let HeyReach round-robin senders. Returns a per-lead add result.
- `heyreach.addLeadsToList` — `POST /list/AddLeadsToListV2`. Adds leads to a list (staging, no sending). Inputs: `listId` (required) + `leads` (required array, max **100**), each lead `{ profileUrl, firstName, lastName, companyName?, position? }`.

**Read the inbox**
- `heyreach.getConversations` — `POST /inbox/GetConversationsV2`. Reads inbox conversations/replies. Inputs: `offset`, `limit` (≤100), and `filters { campaignIds[], linkedInAccountIds[], leadProfileUrl, searchString }`. Filter by `leadProfileUrl` to fetch the thread for one specific person, or by `campaignIds`/`linkedInAccountIds` to triage a whole campaign or sender's inbox.

## Recipes
1. **Push a grid of profiles into a campaign**
   1. `heyreach.listCampaigns` with `{ "keyword": "Q3 Founders", "limit": 100 }` → grab the ACTIVE campaign's `id`.
   2. `heyreach.addLeadsToCampaign` with `{ "campaignId": <id>, "accountLeadPairs": [ { "lead": { "profileUrl": "{{LinkedIn URL}}", "firstName": "{{First Name}}", "lastName": "{{Last Name}}", "companyName": "{{Company}}", "position": "{{Title}}" } } ] }`. Batch ≤100 rows per call.

2. **Stage leads into a list for later**
   1. `heyreach.listLists` with `{ "keyword": "Inbound 2026", "limit": 100 }` → grab the list `id` (or note none exists).
   2. `heyreach.addLeadsToList` with `{ "listId": <id>, "leads": [ { "profileUrl": "{{LinkedIn URL}}", "firstName": "{{First Name}}", "lastName": "{{Last Name}}" } ] }`.

3. **Bind each lead to a specific sender (round-robin override)**
   1. `heyreach.listSenders` with `{ "limit": 100 }` → map sender names to `linkedInAccountId`s.
   2. `heyreach.addLeadsToCampaign` with each pair as `{ "linkedInAccountId": {{Sender Account Id}}, "lead": { "profileUrl": "{{LinkedIn URL}}", "firstName": "{{First Name}}", "lastName": "{{Last Name}}" } }`. The sender must already be assigned to that campaign.

4. **Find who replied to one lead**
   - `heyreach.getConversations` with `{ "limit": 50, "filters": { "leadProfileUrl": "{{LinkedIn URL}}" } }` to pull that person's thread, or `{ "filters": { "campaignIds": [<id>] } }` to triage a whole campaign's inbox.

## Gotchas
- **firstName + lastName are mandatory.** A lead with only `profileUrl` is silently dropped — the call can return 200 while that lead is never added. Always supply `profileUrl`, `firstName`, AND `lastName`; fill blanks rather than omitting the keys.
- **Campaign must be ACTIVE before you push.** `addLeadsToCampaign` only works against a running campaign — a DRAFT/paused campaign rejects or no-ops the leads. Confirm status via `listCampaigns`/`getCampaign` first; create + start the campaign in the HeyReach app.
- **`linkedInAccountId` must already be on the campaign.** Binding a lead to a sender that isn't assigned to that campaign fails for that pair. Omit `linkedInAccountId` to let HeyReach distribute across the campaign's senders.
- **Batch cap is 100.** Both `addLeadsToCampaign` (`accountLeadPairs`) and `addLeadsToList` (`leads`) cap at 100 items per call — chunk larger grids and loop.
- **Pagination is offset/limit, capped at 100.** `listCampaigns`, `listLists`, `listSenders`, and `getConversations` page with `offset` + `limit` (max 100). Increment `offset` by your page size until you get a short page; don't assume the first page is the whole set.
- **Rate limit is 300 req/min per key.** Bulk loops (one call per chunk plus lookups) hit it fast — throttle and retry on HTTP 429.
- **Duplicate profileUrls are deduped by HeyReach**, so re-pushing the same person won't double-sequence them, but it also won't surface an error — don't rely on the add count to detect duplicates.
- Docs: HeyReach API Postman collection — https://documenter.getpostman.com/view/23808049/2sA2xb5F75 · "How to add leads to campaigns" — https://help.heyreach.io/en/articles/11657798-how-to-add-leads-to-campaigns
