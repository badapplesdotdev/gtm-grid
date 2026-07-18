---
"@gtmgrid/services": minor
"@gtmgrid/engine": minor
"@gtmgrid/desktop": minor
---

Slack integration via a provider-agnostic OAuth adapter.

Extracts the OAuth protocol mechanics out of the ~95% byte-identical
`attio-auth.ts`/`hubspot-auth.ts` pair into a shared core, and models each
provider's token lifecycle as DATA (`RefreshPolicy`) rather than as doc comments
every consumer had to read and hand-honour. Attio and HubSpot are now specs over
that core with their behaviour unchanged (their tests pass untouched).

Adds Slack as the first OAuth-authed grid connector: `extensions/slack.json`
(postMessage, listChannels, lookupUserByEmail, getUserInfo) reaching the engine
through a new `oauth` arm on the connector manifest's auth schema. Token rotation
is enabled and refreshed server-side under a non-blocking advisory lock — Slack's
refresh tokens are single-use, so concurrent column runs would otherwise revoke
each other's live token mid-run.

Also adds a Slack Events receiver that converges on the existing inbound-webhook
Inngest event.
