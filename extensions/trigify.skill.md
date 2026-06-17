# Trigify — Agent Skill
> Agentic social-listening & GTM intelligence: Boolean keyword monitoring across LinkedIn, X/Twitter, Reddit, YouTube, podcasts, Substack, Bluesky, HN, GitHub & news — plus LinkedIn/company enrichment, post-engager capture, social signals, X actions, and workflow automation. The right tool when a grid column needs prospects sourced from social activity or LinkedIn profiles/companies enriched.

## When to use
- Source prospects from social activity: who posted about a topic (the `create*Search` family) or who liked/commented on a specific post or competitor (`postEngagements`, `postComments`, `profileEngagementBulk`).
- Enrich a LinkedIn profile or company URL into structured fields — name, title, company, headcount, etc. (`enrichProfile`, `enrichCompany`), or an X handle (`enrichXUser`, `lookupXUser`).
- Stand up always-on monitoring: saved keyword/profile searches per platform, social-signal subscriptions, or topic searches that dedupe engagers across posts.
- Run GTM automation inside Trigify (triggers → filters → actions to CRM/Slack/outreach) and take X actions (post, reply, follow, DM).
- Do NOT use for: meeting/call data (Fireflies), generic email finding/verification (LeadMagic), or B2C networks — Trigify covers no Instagram/TikTok-consumer/Facebook audience graph.

## Auth & cost
- **Base URL:** `https://api.trigify.io`. Auth is the **`x-api-key`** header (the manifest injects it from the secret) — there is no Bearer token.
- **Rate limit:** documented at **100 requests / 60s window** (429 = back off and retry). Manifest sets a connector-level `rateLimit` of `{ rpm: 100, concurrency: 3 }`. Credit-burning / live-write endpoints carry a stricter per-method override: enrichment + engager pulls (`enrichProfile`, `enrichCompany`, `enrichXUser`, `lookupXUser`, `postEngagements`, `xPostEngagements`, `xPostComments`, `getTopicEngagements`, `getTopicPostEngagements`, `profileEngagementResults`, `profilePostEngagementResults`, `socialMapping`) at `rps: 2`; X write actions (`xCreatePost`, `xReply`, `xRepost`, `xLikePost`, `xFollow`, `xSendDm`, `xDeletePost`) at `rps: 1`.

## Picker fields (live `options`)
The manifest wires `options` on every field that takes an id another endpoint can enumerate, so the grid renders a name-picker and stores the id:
- **Search id** (`getSearch`/`updateSearch`/`deleteSearch`/`searchResults`, plus `createWorkflow.search_id`) → `listSearches` (`data[]`, label `name`, value `id`, sublabel `status`).
- **Workflow id** (`getWorkflow`/`updateWorkflow`/`deleteWorkflow`/`*WorkflowDraft`/`testWorkflow`/`listWorkflowExecutions`/`getWorkflowExecution`) → `listWorkflows` (`items[]`, label `name`, value `id`, sublabel `status`).
- **Topic id** (`getTopic`/`updateTopic`/`deleteTopic`/`getTopicCreditsSummary`/`getTopicEngagements`/`getTopicPostEngagements`) → `listTopics`.
- **Social-signal subscription id** (`getSocialSignalSubscription`/`updateSocialSignalSubscription`/`stopSocialSignalSubscription`) → `listSocialSignalSubscriptions`; **target id** (`getSocialSignalTargetProfile`/`listSocialSignalTargetInsights`/`listSocialSignalTargetCheckRuns`) → `listSocialSignalTargets`.
- **X `account_id`** (all `x*` write actions) → `listXAccounts` (label `username`, value `id`).
- **Integration sub-resources:** `getNotionSchema.database_id` → `listNotionDatabases`; `listAirtableTables.base_id` → `listAirtableBases`; `listLinearStates.team_id` / `listLinearUsers.team_id` → `listLinearTeams` (`teams[]`); `listGoogleSheetsSheets.document_id` → `listGoogleSheetsDocuments`.
- Not wired (no enumerable list endpoint on this connector): URL/handle/keyword/post-URN inputs, `listCampaigns.type` and `integrationHealth.type` (fixed enums), and grandchild ids that need a parent id first (Airtable `table_id` fields, Sheets `sheet_id`, Notion page properties).
- **Credits:** Trigify is credit-metered (1 credit ≈ 1 post monitored or 1 workflow/enrichment action). Enrichment, engager pulls, and signal subscriptions burn credits per row — estimate first with `estimateSocialSignals` / `getTopicCreditsSummary`, and watch the balance with `creditsBalance`.
- **Most common entry points:** `trigify.enrichProfile` (LinkedIn → fields), `trigify.postEngagements` (post URL → likers), and the per-platform `trigify.create*Search` + `trigify.searchResults` (async monitor → results).

## Endpoints by job

**Enrich a person / company**
- `trigify.enrichProfile` — LinkedIn profile URL → name, title, company, location, email. The workhorse enrichment column.
- `trigify.enrichCompany` — LinkedIn company URL/domain → firmographics (size, industry, description).
- `trigify.profilePosts` — recent posts authored by a LinkedIn profile.
- `trigify.companyPosts` / `trigify.companyComments` — a company page's posts and the comments on them.
- `trigify.enrichXUser` / `trigify.lookupXUser` — X user object by id or by username.

**Capture post engagers & commenters**
- `trigify.postByUrl` — resolve any post URL into Trigify's post object/id (start here when you only have a URL).
- `trigify.postEngagements` — everyone who liked/reacted to a LinkedIn post. Key input: post URL/id. Returns engager profiles.
- `trigify.postComments` + `trigify.postCommentReplies` — commenters and nested replies on a post.
- `trigify.xPostEngagements` (likes) / `trigify.xPostComments` — the X/Twitter equivalents.
- `trigify.socialMapping` — engagement-graph mapping across a set of posts/profiles (who-engages-whom).

**Track profiles for ongoing engagement (engagement monitor)**
- `trigify.profileEngagementBulk` — bulk-register profiles to continuously capture their engagers.
- `trigify.profileEngagementResults` / `trigify.profilePostEngagementResults` — pull captured engagers (overall vs per-post).
- `trigify.profileEngagementRemove` — stop tracking a profile.

**Create a saved search per platform (async)**
- Posts/keywords: `trigify.createLinkedInPostsSearch`, `createTwitterPostsSearch`, `createRedditPostsSearch`, `createSubredditPostsSearch`, `createYouTubeVideosSearch`, `createSubstackPostsSearch`, `createSubstackNotesSearch`, `createPodcastKeywordsSearch`, `createHackerNewsStoriesSearch`, `createNewsApiAiPostsSearch`, `createDailyDevPostsSearch`, `createGitHubIssuesSearch`, `createGitHubDiscussionsSearch`, `createBlueskyPostsSearch`.
- Profile/channel monitors: `trigify.createLinkedInProfileSearch`, `createTwitterProfileSearch`, `createYouTubeChannelSearch`, `createSubstackProfileSearch`, `createBlueskyProfileSearch`, `createPodcastEpisodesSearch`.
- Each takes Boolean keywords/handles and returns a search `id`; results populate asynchronously.

**Read / manage searches & their results**
- `trigify.searchResults` — poll results for a search `id` (the post/profile rows). Paginated.
- `trigify.listSearches`, `getSearch`, `updateSearch`, `deleteSearch` — manage saved searches.
- `trigify.searchPodcasts` — ad-hoc podcast lookup feeding `createPodcastEpisodesSearch`.

**Topic searches (deduplicated engager pipelines)**
- `trigify.createTopic` + `listTopics` / `getTopic` / `updateTopic` / `deleteTopic` — a topic aggregates many posts.
- `trigify.getTopicEngagements` — engagers across the whole topic, deduplicated; `getTopicPostEngagements` for a single post within it.
- `trigify.getTopicCreditsSummary` — credit cost preview before pulling engagers.

**Social signals & subscriptions**
- `trigify.createSocialSignalSubscriptions` + `listSocialSignalSubscriptions` / `getSocialSignalSubscription` / `updateSocialSignalSubscription` / `stopSocialSignalSubscription` / `bulkStopSocialSignalSubscriptions` — manage signal subs.
- `trigify.estimateSocialSignals` — credit estimate before subscribing. `socialSignalsMetadata` / `socialSignalsLimits` / `socialSignalsStatus` for config & quota.
- Targets & feed: `trigify.listSocialSignalTargets`, `getSocialSignalTargetProfile`, `listSocialSignalTargetInsights`, `listSocialSignalTargetCheckRuns`, `listSocialSignalFeed`, `listSocialSignalResults`, `getSocialSignalResult`.

**X / Twitter actions**
- Read: `trigify.listXAccounts`, `getXConnect` (connect URL).
- Write (consume an action + a connected account): `trigify.xCreatePost`, `xReply`, `xRepost`, `xLikePost`, `xFollow`, `xSendDm`, `xDeletePost`. Real actions on a live account — only when explicitly asked.

**Workflows (triggers → filters → actions)**
- Build/manage: `trigify.createWorkflow`, `listWorkflows`, `getWorkflow`, `updateWorkflow`, `deleteWorkflow`; drafts via `upsertWorkflowDraft` / `getWorkflowDraft` / `deleteWorkflowDraft`.
- Discover the building blocks: `trigify.listWorkflowTriggers`, `listWorkflowActions`, `listWorkflowExamples`.
- Tables & runs: `trigify.createWorkflowTable` / `listWorkflowTables`; `testWorkflow`, `listWorkflowExecutions`, `getWorkflowExecution`.

**Integrations lookups (resolve config ids before wiring actions)**
- `trigify.listIntegrations`, `integrationHealth`.
- CRM/outreach: `getCrmFields`, `getCrmFieldOptions`, `listCampaigns` (Instantly/Smartlead/HeyReach), `listAudiences` (LaGrowthMachine).
- Slack: `listSlackChannels`, `listSlackUsers`. Linear: `listLinearTeams`, `listLinearUsers`, `listLinearStates`.
- Notion: `listNotionDatabases`, `getNotionSchema`. Airtable: `listAirtableBases`, `listAirtableTables`, `getAirtableFields`. Sheets: `listGoogleSheetsDocuments`, `listGoogleSheetsSheets`, `getGoogleSheetsColumns`.

**Credits, usage & org**
- `trigify.creditsBalance`, `creditsUsage`, `creditsBreakdown`, `getUsage` — balance, history, and per-feature breakdown.
- `trigify.getOrganisation`, `listOrganisations` — current org context.

## Recipes
1. **Source people posting about a topic, then enrich**
   1. `trigify.createLinkedInPostsSearch` with Boolean keywords for the topic → returns a search `id` (results populate asynchronously).
   2. Poll `trigify.searchResults` with `{ "id": "{{Search ID}}" }` → posters; `add_rows` with each LinkedIn URL.
   3. `trigify.enrichProfile` with `{ "url": "{{LinkedIn URL}}" }` → name, title, company, email per row.

2. **Capture everyone who engaged with a competitor's post**
   1. `trigify.postByUrl` with `{ "url": "{{Post URL}}" }` → post id.
   2. `trigify.postEngagements` (likers) and `trigify.postComments` (commenters) on that post → engager rows.
   3. `add_rows`, then `trigify.enrichProfile` on each `{{LinkedIn URL}}` to qualify them.

3. **Stand up a keyword monitor and pull results**
   1. `trigify.createLinkedInPostsSearch` with Boolean `{ "keywords": "{{Keywords}}" }` → returns search `id` (async).
   2. Poll `trigify.searchResults` with `{ "id": "{{Search ID}}" }` until rows appear (paginate).
   3. Fan out: `add_rows` the authors, then `trigify.enrichProfile` per `{{LinkedIn URL}}`.

4. **Continuously track competitor accounts' engagers**
   1. `trigify.profileEngagementBulk` with the list of profile URLs to monitor.
   2. Later, `trigify.profileEngagementResults` → captured engagers; `add_rows` + `trigify.enrichProfile`.
   3. Optionally `trigify.estimateSocialSignals` then `createSocialSignalSubscriptions` for richer signal alerts.

## Gotchas
- **Huge surface (123 methods).** Don't scan blindly — use `search_functions` / `list_functions` scoped to `trigify` to find the exact id before calling, and confirm inputs.
- **Manifest ids ≠ MCP tool names.** Call the camelCase manifest ids (`enrichProfile`, `postEngagements`, `createLinkedInPostsSearch`) — not the `mcp__trigify__*` snake_case variants.
- **Searches are async (create → poll).** `create*Search` returns an `id` immediately but results populate over time. Loop on `searchResults` (and topic/signal `list*Results`) and paginate; an empty first poll is normal, not an error.
- **Auth is `x-api-key`, not Bearer.** A 401 means a missing/wrong API key header, not a token-refresh issue.
- **Credit-heavy methods:** `enrichProfile`/`enrichCompany`, engager pulls (`postEngagements`, `getTopicEngagements`, `profileEngagementResults`), and signal subs charge per row/post. Run `estimateSocialSignals` / `getTopicCreditsSummary` and check `creditsBalance` before large fan-outs.
- **X actions are real writes.** `xCreatePost`, `xReply`, `xFollow`, `xSendDm`, `xDeletePost` act on a live connected account (`listXAccounts` to confirm one exists) — only fire when explicitly instructed.
- **Resolve integration ids first.** Before workflow actions that write to CRM/Slack/Notion/Airtable/Sheets, call the matching `list*`/`get*Fields` lookup to get valid channel/field/database ids, and `integrationHealth` to confirm the connection is live.
