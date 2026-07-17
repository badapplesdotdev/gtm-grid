# Slack

Slack is a **connector**, not a CRM: the engine calls it from a column. It has no
sync bindings, no sources, and no API key beside the OAuth grant — the grant *is*
the whole credential.

## How it fits together

| Piece | Where |
|---|---|
| Protocol (state, authorize URL, token exchange/refresh) | `packages/services/src/oauth/oauth-core.ts` — shared by Attio, HubSpot, Slack |
| Slack's spec (scopes, URLs, `RefreshPolicy`, `parseTokens`) | `packages/services/src/services/slack-auth.ts` |
| Token storage | `packages/services/src/services/slack-connection-service.ts` — slot `"slack"` |
| Refresh for a run | `packages/services/src/services/oauth-credential-service.ts` → `/api/worker/getCredential` |
| Connect flow (web) | `apps/web/app/api/oauth/slack/{authorize,callback}` |
| Connect flow (desktop) | `packages/desktop/src/cloud/OAuthConnectCard.tsx` |
| Columns | `extensions/slack.json` |
| Inbound events | `apps/web/app/api/webhooks/slack/[token]` |

Two constraints worth knowing before changing anything:

- **The credential slot is bare `"slack"`, not `"slack-crm"`.** The engine resolves
  a connector's credential *by connector id*, so the slot must equal the manifest
  id or every `sdk.slack.*` call reports "not connected". (The CRM slots are
  suffixed because the engine *also* has apiKey connectors named `attio`/`hubspot`.)
- **`conversations.history` / `replies` are deliberately absent.** Non-Marketplace
  apps are capped at 1 req/min with a 15-object limit
  ([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)) —
  ~900 messages/hour, unusable for a grid column. Adding them needs Marketplace
  approval first.

## Environment

Cloud sets these to the GTM Grid Slack app; a self-hosted instance points them at
its own app. Same shape as `ATTIO_CLIENT_ID` — there is no separate BYO code path.

```
SLACK_CLIENT_ID=          # OAuth & Permissions → App Credentials
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=     # Basic Information → App Credentials (inbound events only)
SLACK_OAUTH_SECRET=       # optional; falls back to BETTER_AUTH_SECRET
```

Unset `SLACK_CLIENT_ID` is a supported state: the Tools panel shows a disabled
Connect button and says Slack isn't set up, rather than opening a broken consent
screen.

Redirect URL to register: `https://<your-host>/api/oauth/slack/callback`. It is
sent explicitly on both the authorize and token calls, because Slack silently
routes to the *first* configured redirect URL when the param is absent and several
are registered.

## Token rotation

Rotation is **ON** (`RefreshPolicy.Rotating`, 30-min skew). Slack's refresh tokens
are **single-use**, with at most two live at once, so two concurrent column runs
refreshing the same connection would revoke each other's token mid-run.

Refresh therefore happens **server-side only**, in one place
(`/api/worker/getCredential`), under a non-blocking `pg_try_advisory_xact_lock`.
The engine never holds a `client_secret` and never rotates. A run that loses the
lock uses its stored token, which is still valid for the whole skew window — the
skew *is* the grace period.

Rotation is **irreversible** once enabled on a Slack app. Do not enable it on an
app whose tokens something else depends on.

## Inbound events: the tenant gate, and a hard limit

A valid Slack signature is **not an authorisation decision.** The signing secret
and the Events Request URL are **app-global, not per-installation** — every
workspace that installs the app posts to the same URL, all validly signed. A v0
signature proves "Slack sent this on behalf of this app"; it says nothing about
*which* workspace.

The receiver therefore compares the event's `team` against the team the
webhook's workspace is connected to (`/api/worker/slackTeam`) and drops
mismatches with an ACK. Without it, anyone who installs the app into their own
Slack workspace has their messages inserted as rows into whichever tenant's
webhook the URL names — and with auto-run, enriched at that tenant's expense.

**The limit this exposes:** Slack allows **one Request URL per app**, set by the
app's owner. So `/api/webhooks/slack/<token>` only works where the customer owns
the app — i.e. **self-host / BYO**. On the shared cloud app the owner is us, so a
single tenant's token would be baked into the URL and every other tenant's events
would now (correctly) be dropped by the tenant gate. Cloud-wide inbound events
would need a **token-less** URL that routes by `team_id` → connection →
workspace. Not built; the gate makes the gap safe rather than silent.

## The manual verify gate

Everything below the consent screen is covered automatically (`pnpm test`,
`pnpm -F @gtmgrid/desktop e2e`). These are the claims that **only a real Slack
workspace can settle** — do them before shipping, and after any change to
`slack-auth.ts` or `oauth-credential-service.ts`.

1. **Connect.** Tools → Slack → Connect. Consent lands back in the app and the
   card shows `Connected · <your team>`.
2. **A column posts.** Add a `slack.postMessage` column; the channel picker should
   populate from `conversations.list`. Run it — the message appears in Slack and
   the cell reaches `done`.
3. **Rotation, against real Slack.** The single most important manual check:
   automated tests use a mock that returns whatever we tell it, so nothing else
   proves Slack's *actual* single-use semantics.
   - In the DB, set the connection's `expiresAtMs` to a past value.
   - Run a Slack column. It must succeed (a refresh happened), and the stored
     `refreshToken` must have changed.
   - **The OLD refresh token must now be dead.** Replay it by hand against
     `oauth.v2.access` — Slack should refuse it. If it still works, our
     understanding of rotation is wrong and the lock's rationale needs revisiting.
4. **Concurrent refresh, real multi-connection Postgres.** `credential-repo-lock.pg.test.ts`
   proves the lock SQL is real and releases at commit, but PGlite is
   single-connection and advisory locks are re-entrant within a session — so it
   *cannot* prove mutual exclusion. Against a real Postgres with two pooled
   connections: force an expired `expiresAtMs`, fire two column runs at once, and
   confirm **exactly one** refresh reaches Slack.
5. **Revocation.** Uninstall the app from Slack, then run a column: the cell error
   should say to reconnect, not leak a raw `invalid_auth`.
6. **Inbound events** (if the Events API is configured). Point Slack's Event
   Subscriptions at `/api/webhooks/slack/<token>`; saving it exercises the
   `url_verification` handshake. Post a message and confirm exactly one row lands
   — Slack retries reuse `event_id`, which is what our idempotency key is built
   from.
