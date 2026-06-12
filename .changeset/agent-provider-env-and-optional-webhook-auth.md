---
"@gtmgrid/server": patch
"@gtmgrid/services": patch
---

Agent sessions can now use your saved provider keys, and webhook signature
auth is opt-in:

- Provider CLIs and skills the agent runs (trigify-cli, gh, …) authenticate
  automatically: saved credentials are injected as conventional env vars
  (`TRIGIFY_API_KEY`, `GITHUB_TOKEN`, …) at agent spawn — cloud workspace
  credentials in cloud mode, the local credential store in local mode. An
  explicitly exported env var still wins, and values never appear in args
  or logs.
- Inbound webhooks no longer force HMAC signing: new webhooks accept
  unsigned posts (the unguessable token URL is the credential), with a
  "Require signed requests" toggle to opt in to `X-GTMGrid-Signature`
  verification. Existing webhooks keep their secrets and behave as before.
