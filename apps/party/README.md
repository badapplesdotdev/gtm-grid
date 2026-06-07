# `@gtmgrid/party` — server-gated PartyKit realtime

The live grid + presence provider (TRI-3261) that replaced Supabase Realtime. One
room per workspace+table (`${workspaceId}:${tableId}`); `src/server.ts` is the
`grid` party (see `partykit.json`). It:

1. **Authorizes** each socket in `onBeforeConnect` — verifies the `?token=`
   (HS256, `PARTY_AUTH_SECRET`) and rejects (401) unless the token's `workspaceId`
   matches the room and it is unexpired. The decision is the pure
   `authorizeGridConnection` from `@gtmgrid/auth/party-token`.
2. **Server-publishes** grid changes in `onRequest` — requires
   `Authorization: Bearer PARTY_PUBLISH_SECRET`, then broadcasts the posted
   `GridChangeEvent` to connected clients.
3. Broadcasts **presence** on join/leave.

The wire protocol, event schema, reducer, and client subscriber
(`subscribeToGrid`) live in `@gtmgrid/services/realtime`. See
[`docs/cloud.md`](../../docs/cloud.md) for the full architecture and
[`docs/local-dev.md`](../../docs/local-dev.md) for local bring-up.

## Local dev

```bash
PARTY_AUTH_SECRET=<same as apps/web> \
PARTY_PUBLISH_SECRET=<same as apps/web> \
  pnpm -F @gtmgrid/party dev      # partykit dev on http://127.0.0.1:1999
```

The two secrets MUST match the values on `apps/web` (it mints the connection
token with `PARTY_AUTH_SECRET` and server-publishes with `PARTY_PUBLISH_SECRET`).

## Production deploy (Cloudflare via PartyKit)

This party is **not** auto-deployed. Deploy it explicitly:

```bash
pnpm -F @gtmgrid/party deploy      # = partykit deploy
```

`partykit deploy` uploads `src/server.ts` (the `grid` party) to Cloudflare and
prints the party **host URL** (e.g.
`https://gtmgrid-party.<account>.partykit.dev`). That host URL becomes
`PARTY_URL` on `apps/web` and `VITE_PARTY_URL` on the desktop build.

### Prod env wiring (secrets must MATCH both sides)

Set the party-side secrets on the deployment (PartyKit dashboard or
`partykit env add <NAME>` from this package):

| Variable | Set on | Purpose |
| --- | --- | --- |
| `PARTY_AUTH_SECRET` | this party **and** `apps/web` | verify (party) vs. mint (web) the connection token — same HS256 secret |
| `PARTY_PUBLISH_SECRET` | this party **and** `apps/web` | check (party) vs. send (web) the server-publish bearer — same value |
| `PARTY_URL` | `apps/web` | the deployed party host URL (server-publish target) |
| `VITE_PARTY_URL` | desktop build | the SAME deployed party host URL (subscriber target) |

Fail-closed by design: an unset `PARTY_AUTH_SECRET` on the party rejects every
connection (503/401); an unset `PARTY_URL`/`PARTY_PUBLISH_SECRET` on `apps/web`
degrades the publisher to a no-op (writes still succeed, no live fan-out).

> Do NOT run `partykit deploy` from CI without the Cloudflare/PartyKit token
> configured — it is an explicit, credentialed operation.
