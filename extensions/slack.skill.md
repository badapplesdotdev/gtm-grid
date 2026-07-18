# Slack — Agent Skill
> Post messages into Slack channels and resolve workspace people/channels — reach for it when a column needs to NOTIFY someone, or to turn an email address into a Slack user.

## When to use
- Use to notify a channel about a row (new lead, hot signal, finished enrichment) — `slack.postMessage`, usually behind an "only run if" condition so it fires on the rows that matter.
- Use to resolve a row's email into a Slack user id (`slack.lookupUserByEmail`) and then read that person's profile (`slack.getUserInfo`) — e.g. to @-mention the right owner in a message.
- Use to list channels (`slack.listChannels`) when you need a channel id, though the postMessage channel field already picks by name for you.
- Do NOT use to READ channel history or threads — those endpoints are deliberately not in this connector (see Gotchas).
- Do NOT use to find external people or verify emails — this is your own workspace's directory only (see leadmagic/apollo for enrichment).

## Auth & cost
- Auth: **OAuth**, not an API key (`auth.type: "oauth"`, `provider: "slack"`). You connect your Slack workspace; the grant mints an access token stored as the `accessToken` secret and sent as `Authorization: Bearer xoxb-…`. There is no key to paste — if a run errors with "Slack is not connected" or "authorization expired or was revoked", the fix is to **(re)connect the Slack account**, never to edit a key.
- Base URL: `https://slack.com/api`.
- Scopes needed: `chat:write` (postMessage), `channels:read` + `groups:read` (listChannels), `users:read` (getUserInfo), `users:read.email` (lookupUserByEmail). A missing scope comes back as `ok:false` with `error: "missing_scope"`.
- Credits: all calls are 0 credits (Slack's own API is free; your workspace's plan applies).
- Rate limits: Slack tiers each method, so each method carries its own explicit `rateLimit`:
  - `chat.postMessage` — ~1 message per second **per channel**, short bursts tolerated → `{ rps: 1, concurrency: 1 }`.
  - `conversations.list` — Tier 2, ~20+/min → `{ rpm: 20, concurrency: 2 }`.
  - `users.lookupByEmail` — Tier 3, ~50+/min → `{ rpm: 50, concurrency: 3 }`.
  - `users.info` — Tier 4, ~100+/min → `{ rpm: 100, concurrency: 5 }`.
  - Over-limit returns HTTP 429 with `Retry-After`; the engine backs off and retries.

## Picker fields (manifest options)
- `postMessage.channel` is a live picker backed by `listChannels` (`itemsPath: "channels"`, label `name`, value `id`, args `{ limit: 200, exclude_archived: true, types: "public_channel,private_channel" }`) — choose a channel by name and the grid stores the `C…` id. Everything else is free text (a `U…` user id, an email, a message `ts`).

## Endpoints by job

### Notify a channel
- `slack.postMessage` — `POST /chat.postMessage`. Required `channel` (C… id, picked by name) and `text`. Optional `thread_ts` (reply in a thread), `reply_broadcast`, `unfurl_links`, `mrkdwn`. Returns `{ ok, channel, ts, message }` — keep `ts` if you want to thread replies onto it later.

### Find channels
- `slack.listChannels` — `GET /conversations.list`. Optional `types` (comma-separated, default `public_channel`), `exclude_archived`, `limit` (keep ≤200), `cursor`. Returns `{ ok, channels: [{ id, name, is_private, is_archived, … }], response_metadata: { next_cursor } }`.

### Resolve people
- `slack.lookupUserByEmail` — `GET /users.lookupByEmail`. Required `email`. Returns `{ ok, user: { id, name, real_name, profile, … } }`. The `user.id` (`U…`) is what you mention as `<@U123ABC>`.
- `slack.getUserInfo` — `GET /users.info`. Required `user` (`U…`). Optional `include_locale`. Returns `{ ok, user: {…} }`.

## Recipes
1. **Alert a channel about a qualified row**
   1. call `slack.postMessage` with `{ "channel": <picked channel>, "text": "New lead: {{Name}} at {{Company}} — {{Email}}" }`; gate the column with an "only run if" condition so it only fires on qualified rows.
2. **@-mention the row's owner in the alert**
   1. call `slack.lookupUserByEmail` with `{ "email": "{{Owner Email}}" }`; read `user.id`.
   2. call `slack.postMessage` with `{ "channel": <picked channel>, "text": "<@" + <id from step 1> + "> owns {{Company}}" }`.
3. **Thread the follow-up under the first message**
   1. call `slack.postMessage` and store the returned `ts` in a column.
   2. call `slack.postMessage` again with `{ "channel": <same channel>, "thread_ts": "{{Message TS}}", "text": "Enrichment finished" }`.
4. **Enrich a row with the person's Slack profile**
   1. call `slack.lookupUserByEmail` with `{ "email": "{{Email}}" }`; take `user.id`.
   2. call `slack.getUserInfo` with `{ "user": <id from step 1> }`; read `user.profile.title` / `user.tz`.

## Gotchas
- **Slack returns HTTP 200 for failures.** This is the big one. Most Slack Web API errors come back as `200 OK` with a body of `{ "ok": false, "error": "channel_not_found" }`. Branching on the HTTP status (or on a fetch `res.ok`, which is the STATUS flag and has nothing to do with Slack's `ok` field — the collision is a genuine trap) will silently treat an error as a success and write a "successful" empty cell. **In column code, always check the response body's `ok` field yourself** and throw when it is false: e.g. `if (!r.ok) throw new Error(r.error)`. The engine's generic `httpCall` only maps non-2xx statuses, so it cannot catch these for you — a 401 (bad/revoked token) IS mapped to reconnect guidance, but `invalid_auth` delivered as `200 {ok:false}` is not.
- Common `error` values to expect in that body: `channel_not_found`, `not_in_channel` (invite the app to the channel first), `missing_scope`, `users_not_found`, `invalid_auth`, `ratelimited`.
- `postMessage` needs the app to be **a member of the channel** — a valid token is not enough. `not_in_channel` means "invite the app", not "bad credential".
- **No channel history here.** `conversations.history` and `conversations.replies` are deliberately omitted from this connector: since Slack's 2025-05-29 changelog, non-Marketplace apps are capped at **1 request/minute with a 15-object limit** on those endpoints — unusable as a grid column fanned across rows. Don't add them expecting them to work.
- `channel` must be the `C…` **id**, not `#general`. The picker handles this; if you hand-type a channel name it will fail with `channel_not_found`.
- `listChannels` is cursor-paginated: loop with `response_metadata.next_cursor` until it is empty. Keep `limit` ≤200 — Slack may time out on larger pages regardless of the documented max.
- `users.lookupByEmail` only finds users **in your workspace**. A miss is `ok:false` + `users_not_found` (a 200!), not an empty result.
- Per-channel posting is ~1/sec. Fanning `postMessage` across hundreds of rows into ONE channel will throttle — batch the rows into a single digest message where you can, rather than one message per row.
