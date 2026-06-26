# Instantly — Agent Skill
> Cold-email outreach engine: push leads into sending campaigns, verify deliverability, manage sender inboxes, and read send/reply analytics via the Instantly V2 API.

## When to use
- **Use** to enroll grid rows (leads) into an Instantly campaign, verify an email before sending, pull campaign/account performance numbers, or read/reply to inbox replies.
- **Use** to manage sending infrastructure: connect/pause/resume sender accounts, check warmup health, create/start/pause campaigns.
- **Do NOT use** to *find* or *enrich* an email/profile — Instantly only verifies and sends. Use an enrichment tool (e.g. LeadMagic `emailFinder`) to get the address first, then Instantly to verify + enroll.
- **Do NOT use** for one-off transactional sends — Instantly is sequence/campaign-based, not a generic email API.

## Auth & cost
- **Base URL:** `https://api.instantly.ai/api/v2`
- **Auth header:** `Authorization: Bearer <apiKey>` (V2 key; requires Growth plan or above). V1 keys do NOT work.
- **Cost:** Read/management calls are free. Instantly does not bill GTM-Grid "credits" for most calls. Manifest credit hints: `verifyEmail` = 1 (email-verification consumes Instantly verification credits), `bulkAddLeads`/`moveLeads` = 2 (heavy async jobs). Everything else = 0.
- **Rate limits:** Standard REST limits apply; list endpoints are cursor-paginated (100/page max). Batch lead writes through `bulkAddLeads` rather than looping `createLead`.

## Endpoints by job

### Enroll leads into a campaign (the core grid job)
- `instantly.createLead` — add ONE contact to a campaign or list. Only `email` required; pass `campaign` (the campaign **UUID** — the field is `campaign`, NOT `campaign_id`). Map any standard fields (first_name/last_name/company_name/phone/website) plus `custom_variables` (a `{ key: value }` map) for personalization tags beyond the standard set. Set `skip_if_in_campaign:true` to dedupe. Returns the created lead. Use this for per-row enrollment.
- `instantly.bulkAddLeads` — add MANY leads in one call (`leads[]`, each `{ email, first_name?, …, custom_variables? }`, + target `campaign` or `list_id`). Returns a **background-job handle** — poll `getBackgroundJob`. Use for bulk loads, not row-by-row.
- `instantly.searchCampaignsByContact` — find which campaigns an `email` is already in. Call before enrolling to avoid duplicates.
- `instantly.moveLeads` — move leads between campaigns/lists (source filter → `to_campaign_id`/`to_list_id`). Async job; poll `getBackgroundJob`.

### Read / update / delete leads
- `instantly.getLead` — full lead object by UUID (custom variables, status, campaign membership).
- `instantly.listLeads` — search/page leads (POST, complex filters: `campaign`, `list_id`, `search`). Returns `{ items[], next_starting_after }`.
- `instantly.updateLead` — patch a lead by UUID (name, company, `custom_variables`). Note: a new custom-variable key propagates to all leads in the campaign.
- `instantly.deleteLead` — delete a lead by UUID. Irreversible.

### Verify an email before sending
- `instantly.verifyEmail` — validate `email`. Returns `{ verification_status: pending|verified|invalid, catch_all, credits }`. **May be async** — if `pending`, poll `getEmailVerificationStatus`. 1 credit.
- `instantly.getEmailVerificationStatus` — resolve a pending verification by `email` (URL-encoded path). Returns final `{ verification_status, catch_all }`.

### Lead lists (static audiences, not campaigns)
- `instantly.createLeadList` — create a list (`name`). Returns UUID.
- `instantly.listLeadLists` — page lists `{ items[], next_starting_after }`.
- `instantly.getLeadList` / `instantly.updateLeadList` / `instantly.deleteLeadList` — get / rename / delete by UUID.

### Campaign lifecycle
- `instantly.listCampaigns` — page campaigns (`search` by name, cursor `starting_after`).
- `instantly.getCampaign` — one campaign by UUID.
- `instantly.createCampaign` — requires `name` + `campaign_schedule` (at least one named schedule with timing). Starts **paused** — call `activateCampaign` to launch. Optional `email_list`, `daily_limit`, `sequences`.
- `instantly.updateCampaign` — patch name/schedule/`daily_limit`/`sequences` by UUID.
- `instantly.activateCampaign` — start/resume sending (UUID in path, no body).
- `instantly.pauseCampaign` — stop sending (UUID in path, no body).
- `instantly.deleteCampaign` — delete by UUID. Irreversible.

### Campaign analytics (read performance into columns)
- `instantly.campaignAnalytics` — totals (sent/opens/clicks/replies/bounces). Omit `id` for all campaigns. Optional `start_date`/`end_date` (YYYY-MM-DD).
- `instantly.campaignAnalyticsDaily` — day-by-day time series. Optional `campaign_id`.
- `instantly.campaignAnalyticsSteps` — per-sequence-step performance. Set `include_opportunities_count` for opportunities per step.

### Sending accounts (inbox infrastructure)
- `instantly.listAccounts` — page connected sender accounts (`search` by domain).
- `instantly.getAccount` — one account by **email** (path), with warmup/health.
- `instantly.createAccount` — connect via IMAP/SMTP (`email`, `first_name`, `last_name`, `provider_code` + IMAP/SMTP creds).
- `instantly.updateAccount` — patch by email (`daily_limit`, name).
- `instantly.deleteAccount` — disconnect by email. Irreversible.
- `instantly.pauseAccount` / `instantly.resumeAccount` — pause/resume sending from an account (email in path, no body).
- `instantly.warmupAnalytics` — warmup deliverability for `emails[]` (inbox/spam placement). Optional date range.

### Inbox / unibox (replies)
- `instantly.listEmails` — list/search sent + received emails. Filter `campaign_id`, `eaccount`, `lead`, `is_unread`, `email_type`. Cursor-paginated.
- `instantly.getEmail` — one email by UUID (body, `thread_id`, lead/account).
- `instantly.replyToEmail` — reply in a thread: `reply_to_uuid` (an email id), `eaccount` (sender), `subject`, `body` `{ html, text }`. Returns the sent email.
- `instantly.countUnreadEmails` — `{ count }` of unread in the unibox.
- `instantly.markThreadAsRead` — mark a thread read by `thread_id` (no body).

### Background jobs (async bulk ops)
- `instantly.listBackgroundJobs` — list jobs (`status`, `type`).
- `instantly.getBackgroundJob` — poll one job by UUID for `{ status, progress, ... }`. Required after `bulkAddLeads` / `moveLeads`.

## Recipes

1. **Verify, then enroll one grid row into a campaign**
   1. `instantly.verifyEmail` with `email: {{Email}}`.
   2. If `verification_status` is `pending`, `instantly.getEmailVerificationStatus` with the same email until `verified`/`invalid`.
   3. Only if `verified`: `instantly.createLead` with `email: {{Email}}`, `first_name: {{First Name}}`, `last_name: {{Last Name}}`, `company_name: {{Company}}`, `campaign: <campaign UUID>`, `skip_if_in_campaign: true`.

2. **Bulk-load a list of leads into a campaign**
   1. `instantly.bulkAddLeads` with `leads: [{ email, first_name, ... }, ...]`, `campaign: <UUID>`, `skip_if_in_campaign: true` → returns a job handle.
   2. Poll `instantly.getBackgroundJob` with that job UUID until `status` = `success`.

3. **Pull reply/open stats for a campaign into a column**
   1. `instantly.campaignAnalytics` with `id: <campaign UUID>` (add `start_date`/`end_date` to window it) → read `replies`, `opens`, `bounces`.

4. **Skip rows already in the campaign**
   1. `instantly.searchCampaignsByContact` with `email: {{Email}}`.
   2. If the target campaign UUID is in the returned list, skip; otherwise `instantly.createLead`.

## Gotchas
- **`campaign`, not `campaign_id`** on `createLead` — using `campaign_id` silently fails to enroll. (Note: `listEmails`/`campaignAnalyticsDaily` DO use `campaign_id`/`campaign_id` filters — fields differ by endpoint.)
- **Campaigns start paused.** `createCampaign` does not send until you call `activateCampaign`.
- **`createCampaign` requires `campaign_schedule`** with at least one named schedule and timing — a name alone 400s.
- **Async polling required** for `bulkAddLeads`, `moveLeads` (background jobs) and sometimes `verifyEmail` (pending). Don't treat their first response as final.
- **Account endpoints key on email, not UUID** — `getAccount`/`updateAccount`/`deleteAccount`/`pauseAccount`/`resumeAccount` take the sender email in the path.
- **Pagination:** list endpoints return `next_starting_after`; feed it back as `starting_after` to get the next page (max 100/page). Loop until it's absent.
- **`listLeads` is POST**, not GET (complex filters). Don't expect a query-string GET.
- **Verification credits are real spend** — `verifyEmail` consumes Instantly verification credits; gate it behind a real need, don't verify every row blindly.
- **V2 key only** — a V1 API key returns auth errors against this base URL; V2 access requires the Growth plan or above.
