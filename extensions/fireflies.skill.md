# Fireflies — Agent Skill
> Pull meeting transcripts, AI summaries, action items, and speaker analytics from Fireflies.ai — the right tool when a grid column needs data extracted from recorded sales/customer calls.

## When to use
- Use when a column needs anything from a meeting recording: full transcript text, AI summary/overview, action items, keywords, attendees, speaker talk-time, or sentiment/question filters.
- Use to list recent meetings (by date range, participant, keyword, or channel) and then drill into one transcript by id.
- Use AskFred to ask a natural-language question about a specific transcript (needs AI credits).
- Do NOT use for finding/verifying emails, enriching people/companies, or CRM data — that's LeadMagic/Trigify. Fireflies only knows about meetings it recorded for your workspace.

## Auth & cost
- **Base URL:** `https://api.fireflies.ai` — every call is `POST /graphql`. There is ONE endpoint; you select behavior by the GraphQL `query` string, not by path.
- **Auth:** `Authorization: Bearer <apiKey>` (manifest sets the `Authorization` header from the `apiKey` secret). Key from app.fireflies.ai/integrations/custom/fireflies.
- **Manifest method:** `fireflies.graphql` — pass `{ query, variables }`. 1 credit per call.
- **Rate limits:** Free 50 req/day · Pro 500 req/day · Business/Enterprise 60 req/min. Special: `addToLiveMeeting` 3 per 20 min; `shareMeeting` 10/hour (≤50 emails each). AskFred and `uploadAudio` transcription consume Fireflies AI credits separately.

## Connector-level rateLimit & picker fields
- **rateLimit (manifest):** `{ "rpm": 60, "concurrency": 2 }` — set to the documented Business/Enterprise sustained limit (60 req/min). This is the safe ceiling across plans; Free/Pro are daily caps (50/day, 500/day) which the engine can't model per-minute, so the per-minute Business limit is used and the daily cap is enforced by the API (watch for `too_many_requests` in `errors[]`). The per-operation specials (`addToLiveMeeting`, `shareMeeting`) live inside the GraphQL query, not as separate manifest methods, so they can't carry per-method overrides here.
- **No picker fields.** This is a single-method GraphQL passthrough. The only inputs are `query` (free-form GraphQL string) and `variables` (free-form object). Selecting a transcript/channel/user/host id happens *inside* the GraphQL query the caller authors — there is no discrete manifest field that takes an enumerable id/email — so there is nothing to wire `options` to. To discover ids at author time, run the `transcripts`, `channels`, or `users` GraphQL operations first (see "List / find meetings" above) and paste the id into your `variables`.

## Endpoints by job
There is one manifest method — `fireflies.graphql` — and you steer it with the GraphQL operation. Pick the operation below; pass it as `query` plus `variables`.

**List / find meetings**
- `transcripts` (query) — list meetings. Args: `limit` (max **50**), `skip`, `fromDate`, `toDate`, `keyword`, `mine`, `host_email`, `user_id`, `organizers[]`, `participants[]`, `channel_id`. Returns array of `{ id, title, date, duration, transcript_url, audio_url, video_url }`. This is how you get a transcript `id`.
- `user` (query) — current account: `name, email, user_id, integrations, num_transcripts, minutes_consumed, is_calendar_in_sync`.
- `users` (query) — team members: array of `{ user_id, name, email }`.

**Read one meeting**
- `transcript` (query) — one meeting by `id` (String!). Returns `title, date, duration, host_email, participants, meeting_attendees{ name email }` plus:
  - `summary { overview action_items keywords bullet_gist shorthand_bullet outline gist short_summary meeting_type topics_discussed }`
  - `sentences { index text speaker_name speaker_id start_time end_time ai_filters{ task pricing metric question sentiment } }`
  - `speakers { id name duration word_count words_per_minute longest_monologue filler_words questions }`

**Soundbites / clips**
- `bites` (query) — soundbites for a transcript. Args: `transcript_id, limit, skip`. Returns clips with timestamps.
- `bite` (query) — single soundbite by `id`.
- `createBite` (mutation) — make a clip. Args: `transcript_id, start, end, title`.

**AskFred (AI Q&A over a transcript — needs AI credits)**
- `createAskFredThread` (mutation) — ask a question. Args: `query, transcript_id, filters, response_language, format_mode`. Returns answer + suggestions.
- `continueAskFredThread` (mutation) — follow-up. Args: `thread_id, query`.
- `askfred_threads` / `askfred_thread` (queries) — list / fetch threads.

**Manage meetings (mutations — write/destructive)**
- `uploadAudio` — transcribe a hosted audio/video URL. Args: `audio_url, title, language, client_reference_id, bypass_size_check`. Audio ≤200MB; video ≤100MB free / ≤1.5GB paid.
- `addToLiveMeeting` — send the bot into a live call. Args: `meeting_link, title, meeting_password, duration, language, attendees`. (3 per 20 min.)
- `updateMeetingTitle` — `{ transcript_id, title }`.
- `updateMeetingPrivacy` — `{ transcript_id, privacy_level }`.
- `updateMeetingChannel` — `{ transcript_ids[] (≤5), channel_id }`.
- `shareMeeting` / `revokeSharedMeetingAccess` — share by `emails[]` / revoke by `email`.
- `deleteTranscript` — `{ transcript_id }` (10/min). Destructive.
- `setUserRole` — `{ user_id, role }`.

**Channels & analytics**
- `channels` / `channel` (queries) — accessible channels.
- `analytics` (query) — team/user meeting metrics.

## Recipes
1. **Get a meeting's action items by title keyword**
   1. `fireflies.graphql` with `{ "query": "query($k:String,$l:Int){ transcripts(keyword:$k, limit:$l){ id title date } }", "variables": { "k": "{{Account Name}}", "l": 5 } }` → grab the right `id`.
   2. `fireflies.graphql` with `{ "query": "query($id:String!){ transcript(id:$id){ title summary{ overview action_items keywords } } }", "variables": { "id": "<id from step 1>" } }`.

2. **Most recent call for a participant → full summary**
   1. `fireflies.graphql` with `{ "query": "query($p:[String],$l:Int){ transcripts(participants:$p, limit:$l){ id title date } }", "variables": { "p": ["{{Contact Email}}"], "l": 1 } }`.
   2. Feed `id` into the `transcript` query (recipe 1, step 2) for `summary` + `sentences`.

3. **Pull speaker talk-time / sentiment for a known transcript id**
   - `fireflies.graphql` with `{ "query": "query($id:String!){ transcript(id:$id){ speakers{ name duration words_per_minute questions } sentences{ speaker_name ai_filters{ sentiment question } } } }", "variables": { "id": "{{Transcript ID}}" } }`.

4. **Ask a question about a call (AskFred)**
   - `fireflies.graphql` with `{ "query": "mutation($id:String!,$q:String!){ createAskFredThread(transcript_id:$id, query:$q){ id message } }", "variables": { "id": "{{Transcript ID}}", "q": "What were the customer's objections?" } }`. (Consumes AI credits.)

## Gotchas
- **One endpoint, query-driven.** Don't look for REST routes — there are none. Everything is `POST /graphql` with a `query`; switch operations by editing the query string, not the path.
- **Errors come back on HTTP 200.** Check the top-level `errors[]` array (`{ message, code, extensions.status }`) even when the request "succeeds". Common codes: `auth_failed`, `too_many_requests`, `invalid_language_code`, `require_ai_credits`.
- **Pagination:** `transcripts` caps at **50** per call — page with `skip` (50, 100, …). For a single record always use `transcript(id:)`, not a filtered `transcripts`.
- **`id` is a `String!`**, not an Int — pass it as a string variable. You must list `transcripts` first to discover ids; there is no lookup by meeting URL.
- **Summary/AI fields may be null** while a meeting is still processing (`is_live: true`) or if AI summaries are off for the workspace. Request only the subfields you need — over-selecting large `sentences` arrays bloats responses.
- **AskFred and transcription cost AI credits** separately from the API rate limit — a `require_ai_credits` error means top-up, not rate-limit backoff.
- **Mutations are real writes.** `deleteTranscript`, `updateMeetingPrivacy`, `shareMeeting` change/expose workspace data — only run when explicitly asked; for read-only enrichment columns stick to queries.
- Docs: https://docs.fireflies.ai (full schema dump at https://docs.fireflies.ai/llms-full.txt).
