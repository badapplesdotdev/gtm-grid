# PlusVibe — Agent Skill
> Cold-email-at-scale platform (an Instantly-style tool): manage campaigns, push/enrich/query leads, control sending accounts, read the unified inbox, and pull deliverability stats.

## When to use
- Use to **manage outbound email campaigns**: create, launch/pause, add leads, update lead fields/status, and read reply/open/bounce analytics.
- Use to **query lead state** from the grid (find a lead by email, list a campaign's leads, count by status) or to **suppress** addresses via the blocklist.
- Do NOT use for finding/verifying email addresses or enriching people/companies — that's LeadMagic. PlusVibe assumes you already have the lead's email.
- Do NOT use for LinkedIn/social outreach — this is email only.

## Auth & cost
- Auth: header `x-api-key: <apiKey>`. Base URL `https://api.plusvibe.ai/api/v1`.
- **`workspace_id` is required on almost every call.** It is NOT global config — resolve it first with `plusvibe.listWorkspaces` (calls `GET /authenticate`) and reuse the `_id`.
- Rate limit: **5 requests/second** per key (documented). The manifest sets connector-level `rateLimit { rps: 5, concurrency: 3 }`, with a stricter per-method `rps: 2` on the credit-consuming `addLeads` and `replyEmail`. Batch leads into one `addLeads` call rather than one call per row.

## Picker fields (live options)
The manifest wires `options` so these inputs are picked by name from a live list (the engine stores the id/email; `workspace_id` is read from a sibling field on the same call):
- `workspace_id` (on every method except `listWorkspaces`) → `listWorkspaces` (envelope `workspaces`, label `name`, value `_id`).
- `campaign_id` / `parent_camp_id` / `camp_ids[]` → `listCampaigns` (**bare array** response — no `itemsPath`; label `camp_name`, value `id`, sublabel `status`).
- `from` (reply sending account) → `listEmailAccounts` (envelope `accounts`, label+value `email`).
- `tags` (email-account filter) → `listTags` (bare array; label `name`, value `_id`).
- Most calls are free (credits: 0). Credit cost lands on actual sending: `addLeads` and `replyEmail` consume sending volume.

## Endpoints by job

### Resolve workspace (do this first)
- `plusvibe.listWorkspaces` — validates the key, returns `{ workspaces:[{ _id, name }] }`. Grab `_id` → that's your `workspace_id`. No inputs.

### Campaigns (manage & control)
- `plusvibe.listCampaigns` — list campaigns; filter by `status` (ACTIVE/PAUSED/COMPLETED/ARCHIVED), `campaign_type` (all/parent/subseq). Returns array with ids, names, and sent/opened/replied counts. Needs `workspace_id`.
- `plusvibe.createCampaign` — create an empty campaign from `camp_name`. Returns `{ _id }` (the new campaign id).
- `plusvibe.getCampaignStatus` — status of one campaign `{ campaign_id, status }`. Needs `workspace_id` + `campaign_id`.
- `plusvibe.activateCampaign` — launch/start sending. POST body `workspace_id` + `campaign_id`.
- `plusvibe.pauseCampaign` — stop sending. POST body `workspace_id` + `campaign_id`.

### Leads (push, read, update)
- `plusvibe.addLeads` — push an array of leads into a campaign. Each lead: `email` (+ first_name, last_name, company_name, company_website, linkedin_person_url, phone_number, custom_variables, …). Needs `workspace_id` + `campaign_id` + `leads`. Returns upload counts (`leads_uploaded`, `duplicate_email_count`, `invalid_email_count`, …).
- `plusvibe.getLead` — fetch one lead by `email` (optional `campaign_id`). Returns full lead object incl. `status`, `email_opened`, `email_replied`, `lead_data`.
- `plusvibe.workspaceLeads` — list/search leads across the workspace; filter by `campaign_id`, `status`, `label`, name/email; paginate with `page`/`limit`. Returns paginated leads.
- `plusvibe.updateLeadData` — set/add custom `variables` (and label) on a lead keyed by `email`. Needs `workspace_id` + `email` + `variables`.
- `plusvibe.updateLeadStatus` — mark a lead `COMPLETED` in a campaign (only COMPLETED is accepted). Needs `workspace_id` + `campaign_id` + `email` + `new_status:"COMPLETED"`.
- `plusvibe.deleteLeads` — remove leads by email (`delete_list` array). Optional `campaign_id`, `delete_all_from_company`.
- `plusvibe.leadStatusCounts` — counts grouped by status `[{ status, count }]`; optional `campaign_id`.

### Analytics / deliverability
- `plusvibe.campaignSummary` — lifetime summary for one campaign (contacted, read, replied, bounced, unsubscribed). Needs `workspace_id` + `campaign_id`.
- `plusvibe.campaignStats` — per-campaign metrics over a date range (`start_date` required, `end_date` optional; omit `campaign_id` for all). Returns sent/opened/replied/bounced/positive_reply counts.
- `plusvibe.allCampaignsStats` — workspace-wide aggregate totals over a range. Needs `workspace_id` + `start_date` + `end_date`.

### Sending accounts & domain health
- `plusvibe.listEmailAccounts` — list sender mailboxes (`{ accounts:[{ email, status, warmup, provider, daily limits, health score, reply rate }] }`). Filter by `email` or `tags`.
- `plusvibe.checkAccountVitals` — validate SPF/DKIM/DMARC for an array of `accounts`. Returns `{ success_list:[{ domain, allPass, spf, dkim, dmarc }], failure_list }`.
- `plusvibe.listTags` — list tags `[{ _id, name, color }]`; tag ids feed `listEmailAccounts.tags`.

### Inbox (Unibox)
- `plusvibe.uniboxEmails` — list inbox/sent emails; filter by `lead` (email), `campaign_id`, `email_type` (all/received/sent), `label`. Paginate with `page_trail`. Returns `{ page_trail, data:[…] }`.
- `plusvibe.unreadCount` — `{ count }` of unread emails.
- `plusvibe.replyEmail` — reply on a thread. Needs `workspace_id` + `reply_to_id` + `subject` + `from` + `to` + `body` (HTML ok). `from` must be a connected account; prefix subject with "Re: " to keep the thread.

### Suppression & webhooks
- `plusvibe.listBlocklist` / `plusvibe.addBlocklist` — read or add emails/domains to suppression (`entries` array).
- `plusvibe.listWebhooks` / `plusvibe.addWebhook` — read or register event webhooks (e.g. `ALL_EMAIL_REPLIES`, `LEAD_MARKED_AS_INTERESTED`); `camp_ids` can be `["ALL"]`.

## Recipes
1. **Resolve workspace once** (every flow): call `plusvibe.listWorkspaces`, take `workspaces[0]._id` → reuse as `workspace_id` everywhere below.
2. **Push a grid of leads into a campaign**: `plusvibe.listCampaigns` (find the `campaign_id` by name) → `plusvibe.addLeads` with `leads: [{ email: {{Email}}, first_name: {{First Name}}, last_name: {{Last Name}}, company_name: {{Company}}, linkedin_person_url: {{LinkedIn}} }]`. Read back `leads_uploaded` / `duplicate_email_count`.
3. **Enrich a grid with reply status per lead**: for each row, `plusvibe.getLead` with `email: {{Email}}` → write `status`, `email_opened`, `email_replied` to columns.
4. **Per-campaign performance dashboard**: `plusvibe.campaignStats` with `workspace_id`, `start_date`, optional `campaign_id: {{Campaign ID}}` → map sent/opened/replied/bounced into columns.

## Gotchas
- **Every method needs `workspace_id`** except `listWorkspaces`. If a call 400s with a validation error, a missing `workspace_id` is the usual cause.
- `listWorkspaces` path is `/authenticate` — non-obvious; it doubles as the key check.
- **Stats live under `/analytics/...`** (`campaignStats` = `/analytics/campaign/stats`, `campaignSummary` = `/analytics/campaign/summary`), but `allCampaignsStats` is `/campaign/stats/all`. `campaignStats`/`allCampaignsStats` **require `start_date`** (and `allCampaignsStats` also `end_date`) — omitting them errors.
- `updateLeadStatus` only accepts `new_status:"COMPLETED"` — any other value 400s. To change interest, use `updateLeadData` to set the label instead.
- `replyEmail` takes `workspace_id` as a **query** param while the rest of the body is JSON; `from` must be a mailbox connected in the workspace, and HTML special chars must be JSON-escaped in `body`.
- `uniboxEmails` paginates via the opaque `page_trail` token (not page numbers) — pass the returned `page_trail` back to get the next page.
- Mind the **5 req/s** limit: enrich-per-row flows (`getLead`) over large grids will throttle — keep batches modest or add backoff.
- `addLeads` returns success even when rows are skipped/deduped — always check `duplicate_email_count`/`invalid_email_count`/`skipped`, not just `status`.
