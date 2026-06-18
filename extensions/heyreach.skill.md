# HeyReach — Agent Skill
> LinkedIn outreach automation: push grid rows (leads) into LinkedIn sending campaigns or lists, manage senders, and read inbox conversations via the HeyReach public API.

## When to use
- **Use** to enroll grid rows into a HeyReach **campaign** (LinkedIn connection requests + message sequences) or to stage them in a **list**.
- **Use** to pause/resume a campaign, list connected LinkedIn senders, or read inbox replies.
- **Do NOT use** to *find* a LinkedIn profile URL or *enrich* a contact — HeyReach only sends. Get the `profileUrl` from an enrichment tool first, then enroll here.
- **Do NOT use** for email outreach — HeyReach is LinkedIn-only. Use Instantly/Smartlead for cold email.

## Auth & cost
- **Base URL:** `https://api.heyreach.io/api/public`
- **Auth header:** `X-API-KEY: <apiKey>` (NOT a Bearer token).
- **Cost:** HeyReach does not bill GTM-Grid credits — all methods are `credits: 0`.
- **Rate limits:** HeyReach documents a hard cap of **300 requests/minute** per API key (organization-wide). The connector throttles to `rpm: 300, concurrency: 3`, so a large enroll spreads automatically instead of bursting. Bulk endpoints take **up to 100 leads per call** — batch rather than looping one lead at a time.

## Picking campaigns / lists / senders / webhooks by name
Fields that take an id render as a **name picker** in the column editor (you choose "Marketing Q3", the **id** is stored). Every picker is backed by a real list method on this connector:
- **`campaignId`** → picked from `listCampaigns` (label `name`, sublabel `status`): used by `getCampaign`, `pauseCampaign`, `resumeCampaign`, `addLeadsToCampaign`, `getCampaignLeads`, `stopLeadInCampaign`.
- **`listId`** → picked from `listLists` (label `name`): used by `addLeadsToList`, `getList`, `getListLeads`.
- **`accountId` / `senderId` / `linkedInAccountId`** → picked from `listSenders` (label `emailAddress`, value `id`): used by `getSender`, `getMyNetwork`, and `sendMessage`.
- **`webhookId`** → picked from `listWebhooks` (label `webhookName`): used by `deleteWebhook`.

Senders inside `addLeadsToCampaign.accountLeadPairs[].linkedInAccountId` are **not** pickers (they're nested in an array) — pass them in the lead-pair objects; enumerate with `listSenders`. The same goes for the array filters `campaignIds` / `linkedInAccountIds` in `getConversations` and `getOverallStats` — they take id arrays, not single picks.

All list endpoints share the HeyReach envelope **`{ items[], totalCount }`** and paginate by `{ offset, limit }` (max 100). itemsPath is `items`, value field is the numeric `id`.

## Endpoints by job

### Enroll leads into a campaign (the core grid job)
- `heyreach.addLeadsToCampaign` — push up to 100 leads into a campaign. Pick `campaignId` by name; pass `accountLeadPairs: [{ linkedInAccountId?, lead: { profileUrl, firstName, lastName, companyName?, position?, emailAddress? } }]`. **Map grid columns** into firstName/lastName/companyName/position. `profileUrl` is required — a row with no LinkedIn URL cannot be enrolled.
- `heyreach.addLeadsToList` — stage leads in a list instead of a campaign (pick `listId` by name).

### Campaign lifecycle
- `heyreach.listCampaigns` — page campaigns with stats (`keyword` filters by name; `offset`/`limit` paginate, max 100).
- `heyreach.getCampaign` — one campaign (sequence + stats) by `campaignId`.
- `heyreach.pauseCampaign` / `heyreach.resumeCampaign` — stop / restart sending for a campaign.

- `heyreach.getCampaignLeads` — page the leads enrolled in a campaign (per-lead status). Pick `campaignId` by name.
- `heyreach.stopLeadInCampaign` — stop one lead (by `leadprofileUrl`) in a campaign.

### Lists & senders
- `heyreach.listLists` — page lead/company lists.
- `heyreach.createList` — create an empty list (returns its id; feed into `addLeadsToList`).
- `heyreach.getList` — one list by `listId`.
- `heyreach.getListLeads` — page the leads inside a list.
- `heyreach.listSenders` — connected LinkedIn sender accounts. Their `id` is the `linkedInAccountId` used in `accountLeadPairs`.
- `heyreach.getSender` — one sender by `accountId`.
- `heyreach.getMyNetwork` — page a sender's 1st-degree LinkedIn connections (`senderId`).

### Inbox
- `heyreach.getConversations` — read inbox conversations; filter by `campaignIds`, `linkedInAccountIds`, `leadProfileUrl`, or `searchString` inside `filters`.
- `heyreach.sendMessage` — send a LinkedIn message in an existing conversation (`conversationId` + sender `linkedInAccountId` + `message`).

### Stats
- `heyreach.getOverallStats` — aggregate outreach stats over a date range; optionally scope by `campaignIds` / `accountIds`.

### Webhooks
- `heyreach.listWebhooks` — list event subscriptions.
- `heyreach.createWebhook` — subscribe a `webhookUrl` to an `eventType` (optionally scoped to campaigns).
- `heyreach.deleteWebhook` — remove a webhook by `webhookId` (picked by name).

### Health
- `heyreach.checkApiKey` — validate the connected key (200 = valid).

## Recipes
1. **Enroll a grid row into a campaign**
   1. Pick `campaignId` by name (resolved from `listCampaigns`).
   2. Build one `accountLeadPairs` entry whose `lead.profileUrl` maps to `{{LinkedIn URL}}`, `lead.firstName` → `{{First Name}}`, `lead.lastName` → `{{Last Name}}`, `lead.companyName` → `{{Company}}`.
   3. Run — leads enroll in batches of ≤100, throttled to the HeyReach rate limit.

## Gotchas
- **`X-API-KEY`, not Bearer** — a `Authorization: Bearer` header fails.
- **`profileUrl` + `firstName` + `lastName` are required** on every lead — rows missing a LinkedIn URL can't be enrolled.
- **Max 100 leads per call** for `addLeadsToCampaign` / `addLeadsToList`.
- **Integer ids** — campaign/list/sender ids are numbers; the picker stores them and the connector sends them as numbers (don't paste a quoted string).
- **List vs campaign** — a list only *stages* leads; a campaign actually *sends*. Enroll into a campaign to start outreach.
